import type { SwarmManager, SwarmMessage, SwarmSessionView } from "../../../lib/swarmApi";

/** What a working manager's card says beside its orb. `activity` is built only from what
 * the polled session and the newest finished step already confirm, so it describes the
 * last known thing, never progress the server has not reported. `voice` is the softer
 * second line in the manager's own tone; it rotates on `slot` and claims nothing.
 * No React, no DOM, no clock: the caller owns the rotation. */
export interface ThinkingLine {
  activity: string;
  voice: string;
}

/** Present tense twin of SwarmWork's past tense CAPABILITY_COPY: what the manager is doing
 * with the result of the step that just finished. */
const AFTER_STEP: Record<string, string> = {
  "web.search": "Reading what the web search turned up",
  "web.read": "Taking notes from the page it read",
  "gmail.search": "Reading what Gmail turned up",
  "gmail.read": "Reading that email closely",
  "calendar.events": "Going through the calendar",
  "classroom.due": "Going through Classroom deadlines",
  "github.activity": "Going through GitHub activity",
  "x.bookmarks": "Going through X bookmarks",
  "notion.recent": "Going through recent Notion pages",
  "aura.research": "Waiting on the Research run",
};

export type VoiceBank =
  | "queued"
  | "planning"
  | "acting"
  | "reporting"
  | "verifying"
  | "waiting_user"
  | "stopping"
  | "round"
  | "roundWriting";

const VOICE: Record<VoiceBank, string[]> = {
  queued: ["In line, ready when it is my turn", "Holding my place until the queue clears"],
  planning: ["Let me get the shape of this first", "Sketching a route before I move", "Thinking about where to start"],
  acting: ["Following the thread where it leads", "Reading closely, not skimming", "Keeping only what holds up"],
  reporting: ["Putting it in words you can use", "Leading with what matters most", "Naming the source next to each claim"],
  verifying: ["Reading it back against the sources", "Making sure nothing slipped in unsourced", "One more pass before you see it"],
  waiting_user: ["Your call decides the next step", "Holding here until you are back"],
  stopping: ["Wrapping this step up cleanly", "Leaving things tidy before I stop"],
  round: ["Each of them is on their own part", "Waiting for every report before I answer"],
  roundWriting: ["Pulling the reports into one answer", "Reading all of them before I write"],
};

const GOAL_MAX = 48;

function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shortGoal(goal: string): string {
  const trimmed = goal.trim();
  if (trimmed.length <= GOAL_MAX) return trimmed;
  const cut = trimmed.slice(0, GOAL_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** One line from the bank, stable per manager and stepping with `slot`. */
export function voiceLine(bank: VoiceBank, seed: string, slot: number): string {
  const lines = VOICE[bank];
  return lines[(fnv(seed) + Math.max(0, slot)) % lines.length];
}

function stepString(step: SwarmMessage | undefined, key: string): string {
  const value = step?.data[key];
  return typeof value === "string" ? value : "";
}

export function thinkingLine(session: SwarmSessionView, latestStep: SwarmMessage | undefined, manager: SwarmManager | undefined, slot = 0): ThinkingLine {
  const seed = manager?.id ?? session.managerId ?? "swarm";
  if (session.cancelRequested) {
    return { activity: "Finishing the current step, then stopping", voice: voiceLine("stopping", seed, slot) };
  }
  const tasks = session.lanes.filter((lane) => lane.kind === "task");
  const leased = tasks.filter((lane) => lane.state === "leased");
  const stepTitle = stepString(latestStep, "subagent_title");
  const lane = (stepTitle && leased.find((l) => l.subagentTitle === stepTitle)) || leased[0];
  const goal = lane?.goal ? shortGoal(lane.goal) : "";

  switch (session.state) {
    case "queued":
      return { activity: "Waiting for a turn", voice: voiceLine("queued", seed, slot) };
    case "planning": {
      const helpers = manager?.subagents.length ?? 0;
      const activity = tasks.length === 0 && helpers > 1 ? `Working out how to split this between ${helpers} helpers` : "Reading your brief";
      return { activity, voice: voiceLine("planning", seed, slot) };
    }
    case "acting": {
      let activity: string;
      if (latestStep) {
        if (latestStep.data.ok === false) activity = "Working around a source it could not read";
        else {
          const base = AFTER_STEP[stepString(latestStep, "capability_id")] ?? "Reading what the last step turned up";
          activity = goal ? `${base} for '${goal}'` : base;
        }
      } else {
        activity = goal ? `Starting on '${goal}'` : "Taking a first look";
      }
      return { activity, voice: voiceLine("acting", seed, slot) };
    }
    case "reporting": {
      const n = session.sources;
      const activity = n > 0 ? `Writing up ${n} source${n === 1 ? "" : "s"} into a report` : "Writing up what it found";
      return { activity, voice: voiceLine("reporting", seed, slot) };
    }
    case "verifying":
      return { activity: "Checking every claim against its sources", voice: voiceLine("verifying", seed, slot) };
    case "waiting_user":
      return { activity: "Waiting for your answer", voice: voiceLine("waiting_user", seed, slot) };
    default:
      return { activity: "Working", voice: voiceLine("acting", seed, slot) };
  }
}
