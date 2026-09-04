import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  type TranscriptionSegment,
} from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { useTauriEvent } from "../lib/useTauriEvent";
import {
  SCREEN_SIGHT_ARMED,
  type ScreenSightArmedPayload,
} from "../lib/ipcEvents";
import { validateAgentDataMessage } from "../lib/agentData";
import { logError } from "../lib/log";
import {
  asArrayBuffer,
  parseCapturedFrame,
  screenPointFor,
  type ScreenFrameGeometry,
} from "../lib/screenFrame";
import type { VoiceSessionStatus } from "./useVoiceBar";

const RETAINED_FRAME_GEOMETRY_COUNT = 4;

function isSessionLive(status: VoiceSessionStatus): boolean {
  return status === "ready" || status === "listening" || status === "processing" || status === "speaking";
}

function isTerminalStatus(status: VoiceSessionStatus): boolean {
  return status === "disconnected" || status === "ended" || status === "error";
}

/**
 * Legacy explicitly-armed screen-sight transport: one frame goes out on arm
 * and one at the start of each spoken
 * turn. Direct port of `screen_sight_service.dart`, translated onto the real
 * LiveKit signals it actually listens to (its own already-translated event
 * stream) rather than the raw wire protocol.
 */
export function useScreenSight(room: Room | null, status: VoiceSessionStatus) {
  const [armed, setArmed] = useState(false);
  const capturedThisTurnRef = useRef(false);
  const sessionReadyCapturedRef = useRef(false);
  const frameCounterRef = useRef(0);
  const sentGeometryRef = useRef<Map<string, ScreenFrameGeometry>>(new Map());
  const armedRef = useRef(armed);
  armedRef.current = armed;

  const captureAndSend = useCallback(
    async (reason: string) => {
      if (!armedRef.current || !room) return;
      let buffer: ArrayBuffer;
      try {
        buffer = asArrayBuffer(await invoke("capture_cursor_display_with_geometry"));
      } catch (err) {
        logError(`useScreenSight: capture (${reason})`, err);
        return;
      }
      if (!armedRef.current) return;

      const { geometry, bytes } = parseCapturedFrame(buffer);

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
        logError(`useScreenSight: send (${reason})`, err);
      }
    },
    [room],
  );

  const disarm = useCallback(() => {
    setArmed(false);
    capturedThisTurnRef.current = false;
  }, []);

  // Rust owns the armed bit (security.rs) - capture authorization is checked
  // there, not against this mirror. Any native toggle asks Rust to change it;
  // the new state comes back on the screen-sight-armed event below, same as
  // the Ctrl+Alt+S hotkey (which never leaves Rust at all).
  const toggleArmed = useCallback(() => {
    invoke("toggle_screen_sight_armed").catch((err) =>
      logError("useScreenSight: toggle_screen_sight_armed", err),
    );
  }, []);

  const statusRef = useRef(status);
  statusRef.current = status;

  // The single armed-state funnel for every trigger (hotkey, native command,
  // voice end, sign-out): mirror Rust's bit and fire the on-arm capture.
  useTauriEvent<ScreenSightArmedPayload>(
    SCREEN_SIGHT_ARMED,
    (payload) => {
      const next = payload.armed;
      const wasArmed = armedRef.current;
      armedRef.current = next;
      setArmed(next);
      capturedThisTurnRef.current = false;
      if (next && !wasArmed && isSessionLive(statusRef.current)) {
        void captureAndSend("armed");
      }
    },
    "useScreenSight: listen screen-sight-armed",
  );

  // Seed the mirror once on mount - covers a webview reload while Rust's
  // armed bit is still set (same race current_overlay_state covers).
  useEffect(() => {
    invoke<boolean>("screen_sight_armed")
      .then((value) => {
        armedRef.current = value;
        setArmed(value);
      })
      .catch((err) => logError("useScreenSight: screen_sight_armed", err));
  }, []);

  // Auto-capture the instant the session becomes live - covers arming the
  // hotkey while the call is still dialing. `status` is already the
  // correctly-translated signal (useVoiceBar synthesizes "ready" locally on
  // connect, mirroring Flutter's local session.ready), so there's no need to
  // listen for anything over the wire for this.
  useEffect(() => {
    try {
      if (status === "ready" && !sessionReadyCapturedRef.current) {
        sessionReadyCapturedRef.current = true;
        if (armedRef.current) void captureAndSend("session.ready");
      } else if (isTerminalStatus(status)) {
        sessionReadyCapturedRef.current = false;
        disarm();
      }
    } catch (err) {
      logError("useScreenSight: session-status effect", err);
    }
  }, [status, captureAndSend, disarm]);

  useEffect(() => {
    if (!room) return;

    function handleElementPoint(payload: Record<string, unknown>) {
      try {
        const x = payload?.x;
        const y = payload?.y;
        if (typeof x !== "number" || typeof y !== "number") return;
        const frameId = typeof payload?.frame_id === "string" ? payload.frame_id : "";
        const values = Array.from(sentGeometryRef.current.values());
        const geometry = sentGeometryRef.current.get(frameId) ?? values[values.length - 1];
        if (!geometry) return;
        const label = typeof payload?.label === "string" ? payload.label.trim() : "";
        const point = screenPointFor(geometry, x, y);
        invoke("point_at", {
          targetX: point.x,
          targetY: point.y,
          monitorX: point.monitorX,
          monitorY: point.monitorY,
          monitorW: point.monitorWidth,
          monitorH: point.monitorHeight,
          label,
        }).catch((err) => logError("useScreenSight: point_at", err));
      } catch (err) {
        logError("useScreenSight: handleElementPoint", err);
      }
    }

    // Only element.point matters here. The saved captions (screen_save.created
    // and notion.saved) are owned by useTurnScreenCapture's notice path - the
    // caption plumbing this hook once carried returned a value nothing
    // rendered, which shipped a "Saved to X" confirmation the user never saw.
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
      } catch (err) {
        logError("useScreenSight: onDataReceived", err);
      }
    }

    // Turn-start/turn-end - LiveKit's native transcription feature, not a
    // data message, mirroring how useVoiceBar.ts drives its own captions.
    function onTranscriptionReceived(segments: TranscriptionSegment[], participant?: Participant) {
      try {
        if (!participant?.isLocal) return;
        for (const seg of segments) {
          if (!seg.final) {
            if (armedRef.current && !capturedThisTurnRef.current) {
              capturedThisTurnRef.current = true;
              void captureAndSend("turn");
            }
          } else {
            capturedThisTurnRef.current = false;
          }
        }
      } catch (err) {
        logError("useScreenSight: onTranscriptionReceived", err);
      }
    }

    room.on(RoomEvent.DataReceived, onDataReceived);
    room.on(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
      room.off(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
    };
  }, [room, captureAndSend]);

  return { armed, toggleArmed };
}
