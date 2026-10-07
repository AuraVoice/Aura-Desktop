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

/** Where a "not a swarm job" sends you: the dashboard route of the feature that does it.
 * Buddy chat has no page of its own (you are already talking to Aura), so no button. */
export const CAPABILITY_PATH: Partial<Record<SwarmDecision["capability"], { path: string; label: string }>> = {
  computer_task: { path: "/agents?tab=computer", label: "Open the Computer tab" },
  research_run: { path: "/agents?tab=research", label: "Open Research" },
  interview_brief: { path: "/interview", label: "Open Interview Companion" },
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
  | { key: string; kind: "user"; text: string; at: number; docs: { id: string; name: string }[]; mentions: { id: string; name: string }[] }
  /** A brief parked behind a busy manager (queued), or one that just got its turn (dequeued). */
  | { key: string; kind: "queued"; text: string; author: Author; picked: boolean; at: number }
  | {
      key: string;
      kind: "decision";
      decision: SwarmDecision;
      author: Author;
      at: number;
      /** The message this decision answered, so a "not a swarm job" can offer to resend it. */
      asked: { text: string; docs: { id: string; name: string }[] };
    }
  | { key: string; kind: "crosspost"; text: string; at: number }
  | { key: string; kind: "system"; text: string; tone: "supervisor" | "routine" | "plain"; at: number }
  | { key: string; kind: "say"; text: string; author: Author; at: number }
  /** A session's working line. Its plan and steps ride on it rather than as rows of their
   * own, so a finished run folds to one line and a live one shows only the chip. */
  | { key: string; kind: "working"; sessionId: string; text: string; author: Author; at: number; plan?: SwarmMessage; steps: SwarmMessage[]; reportAt: number }
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

/** What the user calls a manager: its persona name, or the title for one hired before names. */
export function displayName(manager: Pick<SwarmManager, "name" | "title">): string {
  return manager.name || manager.title;
}

/** Who answers at the front door right now. */
export function frontDoorAuthor(roster: SwarmRoster): Author {
  if (roster.frontDoorBacking === "supervisor" && roster.supervisor) {
    return { id: "supervisor", name: roster.supervisor.title, role: "supervisor", hue: 0 };
  }
  const solo = roster.frontDoorBacking === "manager" ? roster.managers.find((m) => m.status === "active") : undefined;
  if (solo) return { id: solo.id, name: displayName(solo), role: "manager", hue: hueOf(solo.id) };
  return { id: "aura", name: "Aura", role: "aura", hue: 0 };
}

export function supervisorActive(roster: SwarmRoster): boolean {
  return roster.supervisor?.status === "active";
}

/** The short role shown under or beside a name, so every voice reads as name plus title. */
export function roleLabel(author: Author, roster: SwarmRoster): string {
  if (author.role === "you") return "You";
  if (author.role === "supervisor") return "Supervisor";
  if (author.role === "aura") return "Hires your managers";
  const manager = roster.managers.find((m) => m.id === author.id);
  // A named manager shows its job as the role ("Snapshot Sam · Langfuse Snapshots").
  const job = manager?.name ? manager.title : "Manager";
  if (manager?.status === "paused") return `${job} · paused`;
  return job;
}

/** Everyone an @ in the composer can name: the Supervisor when it is active, then every
 * active manager, in roster order. */
export function mentionCandidates(roster: SwarmRoster): { id: string; name: string; title: string; author: Author }[] {
  const out: { id: string; name: string; title: string; author: Author }[] = [];
  if (supervisorActive(roster) && roster.supervisor) {
    out.push({ id: "supervisor", name: roster.supervisor.title, title: "Routes to your managers", author: { id: "supervisor", name: roster.supervisor.title, role: "supervisor", hue: 0 } });
  }
  for (const m of roster.managers) {
    if (m.status !== "active") continue;
    out.push({ id: m.id, name: displayName(m), title: m.name ? m.title : "Manager", author: managerAuthor(roster, m.id) });
  }
  return out;
}

/** The managers a typed message names with "@", longest name first so "@Sam Two" never
 * matches "@Sam". Case does not matter; a name or a title both count. At most four. */
export function mentionsIn(text: string, roster: SwarmRoster): string[] {
  const lower = text.toLowerCase();
  const names = mentionCandidates(roster)
    .flatMap((c) => [c.name, ...(c.id !== "supervisor" && c.title !== "Manager" ? [c.title] : [])].map((label) => ({ id: c.id, label: label.toLowerCase() })))
    .filter((c) => c.label)
    .sort((a, b) => b.label.length - a.label.length);
  const found: string[] = [];
  for (const { id, label } of names) {
    if (found.includes(id)) continue;
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(`@${label}`, from);
      if (at === -1) break;
      const after = lower[at + 1 + label.length];
      if ((at === 0 || /\s/.test(lower[at - 1])) && (after === undefined || !/[\p{L}\p{N}]/u.test(after))) {
        found.push(id);
        break;
      }
      from = at + 1;
    }
  }
  return found.slice(0, 4);
}

export function groupChannelName(roster: SwarmRoster): string {
  return supervisorActive(roster) ? "group" : "front-door";
}

export function managerAuthor(roster: SwarmRoster, id: string, fallbackName = "Manager"): Author {
  const manager = roster.managers.find((m) => m.id === id);
  return { id, name: manager ? displayName(manager) : fallbackName, role: "manager", hue: hueOf(id) };
}

function decisionAuthor(decision: SwarmDecision, roster: SwarmRoster, backer: Author): Author {
  if (!MANAGER_VOICED.has(decision.decision) || !decision.targetManagerId) return backer;
  const manager = roster.managers.find((m) => m.id === decision.targetManagerId);
  const name = manager ? displayName(manager) : decision.targetTitle;
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
  // First pass: what each session did, keyed by session, so the working line can carry it.
  const work: { plan: Record<string, SwarmMessage>; steps: Record<string, SwarmMessage[]>; reportAt: Record<string, number> } = {
    plan: {},
    steps: {},
    reportAt: {},
  };
  for (const m of messages) {
    if (m.authorKind === "user" || !m.sessionId) continue;
    if (m.kind === "plan") work.plan[m.sessionId] = m;
    else if (m.kind === "step") (work.steps[m.sessionId] ??= []).push(m);
    else if (m.kind === "report") work.reportAt[m.sessionId] = m.at;
  }
  let asked: { text: string; docs: { id: string; name: string }[] } = { text: "", docs: [] };
  for (const m of messages) {
    const key = `${m.channelId}-${m.seq}`;
    const speaker = m.authorKind === "manager" ? managerAuthor(roster, m.authorId) : backer;
    if (m.authorKind === "user") {
      // Files sent with the message (swarm/docs.py): names only, the text stays on the server.
      const docs = Array.isArray(m.data.docs)
        ? (m.data.docs as unknown[]).flatMap((d) => {
            const row = d && typeof d === "object" ? (d as Record<string, unknown>) : {};
            return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [];
          })
        : [];
      // Managers the user named with "@" (persisted.py): the stream styles exactly these.
      const mentions = Array.isArray(m.data.mentions)
        ? (m.data.mentions as unknown[]).flatMap((d) => {
            const row = d && typeof d === "object" ? (d as Record<string, unknown>) : {};
            return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [];
          })
        : [];
      items.push({ key, kind: "user", text: m.text, at: m.at, docs, mentions });
      asked = { text: m.text, docs };
      continue;
    }
    switch (m.kind) {
      case "queued":
      case "dequeued":
      case "answered": {
        // In #group the line names the manager (aura voice); in its DM the brief waits.
        // "answered" is #group only: the message answered a parked question and the
        // manager carried on, so it reads as picked up rather than waiting.
        const managerId = typeof m.data.manager_id === "string" ? m.data.manager_id : managerIdOfChannel(m.channelId as ChannelId);
        const author = managerId ? managerAuthor(roster, managerId) : backer;
        items.push({ key, kind: "queued", text: m.text, author, picked: m.kind !== "queued", at: m.at });
        break;
      }
      case "routing":
        decisionsOf(m).forEach((decision, i) => {
          const author = decisionAuthor(decision, roster, backer);
          // A hire reads like someone joining the channel, then saying hello.
          if (decision.decision === "new_manager" && decision.applied && author.role === "manager") {
            items.push({ key: `${key}-j${i}`, kind: "system", text: `${author.name} joined #${groupChannelName(roster)}`, tone: "plain", at: m.at });
          }
          items.push({ key: `${key}-d${i}`, kind: "decision", decision, author, at: m.at, asked });
        });
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
      case "event":
        // A watch saw its source change (backend watches.py); the brief is the watch's own.
        items.push({ key, kind: "system", text: `Something it watches changed. ${m.text}`, tone: "routine", at: m.at });
        break;
      case "working":
        items.push({
          key,
          kind: "working",
          sessionId: m.sessionId,
          text: m.text,
          author: speaker,
          at: m.at,
          plan: work.plan[m.sessionId],
          steps: work.steps[m.sessionId] ?? [],
          reportAt: work.reportAt[m.sessionId] ?? 0,
        });
        break;
      case "plan":
      case "step":
        // Folded under the session's working line (collected above); never a row of its own.
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
