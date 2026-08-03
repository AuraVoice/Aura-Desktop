/**
 * Structured screen context: the accessibility-tree alternative to a screenshot.
 *
 * The Rust side (`src-tauri/src/uia/`) reads the focused element and a bounded
 * slice of its neighbourhood through Windows UI Automation, redacts protected
 * values, and returns the snapshot below. When the snapshot can answer the turn
 * on its own, this file streams it to the voice agent and NO screenshot is
 * taken: no capture, no resize, no JPEG encode, no megabyte upload, no vision
 * tokens.
 *
 * The contract is mirrored in three places and all three must agree:
 *   - `src-tauri/src/uia/contract.rs`                    (producer)
 *   - this file                                          (transport)
 *   - `backend/src/agent/voice/screen_context_stream.py`  (consumer)
 * `SCREEN_CONTEXT_SCHEMA_VERSION` is what lets the consumer reject a payload it
 * does not understand instead of guessing at it.
 *
 * Note the topic name also exists as a data-channel *message type* on the
 * mobile keyboard path. Byte-stream topics and data-channel message types are
 * separate namespaces, so they do not collide, but they are different contracts
 * and should not be conflated.
 */
import type { Room } from "livekit-client";

/** Byte-stream topic. Must match `SCREEN_CONTEXT_TOPIC` on the backend. */
export const SCREEN_CONTEXT_TOPIC = "screen_context";

export const SCREEN_CONTEXT_SCHEMA_VERSION = 1;

/**
 * Closed vocabulary. Adding a value here means adding it on the backend too,
 * or the payload is rejected.
 */
export type ScreenContextQualityReason =
  | "structured_ok"
  | "no_focus_element"
  | "empty_tree"
  | "visual_only_surface"
  | "capture_timeout"
  | "bounds_exceeded"
  | "guide_requires_pixels"
  | "uia_unavailable";

export type ScreenContextBound = "depth" | "node_count" | "bytes" | "duration";

export interface UiNode {
  id: string;
  runtime_id?: string;
  automation_id?: string;
  role: string;
  name?: string;
  /** Absent whenever `redacted` is true. A password value never reaches here. */
  value?: string;
  states?: string[];
  /** Physical screen pixels: [left, top, width, height]. */
  rect: [number, number, number, number];
  redacted: boolean;
}

export interface StructuredScreenContext {
  schema_version: number;
  turn_context_id: string;
  captured_at_ms: number;
  /** How long the UI Automation walk took, reported as `ui_automation_ms`. */
  capture_ms: number;
  app: { process: string; window_id: string; window_title: string };
  focus?: UiNode;
  ancestors: UiNode[];
  siblings: UiNode[];
  descendants: UiNode[];
  quality: {
    sufficient: boolean;
    reason: ScreenContextQualityReason;
    text_nodes: number;
    text_chars: number;
  };
  bounds_hit: ScreenContextBound[];
}

export interface ScreenContextUploadTiming {
  bytes: number;
  streamOpenMs: number;
  streamWriteMs: number;
  streamCloseMs: number;
}

/**
 * A turn correlation id: 32 lowercase hex characters, matching the shape Guide
 * Mode already uses for its session ids.
 *
 * One id is minted per speaking turn and stamped on BOTH the structured context
 * and any screenshot for that turn. It is what lets the backend tell "the
 * context for this turn" from "context still inside the freshness window that a
 * previous turn already consumed", and what correlates the desktop's stage
 * timings with the backend's without ever comparing clocks across machines.
 */
export function newTurnContextId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Streams one structured snapshot to the voice agent.
 *
 * Returns the transport timings. Throws on failure so the caller can decide
 * whether to fall back to pixels; it never retries, because a turn that has
 * already moved on is not helped by a duplicate delivery.
 */
export async function publishScreenContext(
  room: Room,
  context: StructuredScreenContext,
): Promise<ScreenContextUploadTiming> {
  const bytes = new TextEncoder().encode(JSON.stringify(context));

  const openedAt = performance.now();
  const writer = await room.localParticipant.streamBytes({
    topic: SCREEN_CONTEXT_TOPIC,
    mimeType: "application/json",
    totalSize: bytes.length,
    attributes: {
      turn_context_id: context.turn_context_id,
      schema_version: String(context.schema_version),
      captured_at_ms: String(context.captured_at_ms),
      sufficient: context.quality.sufficient ? "1" : "0",
      quality_reason: context.quality.reason,
    },
  });
  const wroteAt = performance.now();
  await writer.write(bytes);
  const flushedAt = performance.now();
  await writer.close();

  return {
    bytes: bytes.length,
    streamOpenMs: Math.round(wroteAt - openedAt),
    streamWriteMs: Math.round(flushedAt - wroteAt),
    streamCloseMs: Math.round(performance.now() - flushedAt),
  };
}
