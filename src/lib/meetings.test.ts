import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  authFetch: vi.fn(),
  AuthRequiredError: class AuthRequiredError extends Error {},
}));
vi.mock("./log", () => ({ logError: vi.fn() }));

import { meetingFailureCopy } from "./meetingCopy";
import { parseMeetingDoc } from "./meetings";

describe("meeting processing contract", () => {
  it("parses additive processing metadata without changing legacy fields", () => {
    const doc = parseMeetingDoc({
      meeting_id: "m1",
      event_id: "e1",
      title: "Weekly sync",
      status: "failed",
      processing_stage: "building_insights",
      failure_code: "insight_generation_failed",
      retryable: false,
      attempt_count: 2,
      last_error_at: "2026-07-14T20:00:00Z",
      status_revision: 4,
      created_at: "2026-07-14T19:00:00Z",
      updated_at: "2026-07-14T20:00:00Z",
    });

    expect(doc).toMatchObject({
      meetingId: "m1",
      status: "failed",
      processingStage: "building_insights",
      failureCode: "insight_generation_failed",
      retryable: false,
      attemptCount: 2,
      statusRevision: 4,
    });
  });

  it("rejects unknown coarse statuses and safely ignores unknown stages", () => {
    expect(parseMeetingDoc({ meeting_id: "m1", status: "future_state" })).toBeNull();
    expect(parseMeetingDoc({
      meeting_id: "m1",
      status: "synthesizing",
      processing_stage: "future_stage",
    })?.processingStage).toBeNull();
  });

  it("uses stable safe failure copy with an unknown-code fallback", () => {
    expect(meetingFailureCopy("upload_storage_unavailable")).toContain("safe on this device");
    expect(meetingFailureCopy("future_failure")).toBe("Aura could not finish this meeting yet.");
  });

  it("parses transcript turns and drops a malformed transcript defensively", () => {
    const base = {
      meeting_id: "m1",
      status: "ready",
      note: {
        summary: "A useful meeting",
        transcript: [
          { speaker: "Speaker 1", text: "First point" },
          { speaker: "Speaker 2", text: "Second point" },
        ],
      },
    };

    expect(parseMeetingDoc(base)?.note?.transcript).toEqual([
      { speaker: "Speaker 1", text: "First point" },
      { speaker: "Speaker 2", text: "Second point" },
    ]);
    expect(parseMeetingDoc({
      ...base,
      note: {
        ...base.note,
        transcript: [{ speaker: "Speaker 1", text: "Valid" }, { speaker: 2 }],
      },
    })?.note?.transcript).toEqual([]);
  });
});
