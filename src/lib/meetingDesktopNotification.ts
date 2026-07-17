import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { logError } from "./log";

export async function ensureMeetingNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch (err) {
    logError("meetingDesktopNotification: permission", err);
    return false;
  }
}

export async function sendMeetingCaptureEndedNotification(): Promise<boolean> {
  try {
    if (!(await ensureMeetingNotificationPermission())) return false;
    sendNotification({
      title: "Aura",
      body: "Meeting recording ended. Aura is sending it for transcription.",
    });
    return true;
  } catch (err) {
    logError("meetingDesktopNotification: send", err);
    return false;
  }
}
