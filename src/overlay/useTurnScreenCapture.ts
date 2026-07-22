import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Room,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  type TranscriptionSegment,
} from "livekit-client";
import { validateAgentDataMessage } from "../lib/agentData";
import { logError } from "../lib/log";
import {
  asArrayBuffer,
  parseCapturedFrame,
  screenPointFor,
  type ScreenFrameGeometry,
} from "../lib/screenFrame";

const RETAINED_FRAME_GEOMETRY_COUNT = 4;
const NOTICE_DURATION_MS = 3500;
export function useTurnScreenCapture(room: Room | null, guideArmed = false) {
  const [notice, setNotice] = useState<string | null>(null);
  const capturedThisTurnRef = useRef(false);
  const frameCounterRef = useRef(0);
  const sentGeometryRef = useRef<Map<string, ScreenFrameGeometry>>(new Map());
  const activeRoomRef = useRef<Room | null>(room);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeRoomRef.current = room;

  const showNotice = useCallback((message: string) => {
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    setNotice(message);
    noticeTimeoutRef.current = setTimeout(() => {
      noticeTimeoutRef.current = null;
      setNotice(null);
    }, NOTICE_DURATION_MS);
  }, []);

  const captureAndSend = useCallback(async () => {
    if (!room || guideArmed) return;
    const captureRoom = room;
    let buffer: ArrayBuffer;
    try {
      buffer = asArrayBuffer(await invoke("capture_turn_screen_with_geometry"));
    } catch (err) {
      logError("useTurnScreenCapture: capture", err);
      showNotice("Couldn't capture this turn.");
      return;
    }

    let geometry: ScreenFrameGeometry;
    let bytes: Uint8Array;
    try {
      ({ geometry, bytes } = parseCapturedFrame(buffer));
    } catch (err) {
      logError("useTurnScreenCapture: parse", err);
      showNotice("Couldn't read this turn's capture.");
      return;
    }
    // A capture can finish after a disconnect/retry replaced the LiveKit Room.
    // Drop it before it can populate the new room's geometry map or stream to
    // the old participant.
    if (activeRoomRef.current !== captureRoom) return;
    frameCounterRef.current += 1;
    const frameId = `f${frameCounterRef.current}`;
    sentGeometryRef.current.set(frameId, geometry);
    while (sentGeometryRef.current.size > RETAINED_FRAME_GEOMETRY_COUNT) {
      const oldestKey = sentGeometryRef.current.keys().next().value;
      if (oldestKey === undefined) break;
      sentGeometryRef.current.delete(oldestKey);
    }

    try {
      const writer = await room.localParticipant.streamBytes({
        topic: "screen_frame",
        mimeType: "image/jpeg",
        totalSize: bytes.length,
        attributes: {
          frame_id: frameId,
          captured_at_ms: String(Date.now()),
          jpeg_width_px: String(geometry.jpegWidthPx),
          jpeg_height_px: String(geometry.jpegHeightPx),
          monitor_left_px: String(geometry.monitorLeftPx),
          monitor_top_px: String(geometry.monitorTopPx),
          monitor_width_px: String(geometry.monitorWidthPx),
          monitor_height_px: String(geometry.monitorHeightPx),
          scale_factor: String(geometry.scaleFactor),
        },
      });
      await writer.write(bytes);
      await writer.close();
    } catch (err) {
      logError("useTurnScreenCapture: send", err);
      showNotice("Screen captured, but it couldn't be shared.");
    }
  }, [room, guideArmed, showNotice]);

  useEffect(() => {
    capturedThisTurnRef.current = false;
    frameCounterRef.current = 0;
    sentGeometryRef.current.clear();
    if (!room || guideArmed) return;

    function handleElementPoint(payload: Record<string, unknown>) {
      const x = payload.x;
      const y = payload.y;
      if (typeof x !== "number" || typeof y !== "number") return;
      if (typeof payload.frame_id !== "string" || !payload.frame_id) return;
      const geometry = sentGeometryRef.current.get(payload.frame_id);
      if (!geometry) return;
      const label = typeof payload.label === "string" ? payload.label.trim() : "";
      const point = screenPointFor(geometry, x, y);
      invoke("point_at", {
        targetX: point.x,
        targetY: point.y,
        monitorX: point.monitorX,
        monitorY: point.monitorY,
        monitorW: point.monitorWidth,
        monitorH: point.monitorHeight,
        label,
      }).catch((err) => logError("useTurnScreenCapture: point_at", err));
    }

    function handleScreenSaveCreated(payload: Record<string, unknown>) {
      const collectionName =
        typeof payload.collection_name === "string" ? payload.collection_name.trim() : "";
      const title = typeof payload.title === "string" ? payload.title.trim() : "";
      showNotice(collectionName ? `Saved to ${collectionName}` : title ? `Saved "${title}"` : "Saved");
    }

    function onDataReceived(
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) {
      try {
        const verdict = validateAgentDataMessage(payload, participant, topic);
        if (verdict.kind !== "valid") return;
        if (verdict.type === "element.point") handleElementPoint(verdict.payload);
        else if (verdict.type === "screen_save.created") {
          handleScreenSaveCreated(verdict.payload);
        }
      } catch (err) {
        logError("useTurnScreenCapture: onDataReceived", err);
      }
    }

    function onTranscriptionReceived(
      segments: TranscriptionSegment[],
      participant?: Participant,
    ) {
      if (!participant?.isLocal) return;
      for (const segment of segments) {
        if (!segment.final && !capturedThisTurnRef.current) {
          capturedThisTurnRef.current = true;
          void captureAndSend();
        } else if (segment.final) {
          capturedThisTurnRef.current = false;
        }
      }
    }

    room.on(RoomEvent.DataReceived, onDataReceived);
    room.on(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
      room.off(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
      capturedThisTurnRef.current = false;
      sentGeometryRef.current.clear();
    };
  }, [room, guideArmed, captureAndSend, showNotice]);

  useEffect(() => {
    return () => {
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    };
  }, []);

  return { notice };
}
