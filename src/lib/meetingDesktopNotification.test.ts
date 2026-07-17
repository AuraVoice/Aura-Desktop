import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => mocks);

import { sendMeetingCaptureEndedNotification } from "./meetingDesktopNotification";

describe("meeting desktop notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests permission and sends a capture-ended toast", async () => {
    mocks.isPermissionGranted.mockResolvedValue(false);
    mocks.requestPermission.mockResolvedValue("granted");

    await expect(sendMeetingCaptureEndedNotification()).resolves.toBe(true);
    expect(mocks.sendNotification).toHaveBeenCalledWith({
      title: "Aura",
      body: "Meeting recording ended. Aura is sending it for transcription.",
    });
  });

  it("does not report delivery when permission is denied", async () => {
    mocks.isPermissionGranted.mockResolvedValue(false);
    mocks.requestPermission.mockResolvedValue("denied");

    await expect(sendMeetingCaptureEndedNotification()).resolves.toBe(false);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});
