/** Dev-only harness for meeting notes, following the draftDebug.ts precedent:
 * drive the whole claim -> capture -> upload -> complete -> synthesize loop
 * from the webview devtools console with no Zoom/Teams installed.
 *
 *   __meetingDebug.forceJoin("evt-test-1")   // emits meeting-join-detected via Rust
 *   __meetingDebug.status()                  // Rust capture_status
 *   __meetingDebug.snapshot()                // Rust queue_snapshot (upload queue)
 *   __meetingDebug.stop()                    // stop capture (reason stopped_by_user)
 *   __meetingDebug.captureNow()              // the manual Meet path
 *   __meetingDebug.pump()                    // force an upload pump pass now
 *
 * forceJoin goes through the real Rust command (debug_force_join, dev builds
 * only), so the event arrives over the same channel the real detector uses.
 * Real audio still gets captured from the default mic + loopback, so play
 * something and speak to get a two-sided transcript. */

import { invoke } from "@tauri-apps/api/core";

interface MeetingDebugApi {
  forceJoin: (eventId: string) => void;
  status: () => Promise<unknown>;
  snapshot: () => Promise<unknown>;
  stop: () => void;
  captureNow: () => void;
  pump: () => void;
}

export function installMeetingDebug(hooks: {
  captureNow: () => void;
  stopCapture: () => void;
  pump: () => void;
}): () => void {
  const api: MeetingDebugApi = {
    forceJoin: (eventId: string) => {
      void invoke("debug_force_join", { eventId });
    },
    status: () => invoke("capture_status"),
    snapshot: () => invoke("queue_snapshot"),
    stop: hooks.stopCapture,
    captureNow: hooks.captureNow,
    pump: hooks.pump,
  };
  const w = window as unknown as { __meetingDebug?: MeetingDebugApi };
  w.__meetingDebug = api;
  return () => {
    if (w.__meetingDebug === api) {
      delete w.__meetingDebug;
    }
  };
}
