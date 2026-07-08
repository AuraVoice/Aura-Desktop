import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, type Participant, type TranscriptionSegment } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError } from "../lib/log";
import type { VoiceSessionStatus } from "./useVoiceBar";

interface ScreenFrameGeometry {
  monitorLeftPx: number;
  monitorTopPx: number;
  monitorWidthPx: number;
  monitorHeightPx: number;
  scaleFactor: number;
  jpegWidthPx: number;
  jpegHeightPx: number;
}

interface ElementPointEvent {
  type: string;
  payload?: Record<string, unknown>;
}

const RETAINED_FRAME_GEOMETRY_COUNT = 4;

// How long the "Saved to X" confirmation stays in the bar's caption before
// yielding back to the normal assistant caption.
const SAVED_CONFIRMATION_DURATION_MS = 3500;

// Must match `GEOMETRY_HEADER_LEN` and `ScreenFrameGeometry::write_le` in
// screenshot.rs - 7 little-endian 4-byte fields ahead of the raw JPEG bytes.
const GEOMETRY_HEADER_LEN = 4 * 7;

function isSessionLive(status: VoiceSessionStatus): boolean {
  return status === "ready" || status === "listening" || status === "processing" || status === "speaking";
}

function isTerminalStatus(status: VoiceSessionStatus): boolean {
  return status === "disconnected" || status === "ended" || status === "error";
}

// invoke() only delivers a real ArrayBuffer while Tauri's custom-protocol IPC
// channel is alive. A single failed fetch on that channel (a CSP connect-src
// missing "ipc: http://ipc.localhost" did exactly this in the 0.1.4 build)
// latches the whole session onto Tauri's postMessage fallback, where a raw
// tauri::ipc::Response gets JSON-serialized into a plain number array instead.
// Normalize the transport's shapes rather than handing DataView something it
// throws on - see lessons-learnt.txt, 2026-07-07.
function asArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]).buffer;
  throw new Error(`capture returned ${Object.prototype.toString.call(raw)}, expected binary`);
}

function parseCapturedFrame(buffer: ArrayBuffer): { geometry: ScreenFrameGeometry; bytes: Uint8Array } {
  const view = new DataView(buffer);
  const geometry: ScreenFrameGeometry = {
    monitorLeftPx: view.getInt32(0, true),
    monitorTopPx: view.getInt32(4, true),
    monitorWidthPx: view.getUint32(8, true),
    monitorHeightPx: view.getUint32(12, true),
    scaleFactor: view.getFloat32(16, true),
    jpegWidthPx: view.getUint32(20, true),
    jpegHeightPx: view.getUint32(24, true),
  };
  return { geometry, bytes: new Uint8Array(buffer, GEOMETRY_HEADER_LEN) };
}

/** Maps a JPEG-space point back onto the real screen - port of `logicalPointFor`. */
function screenPointFor(geometry: ScreenFrameGeometry, jpegX: number, jpegY: number) {
  const clampedX = Math.min(Math.max(jpegX, 0), geometry.jpegWidthPx);
  const clampedY = Math.min(Math.max(jpegY, 0), geometry.jpegHeightPx);
  const physicalX = geometry.monitorLeftPx + clampedX * (geometry.monitorWidthPx / geometry.jpegWidthPx);
  const physicalY = geometry.monitorTopPx + clampedY * (geometry.monitorHeightPx / geometry.jpegHeightPx);
  return {
    x: physicalX / geometry.scaleFactor,
    y: physicalY / geometry.scaleFactor,
    monitorX: geometry.monitorLeftPx / geometry.scaleFactor,
    monitorY: geometry.monitorTopPx / geometry.scaleFactor,
    monitorWidth: geometry.monitorWidthPx / geometry.scaleFactor,
    monitorHeight: geometry.monitorHeightPx / geometry.scaleFactor,
  };
}

/**
 * Push-to-look, never ambient: the user arms this per session (hotkey or eye
 * button), one frame goes out on arm and one at the start of each spoken
 * turn. Direct port of `screen_sight_service.dart`, translated onto the real
 * LiveKit signals it actually listens to (its own already-translated event
 * stream) rather than the raw wire protocol.
 */
export function useScreenSight(room: Room | null, status: VoiceSessionStatus) {
  const [armed, setArmed] = useState(false);
  const [savedConfirmation, setSavedConfirmation] = useState<string | null>(null);
  const capturedThisTurnRef = useRef(false);
  const sessionReadyCapturedRef = useRef(false);
  const frameCounterRef = useRef(0);
  const sentGeometryRef = useRef<Map<string, ScreenFrameGeometry>>(new Map());
  const savedConfirmationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const toggleArmed = useCallback(() => {
    if (armedRef.current) {
      disarm();
      return;
    }
    setArmed(true);
    capturedThisTurnRef.current = false;
    if (isSessionLive(status)) void captureAndSend("armed");
  }, [status, disarm, captureAndSend]);

  // Ctrl+Alt+S, forwarded from Rust as a plain event (arm/disarm state lives
  // here in JS, not in Rust).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("screen-sight-hotkey", () => toggleArmed())
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("useScreenSight: listen screen-sight-hotkey", err));
    return () => unlisten?.();
  }, [toggleArmed]);

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

    function handleElementPoint(event: ElementPointEvent) {
      try {
        const payload = event.payload;
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

    // Backend confirmation that a screen_save.created write landed (see
    // save_screen_item on the voice agent) - surfaced as a brief caption in
    // the bar, not tied to capture/send in any way.
    function handleScreenSaveCreated(event: ElementPointEvent) {
      const payload = event.payload;
      const collectionName = typeof payload?.collection_name === "string" ? payload.collection_name.trim() : "";
      const title = typeof payload?.title === "string" ? payload.title.trim() : "";
      const label = collectionName ? `Saved to ${collectionName}` : title ? `Saved "${title}"` : "Saved";
      if (savedConfirmationTimeoutRef.current) clearTimeout(savedConfirmationTimeoutRef.current);
      setSavedConfirmation(label);
      savedConfirmationTimeoutRef.current = setTimeout(() => {
        savedConfirmationTimeoutRef.current = null;
        setSavedConfirmation(null);
      }, SAVED_CONFIRMATION_DURATION_MS);
    }

    // Only genuinely real messages on this data channel that useScreenSight
    // cares about - session.ready/user.text.*/session.ended never arrive
    // (see useVoiceBar.ts), element.point and screen_save.created do.
    function onDataReceived(payload: Uint8Array) {
      try {
        const event = JSON.parse(new TextDecoder().decode(payload)) as ElementPointEvent;
        if (event.type === "element.point") handleElementPoint(event);
        else if (event.type === "screen_save.created") handleScreenSaveCreated(event);
      } catch {
        // not JSON - not one of ours, ignore
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
      if (savedConfirmationTimeoutRef.current) clearTimeout(savedConfirmationTimeoutRef.current);
    };
  }, [room, captureAndSend]);

  return { armed, toggleArmed, savedConfirmation };
}
