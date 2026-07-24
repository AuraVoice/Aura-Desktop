import { authFetch, AuthRequiredError } from "./api";
import { trackEvent } from "./analytics";
import { logError } from "./log";

/** How a Guide Mode session ended, from the desktop's point of view.
 *  - completed: the agent sent a step with done=true.
 *  - abandoned: the user turned Guide Mode off before completion.
 *  - signed_out: the session was torn down because the user signed out.
 *  - session_ended: the underlying voice session ended/errored under it. */
export type GuideUsageOutcome = "completed" | "abandoned" | "signed_out" | "session_ended";

/** Client-observable metrics for one armed Guide Mode window. The agent side
 *  (juno-backend voice worker) fills in the fields the desktop cannot see -
 *  model, avg TTFT, tools invoked, last user turn - onto the SAME rollup, keyed
 *  by guideSessionId. */
export interface GuideUsageReport {
  guideSessionId: string;
  startedAt: string; // ISO 8601
  endedAt: string; // ISO 8601
  durationMs: number;
  outcome: GuideUsageOutcome;
  framesSent: number;
  stepsReceived: number;
  agentTimeouts: number;
}

/** Reports one finished Guide Mode session to BOTH sinks (the product decision):
 *  a PostHog `guide_session` event for cross-platform analytics, and a fail-soft
 *  POST to the backend so it lands in the user's Firestore rollup.
 *
 *  Fire-and-forget with the same posture as analytics + syncProfileToBackend:
 *  usage reporting must never break or block turning Guide Mode off, so every
 *  failure only logs. The backend endpoint is a cross-repo dependency that may
 *  not be deployed yet; a 404/500 is swallowed exactly like a network blip. */
export function reportGuideUsage(report: GuideUsageReport): void {
  trackEvent("guide_session", {
    guideSessionId: report.guideSessionId,
    durationMs: report.durationMs,
    outcome: report.outcome,
    framesSent: report.framesSent,
    stepsReceived: report.stepsReceived,
    agentTimeouts: report.agentTimeouts,
  });

  void postGuideUsageToBackend(report);
}

async function postGuideUsageToBackend(report: GuideUsageReport): Promise<void> {
  try {
    const response = await authFetch("/devices/guide-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guide_session_id: report.guideSessionId,
        started_at: report.startedAt,
        ended_at: report.endedAt,
        duration_ms: report.durationMs,
        outcome: report.outcome,
        frames_sent: report.framesSent,
        steps_received: report.stepsReceived,
        agent_timeouts: report.agentTimeouts,
      }),
    });
    if (!response.ok) {
      logError("guideUsage: reportGuideUsage", `HTTP ${response.status}`);
    }
  } catch (err) {
    // AuthRequiredError should not reach here (Guide Mode only runs signed in),
    // but treat it like any other failure: log, never throw.
    if (err instanceof AuthRequiredError) {
      logError("guideUsage: reportGuideUsage", "called without a signed-in user");
      return;
    }
    logError("guideUsage: reportGuideUsage", err);
  }
}
