import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());
const fakeStore = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => state.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    state.set(key, structuredClone(value));
  }),
  save: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => fakeStore),
}));

import {
  bindMeetingActivityOwner,
  type MeetingActivity,
  upsertMeetingActivity,
} from "./meetingActivity";

const activity: MeetingActivity = {
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
};

describe("meeting activity persistence", () => {
  beforeEach(() => {
    state.clear();
    vi.clearAllMocks();
  });

  it("survives reload for the same owner", async () => {
    await bindMeetingActivityOwner("user-1");
    await upsertMeetingActivity("user-1", activity);

    expect(await bindMeetingActivityOwner("user-1")).toEqual([activity]);
  });

  it("clears before exposing a different account", async () => {
    await bindMeetingActivityOwner("user-1");
    await upsertMeetingActivity("user-1", activity);

    expect(await bindMeetingActivityOwner("user-2")).toEqual([]);
  });
});
