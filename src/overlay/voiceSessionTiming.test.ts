import { describe, expect, it } from "vitest";
import { shouldArmInitialAgentSilenceWatchdog } from "./voiceSessionTiming";

type InitialSessionEvent = "agent-joined" | "assistant-output";

function watchdogAfter(events: InitialSessionEvent[]): boolean {
  let assistantOutputReceived = false;
  let watchdogArmed = false;

  for (const event of events) {
    if (event === "assistant-output") {
      assistantOutputReceived = true;
      watchdogArmed = false;
    } else {
      watchdogArmed = shouldArmInitialAgentSilenceWatchdog(assistantOutputReceived);
    }
  }

  return watchdogArmed;
}

describe("initial agent silence watchdog", () => {
  it("arms while an agent is present but has not produced output", () => {
    expect(watchdogAfter(["agent-joined"])).toBe(true);
  });

  it("clears when output follows the agent join event", () => {
    expect(watchdogAfter(["agent-joined", "assistant-output"])).toBe(false);
  });

  it("stays clear when an existing track arrives before agent discovery", () => {
    expect(watchdogAfter(["assistant-output", "agent-joined"])).toBe(false);
  });
});
