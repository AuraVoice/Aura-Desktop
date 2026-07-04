import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
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

interface VoiceServerEvent {
  type: string;
  payload?: Record<string, unknown>;
}

const RETAINED_FRAME_GEOMETRY_COUNT = 4;

// Must match `GEOMETRY_HEADER_LEN` and `ScreenFrameGeometry::write_le` in
// screenshot.rs - 7 little-endian 4-byte fields ahead of the raw JPEG bytes.
const GEOMETRY_HEADER_LEN = 4 * 7;

function isSessionLive(status: VoiceSessionStatus): boolean {
  return status === "ready" || status === "listening" || status === "processing" || status === "speaking";
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
 * turn. Direct port of `screen_sight_service.dart`.
 */
export function useScreenSight(room: Room | null, status: VoiceSessionStatus) {
  const [armed, setArmed] = useState(false);
  const capturedThisTurnRef = useRef(false);
  const frameCounterRef = useRef(0);
  const sentGeometryRef = useRef<Map<string, ScreenFrameGeometry>>(new Map());
  const armedRef = useRef(armed);
  armedRef.current = armed;

  const captureAndSend = useCallback(
    async (reason: string) => {
      if (!armedRef.current || !room) return;
      let buffer: ArrayBuffer;
      try {
        buffer = await invoke<ArrayBuffer>("capture_cursor_display_with_geometry");
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

  useEffect(() => {
    if (!room) return;

    function handleEvent(event: VoiceServerEvent) {
      switch (event.type) {
        case "session.ready":
          if (armedRef.current) void captureAndSend("session.ready");
          break;
        case "user.text.delta":
          if (armedRef.current && !capturedThisTurnRef.current) {
            capturedThisTurnRef.current = true;
            void captureAndSend("turn");
          }
          break;
        case "user.text.final":
          capturedThisTurnRef.current = false;
          break;
        case "element.point": {
          const payload = event.payload;
          const x = payload?.x;
          const y = payload?.y;
          if (typeof x !== "number" || typeof y !== "number") break;
          const frameId = typeof payload?.frame_id === "string" ? payload.frame_id : "";
          const values = Array.from(sentGeometryRef.current.values());
          const geometry = sentGeometryRef.current.get(frameId) ?? values[values.length - 1];
          if (!geometry) break;
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
          break;
        }
        case "session.ended":
        case "error":
        case "session.error":
          disarm();
          break;
        default:
          break;
      }
    }

    function onDataReceived(payload: Uint8Array) {
      try {
        handleEvent(JSON.parse(new TextDecoder().decode(payload)));
      } catch {
        // not JSON - not one of ours, ignore
      }
    }

    room.on(RoomEvent.DataReceived, onDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room, captureAndSend, disarm]);

  return { armed, toggleArmed };
}
