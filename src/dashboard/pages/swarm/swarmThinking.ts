import type { SwarmManager, SwarmMessage, SwarmSessionView } from "../../../lib/swarmApi";

/** The live row at the foot of a working manager's run card. It is built only from what
 * the polled session and the newest finished step already confirm, so it describes the
 * last known thing, never progress the server has not reported. The finished steps above
 * it are the real record; this line is just "what now".
 * No React, no DOM, no clock. */

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
  "github.repos": "Going through your repositories",
  "github.tree": "Going through the file list",
  "github.file": "Reading through that file",
  "github.search": "Going through the code matches",
  "github.issues": "Going through the issues",
  "x.bookmarks": "Going through X bookmarks",
  "notion.recent": "Going through recent Notion pages",
};

const GOAL_MAX = 48;

function shortGoal(goal: string): string {
  const trimmed = goal.trim();
  if (trimmed.length <= GOAL_MAX) return trimmed;
  const cut = trimmed.slice(0, GOAL_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function stepString(step: SwarmMessage | undefined, key: string): string {
  const value = step?.data[key];
  return typeof value === "string" ? value : "";
}

export function thinkingLine(session: SwarmSessionView, latestStep: SwarmMessage | undefined, manager: SwarmManager | undefined): string {
  if (session.cancelRequested) return "Finishing the current step, then stopping";
  const tasks = session.lanes.filter((lane) => lane.kind === "task");
  const leased = tasks.filter((lane) => lane.state === "leased");
  const stepTitle = stepString(latestStep, "subagent_title");
  const lane = (stepTitle && leased.find((l) => l.subagentTitle === stepTitle)) || leased[0];
  const goal = lane?.goal ? shortGoal(lane.goal) : "";

  switch (session.state) {
    case "queued":
      return "Waiting for a turn";
    case "planning": {
      const helpers = manager?.subagents.length ?? 0;
      return tasks.length === 0 && helpers > 1 ? `Working out how to split this between ${helpers} helpers` : "Reading your brief";
    }
    case "acting": {
      if (!latestStep) return goal ? `Starting on '${goal}'` : "Taking a first look";
      if (latestStep.data.ok === false) return "Working around a source it could not read";
      const base = AFTER_STEP[stepString(latestStep, "capability_id")] ?? "Reading what the last step turned up";
      return goal ? `${base} for '${goal}'` : base;
    }
    case "reporting": {
      const n = session.sources;
      return n > 0 ? `Writing up ${n} source${n === 1 ? "" : "s"} into a report` : "Writing up what it found";
    }
    case "verifying":
      return "Checking every claim against its sources";
    case "waiting_user":
      return "Waiting for your answer";
    default:
      return "Working";
  }
}
