import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  authFetch: vi.fn(),
  AuthRequiredError: class AuthRequiredError extends Error {},
}));
vi.mock("./log", () => ({ logError: vi.fn() }));

import { authFetch } from "./api";
import { meetingFailureCopy } from "./meetingCopy";
import {
  claimMeeting,
  completeMeeting,
  MeetingTransportError,
  parseMeetingDoc,
  uploadSegment,
} from "./meetings";

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

describe("meeting V2 evidence transport", () => {
  it("sends installation and runtime identity and parses the fenced claim", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        meeting_id: "meeting_1",
        capture_run_id: "run_1",
        capture_fence: 7,
        lease_expires_at: "2026-07-29T20:05:00Z",
        cap_minutes: 60,
        max_capture_minutes: 60,
      }),
    } as Response);

    const claim = await claimMeeting({
      eventId: "event_1",
      title: "Review",
      startTime: "2026-07-29T20:00:00Z",
      endTime: "2026-07-29T21:00:00Z",
      deviceId: "install_1",
      runtimeInstanceId: "runtime_1",
    });

    expect(claim).toMatchObject({
      meetingId: "meeting_1",
      captureRunId: "run_1",
      captureFence: 7,
      protocolVersion: 2,
    });
    const calls = vi.mocked(authFetch).mock.calls;
    const request = calls[calls.length - 1];
    expect(JSON.parse(String((request?.[1] as RequestInit).body))).toMatchObject({
      installation_id: "install_1",
      runtime_instance_id: "runtime_1",
    });
  });

  it("uses the create-only V2 segment route and validates the receipt", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        receipt_id: "receipt_1",
        object: "audio/v2/u/meeting_1/run_1/000000/hash.flac",
        generation: "123",
        content_sha256: "a".repeat(64),
        byte_length: 3,
        accepted_at: "2026-07-29T20:00:00Z",
      }),
    } as Response);

    const receipt = await uploadSegment({
      jobId: "upload:meeting_1:run_1:0:hash",
      meetingId: "meeting_1",
      captureRunId: "run_1",
      captureFence: 7,
      protocolVersion: 2,
      seq: 0,
      bytes: new Uint8Array([1, 2, 3]),
      startMs: 0,
      durationMs: 1000,
      incomplete: false,
      contentSha256: "a".repeat(64),
      byteLength: 3,
      channelCount: 2,
      sampleRateHz: 16000,
    });

    expect(receipt.receiptId).toBe("receipt_1");
    const calls = vi.mocked(authFetch).mock.calls;
    const [path, init] = calls[calls.length - 1] ?? [];
    expect(path).toBe("/meetings/meeting_1/capture-runs/run_1/segments/0");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>)["X-Capture-Fence"]).toBe("7");
    expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toContain("upload:");
  });

  it("treats a success response without a bound receipt as terminal", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ receipt_id: "receipt_1" }),
    } as Response);

    await expect(uploadSegment({
      jobId: "upload:meeting_1:run_1:0:hash",
      meetingId: "meeting_1",
      captureRunId: "run_1",
      captureFence: 7,
      protocolVersion: 2,
      seq: 0,
      bytes: new Uint8Array([1]),
      startMs: 0,
      durationMs: 100,
      incomplete: false,
      contentSha256: "a".repeat(64),
      byteLength: 1,
      channelCount: 2,
      sampleRateHz: 16000,
    })).rejects.toMatchObject({
      name: "MeetingTransportError",
      code: "invalid_upload_receipt",
      classification: "terminal",
    } satisfies Partial<MeetingTransportError>);
  });

  it("binds completion success to the manifest digest", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        receipt_id: "complete_1",
        manifest_sha256: "b".repeat(64),
        accepted_at: "2026-07-29T20:02:00Z",
      }),
    } as Response);

    const receipt = await completeMeeting({
      jobId: "complete:meeting_1:run_1:manifest",
      meetingId: "meeting_1",
      captureRunId: "run_1",
      captureFence: 7,
      protocolVersion: 2,
      segmentCount: 1,
      totalDurationMs: 1000,
      reason: "ended",
      segmentDigests: ["a".repeat(64)],
      manifestSegments: [],
      manifestSha256: "b".repeat(64),
    });
    expect(receipt.manifestSha256).toBe("b".repeat(64));
  });
});
