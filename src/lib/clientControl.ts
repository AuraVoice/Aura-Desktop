import type { Room } from "livekit-client";

export interface GuideModeControl {
  active: boolean;
  guideSessionId: string | null;
  generation: number;
  protocolVersion?: 1 | 2;
  resumeTaskId?: string | null;
}

export function encodeGuideMode(control: GuideModeControl): Uint8Array {
  if (!Number.isSafeInteger(control.generation) || control.generation < 0) {
    throw new Error("guide.mode generation must be a non-negative safe integer");
  }
  if (
    control.active &&
    (typeof control.guideSessionId !== "string" ||
      !/^[0-9a-f]{32}$/.test(control.guideSessionId))
  ) {
    throw new Error("active guide.mode requires a 128-bit Guide session id");
  }
  if (
    control.resumeTaskId != null &&
    !/^[0-9a-f]{32}$/.test(control.resumeTaskId)
  ) {
    throw new Error("guide.mode resume task id must be a 128-bit hex id");
  }
  return new TextEncoder().encode(
    JSON.stringify({
      type: "guide.mode",
      active: control.active,
      guide_session_id: control.guideSessionId,
      generation: control.generation,
      protocol_version: control.protocolVersion ?? 1,
      resume_task_id: control.resumeTaskId ?? null,
    }),
  );
}

export async function publishGuideMode(room: Room, control: GuideModeControl): Promise<void> {
  await room.localParticipant.publishData(encodeGuideMode(control), {
    reliable: true,
    topic: "client_events",
  });
}

export interface OutputModeControl {
  mode: "voice" | "text";
  generation: number;
}

export function encodeOutputMode(control: OutputModeControl): Uint8Array {
  if (!Number.isSafeInteger(control.generation) || control.generation < 0) {
    throw new Error("output.mode generation must be a non-negative safe integer");
  }
  return new TextEncoder().encode(
    JSON.stringify({
      type: "output.mode",
      mode: control.mode,
      generation: control.generation,
    }),
  );
}

export async function publishOutputMode(room: Room, control: OutputModeControl): Promise<void> {
  await room.localParticipant.publishData(encodeOutputMode(control), {
    reliable: true,
    topic: "client_events",
  });
}

/** Why this turn's screen capture was skipped. Closed vocabulary shared with
 * the worker (screen_context_control.py); anything else is normalized to
 * capture_failed on the receiving side. */
export type ScreenContextUnavailableReason =
  | "screen_context_disabled"
  | "permission_denied"
  | "mode_conflict"
  | "signed_out"
  | "capture_failed";

export function encodeScreenContextUnavailable(
  reason: ScreenContextUnavailableReason,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: "screen_context.unavailable",
      reason,
    }),
  );
}

/**
 * Tells the worker WHY no screen context is coming this turn. Before this
 * signal, "setting off", "permission missing", "client crashed" and "capture
 * in flight" were all indistinguishable silence on the worker side, so Buddy
 * could only say a generic "I can't see your screen". Sent at most once per
 * turn by useTurnScreenCapture.
 */
export async function publishScreenContextUnavailable(
  room: Room,
  reason: ScreenContextUnavailableReason,
): Promise<void> {
  await room.localParticipant.publishData(encodeScreenContextUnavailable(reason), {
    reliable: true,
    topic: "client_events",
  });
}

export interface ArtifactDisplayed {
  artifactId: string;
  revision: number;
}

/**
 * Receipt for a card the overlay actually rendered. Publishing the card only
 * proves the worker sent a packet, so without this "Done, it's on your screen."
 * is a claim about the network. Id and revision identify the exact revision
 * drawn, which is also what makes the worker's one resend idempotent.
 */
export function encodeArtifactDisplayed(ack: ArtifactDisplayed): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(ack.artifactId)) {
    throw new Error("artifact.displayed requires a 128-bit hex artifact id");
  }
  if (!Number.isSafeInteger(ack.revision) || ack.revision < 1) {
    throw new Error("artifact.displayed revision must be a positive safe integer");
  }
  return new TextEncoder().encode(
    JSON.stringify({
      type: "artifact.displayed",
      artifact_id: ack.artifactId,
      revision: ack.revision,
    }),
  );
}

export async function publishArtifactDisplayed(
  room: Room,
  ack: ArtifactDisplayed,
): Promise<void> {
  await room.localParticipant.publishData(encodeArtifactDisplayed(ack), {
    reliable: true,
    topic: "client_events",
  });
}
