import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CAPTURE_STAGES } from "../lib/ipcEvents";
import {
  Room,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  type TranscriptionSegment,
} from "livekit-client";
import { validateAgentDataMessage } from "../lib/agentData";
import { trackEvent } from "../lib/analytics";
import { logError } from "../lib/log";
import {
  newTurnContextId,
  publishScreenContext,
  type StructuredScreenContext,
} from "../lib/screenContext";
import {
  asArrayBuffer,
  parseCapturedFrame,
  screenPointFor,
  type ScreenFrameGeometry,
} from "../lib/screenFrame";

const RETAINED_FRAME_GEOMETRY_COUNT = 4;
const NOTICE_DURATION_MS = 3500;

/** Stage timings emitted by Rust just before a capture command returns. */
interface CaptureStages {
  turnContextId: string;
  nativeCaptureMs: number;
  resizeMs: number;
  jpegEncodeMs: number;
  persistenceEnqueueMs: number;
  jpegBytesAfter: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  jpegWidthPx: number;
  jpegHeightPx: number;
  resized: boolean;
}

/** Which kind of context this turn actually sent. */
type ContextStrategy = "structured" | "pixels" | "both" | "none";

/**
 * Utterances the accessibility tree cannot answer, so pixels must be sent even
 * when the structured snapshot calls itself sufficient.
 *
 * The tree names controls; it does not carry rendered text in a canvas, an
 * image, a video frame, a PDF, or a screenshot the user is looking at, and it
 * cannot describe layout or colour. "Read this error for me" over a terminal
 * pane is the motivating case: `finish_quality` happily declares the window
 * sufficient and the user gets told Buddy cannot see their screen.
 *
 * Matched against a LIVE interim transcript, so patterns must hit on partial
 * text and stay narrow: a false positive costs a screenshot's tokens on a turn
 * that did not need one (see the vision-token note in prompts.py).
 */
const PIXEL_INTENT_PATTERN =
  /\b(read|look at|looking at|see this|seeing|show(?:ing)? you|what does (?:this|it|that) say|what'?s (?:this|that|on (?:my|the) screen)|screenshot|colou?r|highlighted|this (?:image|picture|photo|chart|graph|diagram|error))\b/i;

function wantsPixels(transcript: string): boolean {
  return PIXEL_INTENT_PATTERN.test(transcript);
}
export function useTurnScreenCapture(room: Room | null, guideArmed = false) {
  const [notice, setNotice] = useState<string | null>(null);
  const capturedThisTurnRef = useRef(false);
  const pixelsSentThisTurnRef = useRef(false);
  const frameCounterRef = useRef(0);
  const sentGeometryRef = useRef<Map<string, ScreenFrameGeometry>>(new Map());
  const activeRoomRef = useRef<Room | null>(room);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureStagesRef = useRef<CaptureStages | null>(null);
  activeRoomRef.current = room;

  // Rust emits its own stage timings rather than widening the 28-byte geometry
  // header, which is mirrored in three DataView readers and the Guide envelope.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<CaptureStages>(CAPTURE_STAGES, (event) => {
      captureStagesRef.current = event.payload;
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((err) => logError("useTurnScreenCapture: capture-stages listen", err));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const showNotice = useCallback((message: string) => {
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    setNotice(message);
    noticeTimeoutRef.current = setTimeout(() => {
      noticeTimeoutRef.current = null;
      setNotice(null);
    }, NOTICE_DURATION_MS);
  }, []);

  /**
   * Sends this turn's screen context, structured-first.
   *
   * Order matters. UI Automation runs first because it is bounded, fast and
   * usually enough: for an accessible surface the tree already says what the
   * user is looking at, so the screenshot is skipped entirely. Pixels are the
   * fallback, taken whenever the structured snapshot is insufficient OR
   * anything at all went wrong, so screen awareness degrades to exactly the
   * previous behaviour rather than quietly getting worse.
   *
   * `transcript` is the live interim text of the turn so far. When it asks for
   * something only pixels can answer (`wantsPixels`), structured-sufficient no
   * longer short-circuits the screenshot: the tree is still published, and the
   * picture rides along as strategy "both".
   */
  const captureAndSend = useCallback(async (transcript = "") => {
    if (!room || guideArmed) return;
    const pixelIntent = wantsPixels(transcript);
    const captureRoom = room;
    const turnContextId = newTurnContextId();
    let strategy: ContextStrategy = "none";
    let fallbackReason = "";
    let uiAutomationMs = 0;
    let structuredContextBytes = 0;

    let structured: StructuredScreenContext | null = null;
    try {
      structured = await invoke<StructuredScreenContext>("capture_structured_context", {
        turnContextId,
      });
      uiAutomationMs = structured.capture_ms;
    } catch (err) {
      // Never fatal: a machine without working UI Automation just uses pixels.
      logError("useTurnScreenCapture: structured context", err);
      fallbackReason = "uia_unavailable";
    }
    if (activeRoomRef.current !== captureRoom) return;

    if (structured && structured.quality.sufficient && !pixelIntent) {
      try {
        const timing = await publishScreenContext(captureRoom, structured);
        structuredContextBytes = timing.bytes;
        strategy = "structured";
        trackEvent("turn_context_upload", {
          turnContextId,
          contextStrategy: "structured",
          uiAutomationMs,
          structuredContextBytes,
          livekitStreamOpenMs: timing.streamOpenMs,
          livekitStreamWriteMs: timing.streamWriteMs,
          livekitStreamCloseMs: timing.streamCloseMs,
        });
        return;
      } catch (err) {
        // The turn continues without it. No retry: a duplicate delivery cannot
        // help a turn that has already moved on.
        logError("useTurnScreenCapture: publish context", err);
        fallbackReason = "context_upload_failed";
      }
    } else if (structured && !fallbackReason) {
      // A sufficient tree that we deliberately fell through is not a quality
      // failure, and logging it as one would hide the real reason for the cost.
      fallbackReason = pixelIntent ? "pixel_intent" : structured.quality.reason;
    }

    const ipcStartedAt = performance.now();
    let buffer: ArrayBuffer;
    try {
      buffer = asArrayBuffer(
        await invoke("capture_turn_screen_with_geometry", { turnContextId }),
      );
    } catch (err) {
      logError("useTurnScreenCapture: capture", err);
      showNotice("Couldn't capture this turn.");
      return;
    }
    const ipcReturnMs = Math.round(performance.now() - ipcStartedAt);

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

    // A partial-but-not-empty snapshot still helps the model even when it could
    // not answer alone, so it rides along with the picture rather than being
    // thrown away.
    if (structured && structured.focus && strategy !== "structured") {
      try {
        const timing = await publishScreenContext(captureRoom, structured);
        structuredContextBytes = timing.bytes;
        strategy = "both";
      } catch (err) {
        logError("useTurnScreenCapture: publish partial context", err);
      }
    }

    try {
      const openedAt = performance.now();
      const writer = await room.localParticipant.streamBytes({
        topic: "screen_frame",
        mimeType: "image/jpeg",
        totalSize: bytes.length,
        attributes: {
          frame_id: frameId,
          turn_context_id: turnContextId,
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
      const wroteAt = performance.now();
      await writer.write(bytes);
      const flushedAt = performance.now();
      await writer.close();
      if (strategy !== "both") strategy = "pixels";
      // Records that this turn already has a picture, so a later interim segment
      // matching pixel intent does not queue a redundant second capture.
      pixelsSentThisTurnRef.current = true;
      const stages = captureStagesRef.current;
      trackEvent("turn_context_upload", {
        turnContextId,
        contextStrategy: strategy,
        fallbackReason,
        uiAutomationMs,
        structuredContextBytes,
        ipcReturnMs,
        livekitStreamOpenMs: Math.round(wroteAt - openedAt),
        livekitStreamWriteMs: Math.round(flushedAt - wroteAt),
        livekitStreamCloseMs: Math.round(performance.now() - flushedAt),
        // Forwarded from the Rust `capture-stages` event, matched by turn id so
        // a stale event from an abandoned turn cannot be misattributed.
        ...(stages && stages.turnContextId === turnContextId
          ? {
              nativeCaptureMs: stages.nativeCaptureMs,
              resizeMs: stages.resizeMs,
              jpegEncodeMs: stages.jpegEncodeMs,
              persistenceEnqueueMs: stages.persistenceEnqueueMs,
              jpegBytesAfter: stages.jpegBytesAfter,
              sourcePx: `${stages.sourceWidthPx}x${stages.sourceHeightPx}`,
              jpegPx: `${stages.jpegWidthPx}x${stages.jpegHeightPx}`,
              resized: stages.resized,
            }
          : {}),
      });
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
        if (segment.final) {
          capturedThisTurnRef.current = false;
          pixelsSentThisTurnRef.current = false;
          continue;
        }
        if (!capturedThisTurnRef.current) {
          capturedThisTurnRef.current = true;
          void captureAndSend(segment.text);
        } else if (!pixelsSentThisTurnRef.current && wantsPixels(segment.text)) {
          // The first capture fires on the FIRST interim segment, when the
          // transcript can still be a single word - far too early to tell a
          // pixel-shaped request from any other. So intent is re-checked as the
          // utterance grows, and a structured-only turn can still upgrade to a
          // screenshot before it finalizes. Guarded so this happens at most once
          // per turn; the later frame simply wins on the backend, which keeps
          // one hot image regardless.
          pixelsSentThisTurnRef.current = true;
          void captureAndSend(segment.text);
        }
      }
    }

    room.on(RoomEvent.DataReceived, onDataReceived);
    room.on(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
      room.off(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
      capturedThisTurnRef.current = false;
      pixelsSentThisTurnRef.current = false;
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
