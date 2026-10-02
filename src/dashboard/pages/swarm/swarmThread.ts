/** Pure derivation for the Swarm tab: server messages and the roster become
 * Discord-style channels, authors and stream items. Nothing here talks to the
 * backend or touches storage, so every view of the same state agrees. */

import {
  mapDecision,
  type SwarmDecision,
  type SwarmImportMessage,
  type SwarmManager,
  type SwarmMessage,
  type SwarmRoster,
  type SwarmUsage,
} from "../../../lib/swarmApi";

/** The sandbox thread as it sat in localStorage before the swarm moved server-side.
 * Kept only to flatten it into the one-time import. */
export type ThreadEntry =
  | { id: string; kind: "user"; text: string; target: string; targetId?: string; at?: number }
  | { id: string; kind: "result"; decisions: SwarmDecision[]; events: string[]; usage: SwarmUsage[]; at?: number };

export type ChannelId = "group" | "activity" | `m:${string}`;

export const DECISION_LABEL: Record<SwarmDecision["decision"], string> = {
  route: "Routed",
  extend: "Extended",
  new_manager: "New manager",
  not_swarm: "Not a swarm job",
  ask: "Asked you",
  stop: "Stopped",
  reassign: "Reassigned",
};

export const CAPABILITY_LABEL: Record<SwarmDecision["capability"], string> = {
  none: "",
  buddy_chat: "Buddy chat",
  computer_task: "Computer tab",
  research_run: "Research run",
  interview_brief: "Interview Companion brief",
};

/** Decisions a manager answers for itself; the rest come from whoever backs the front door. */
const MANAGER_VOICED = new Set<SwarmDecision["decision"]>(["route", "extend", "new_manager", "stop", "reassign"]);

export const HUE_COUNT = 6;

export interface Author {
  id: string;
  name: string;
  role: "you" | "manager" | "supervisor" | "aura";
  hue: number;
}

export type StreamItem =
  | { key: string; kind: "user"; text: string; at: number }
  | { key: string; kind: "decision"; decision: SwarmDecision; author: Author; at: number }
  | { key: string; kind: "crosspost"; text: string; at: number }
  | { key: string; kind: "system"; text: string; tone: "supervisor" | "routine" | "plain"; at: number }
  | { key: string; kind: "say"; text: string; author: Author; at: number }
  | { key: string; kind: "working"; sessionId: string; text: string; author: Author; at: number }
  | { key: string; kind: "plan"; message: SwarmMessage; author: Author; at: number }
  | { key: string; kind: "step"; message: SwarmMessage; author: Author; at: number }
  | { key: string; kind: "question"; message: SwarmMessage; author: Author; at: number }
  | { key: string; kind: "report"; message: SwarmMessage; author: Author; at: number }
  | { key: string; kind: "round"; roundId: string; message: SwarmMessage; author: Author; at: number }
  | { key: string; kind: "roundReply"; message: SwarmMessage; author: Author; at: number };

export function hueOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % HUE_COUNT;
}

export function managerChannel(id: string): ChannelId {
  return `m:${id}`;
}

export function managerIdOfChannel(channel: ChannelId): string {
  return channel.startsWith("m:") ? channel.slice(2) : "";
}

export function isChannelId(value: string | null | undefined): value is ChannelId {
  return value === "group" || value === "activity" || (typeof value === "string" && value.startsWith("m:") && value.length > 2);
}

/** Who answers at the front door right now. */
export function frontDoorAuthor(roster: SwarmRoster): Author {
  if (roster.frontDoorBacking === "supervisor" && roster.supervisor) {
    return { id: "supervisor", name: roster.supervisor.title, role: "supervisor", hue: 0 };
  }
  const solo = roster.frontDoorBacking === "manager" ? roster.managers.find((m) => m.status === "active") : undefined;
  if (solo) return { id: solo.id, name: solo.title, role: "manager", hue: hueOf(solo.id) };
  return { id: "aura", name: "Aura", role: "aura", hue: 0 };
}

export function supervisorActive(roster: SwarmRoster): boolean {
  return roster.supervisor?.status === "active";
}

export function groupChannelName(roster: SwarmRoster): string {
  return supervisorActive(roster) ? "group" : "front-door";
}

export function managerAuthor(roster: SwarmRoster, id: string, fallbackName = "Manager"): Author {
  const manager = roster.managers.find((m) => m.id === id);
  return { id, name: manager?.title || fallbackName, role: "manager", hue: hueOf(id) };
}

function decisionAuthor(decision: SwarmDecision, roster: SwarmRoster, backer: Author): Author {
  if (!MANAGER_VOICED.has(decision.decision) || !decision.targetManagerId) return backer;
  const manager = roster.managers.find((m) => m.id === decision.targetManagerId);
  const name = manager?.title || decision.targetTitle;
  if (!name) return backer;
  return { id: decision.targetManagerId, name, role: "manager", hue: hueOf(decision.targetManagerId) };
}

function decisionsOf(message: SwarmMessage): SwarmDecision[] {
  const raw = message.data.decisions;
  return Array.isArray(raw) ? raw.map((d) => mapDecision((d ?? {}) as Record<string, unknown>)) : [];
}

/** Everything one channel shows, oldest first. */
export function channelItems(messages: SwarmMessage[], roster: SwarmRoster): StreamItem[] {
  const backer = frontDoorAuthor(roster);
  const items: StreamItem[] = [];
  for (const m of messages) {
    const key = `${m.channelId}-${m.seq}`;
    const speaker = m.authorKind === "manager" ? managerAuthor(roster, m.authorId) : backer;
    if (m.authorKind === "user") {
      items.push({ key, kind: "user", text: m.text, at: m.at });
      continue;
    }
    switch (m.kind) {
      case "routing":
        decisionsOf(m).forEach((decision, i) =>
          items.push({ key: `${key}-d${i}`, kind: "decision", decision, author: decisionAuthor(decision, roster, backer), at: m.at }),
        );
        break;
      case "activity":
        items.push({ key, kind: "system", text: m.text, tone: /supervisor/i.test(m.text) ? "supervisor" : "plain", at: m.at });
        break;
      case "crosspost":
        items.push({ key, kind: "crosspost", text: m.text, at: m.at });
        break;
      case "routine":
        items.push({ key, kind: "system", text: `Routine: ${m.text}`, tone: "routine", at: m.at });
        break;
      case "working":
        items.push({ key, kind: "working", sessionId: m.sessionId, text: m.text, author: speaker, at: m.at });
        break;
      case "plan":
        items.push({ key, kind: "plan", message: m, author: speaker, at: m.at });
        break;
      case "step":
        items.push({ key, kind: "step", message: m, author: speaker, at: m.at });
        break;
      case "question":
        items.push({ key, kind: "question", message: m, author: speaker, at: m.at });
        break;
      case "report":
        items.push({ key, kind: "report", message: m, author: speaker, at: m.at });
        break;
      case "round_started":
        items.push({ key, kind: "round", roundId: typeof m.data.round_id === "string" ? m.data.round_id : "", message: m, author: backer, at: m.at });
        break;
      case "round_reply":
        items.push({ key, kind: "roundReply", message: m, author: backer, at: m.at });
        break;
      default:
        if (m.text) items.push({ key, kind: "say", text: m.text, author: speaker, at: m.at });
    }
  }
  return items;
}

export function findManager(roster: SwarmRoster, id: string): SwarmManager | undefined {
  return roster.managers.find((m) => m.id === id);
}

export function timeLabel(at?: number): string {
  if (!at) return "";
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(at: number): string {
  const day = new Date(at);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

/** The old sandbox thread as plain lines for the one-time import: who said it, where. */
export function importMessagesOf(thread: ThreadEntry[], roster: SwarmRoster): SwarmImportMessage[] {
  const out: SwarmImportMessage[] = [];
  let lastChannel: ChannelId = "group";
  for (const entry of thread) {
    if (entry.kind === "user") {
      const targetId =
        entry.targetId ?? (entry.target ? roster.managers.find((m) => m.title === entry.target)?.id ?? "" : "");
      lastChannel = targetId && roster.managers.some((m) => m.id === targetId) ? managerChannel(targetId) : "group";
      out.push({ channelId: lastChannel, author: "user", text: entry.text, atMs: entry.at ?? 0 });
    } else {
      const line = entry.decisions
        .map((d) => `${DECISION_LABEL[d.decision]}${d.targetTitle ? ` to ${d.targetTitle}` : ""}: ${d.reason}`)
        .join("\n");
      if (line) out.push({ channelId: lastChannel, author: "aura", text: line, atMs: entry.at ?? 0 });
      for (const event of entry.events) out.push({ channelId: "activity", author: "aura", text: event, atMs: entry.at ?? 0 });
    }
  }
  return out.filter((m) => m.text.trim());
}
