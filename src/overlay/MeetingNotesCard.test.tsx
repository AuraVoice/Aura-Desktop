import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/dashboardLink", () => ({ openDashboard: vi.fn() }));

import type { MeetingActivity } from "../lib/meetingActivity";
import { MeetingNotesCard } from "./MeetingNotesCard";
import type { MeetingNotesState } from "./useMeetingNotes";

function state(activity: MeetingActivity): MeetingNotesState {
  return {
    visible: true,
    doc: null,
    activity,
    dismiss: vi.fn(),
    retry: vi.fn(),
    turnOff: vi.fn(),
    reset: vi.fn(),
  };
}

describe("MeetingNotesCard recovery state", () => {
  it("shows durable local segment progress", () => {
    const html = renderToStaticMarkup(<MeetingNotesCard card={state({
      meetingId: "m1",
      eventId: "e1",
      phase: "saved_local",
      segmentCount: 2,
      uploadedCount: 0,
      lastAttemptAt: null,
      nextRetryAt: null,
      failureCode: null,
      retryable: false,
      updatedAt: Date.now(),
    })} />);

    expect(html).toContain("Saved securely on this device (2 segments).");
  });

  it("shows safe failure copy and Retry now only when retryable", () => {
    const html = renderToStaticMarkup(<MeetingNotesCard card={state({
      meetingId: "m1",
      eventId: "e1",
      phase: "needs_attention",
      segmentCount: 2,
      uploadedCount: 0,
      lastAttemptAt: Date.now(),
      nextRetryAt: Date.now() + 30_000,
      failureCode: "upload_storage_unavailable",
      retryable: true,
      updatedAt: Date.now(),
    })} />);

    expect(html).toContain("safe on this device");
    expect(html).toContain("Retry now");
  });
});
