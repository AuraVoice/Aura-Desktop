import type { Room } from "livekit-client";

export interface GuideModeControl {
  active: boolean;
  guideSessionId: string | null;
  generation: number;
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
  return new TextEncoder().encode(
    JSON.stringify({
      type: "guide.mode",
      active: control.active,
      guide_session_id: control.guideSessionId,
      generation: control.generation,
    }),
  );
}

export async function publishGuideMode(room: Room, control: GuideModeControl): Promise<void> {
  await room.localParticipant.publishData(encodeGuideMode(control), {
    reliable: true,
    topic: "client_events",
  });
}
