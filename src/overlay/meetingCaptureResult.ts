import type { Room } from "livekit-client";

/** Tells a live Buddy call what its `meeting_capture` request did, so Buddy can
 * say so when a start was refused (voice/desktop_run.py
 * `_deliver_meeting_capture_result`). Flat message on `client_events`, the same
 * shape as the browser task's `desktop.result`. Status only: started, stopped,
 * cap, failed, skipped, already_recording or not_recording. */
export async function publishMeetingCaptureResult(room: Room, status: string): Promise<void> {
  const message = { type: "desktop.result", id: "meeting_capture", status };
  await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), {
    reliable: true,
    topic: "client_events",
  });
}
