/**
 * The text chat's screen context: transport for the frame Rust captures the
 * moment the chat hotkey fires.
 *
 * The frame never travels as JSON. `take_chat_capture` answers with a 16-byte
 * little-endian header followed by the raw JPEG, mirroring the geometry-header
 * convention in screenFrame.ts, because Tauri serializes a `Vec<u8>` field as a
 * JSON array of numbers - a 200 KB frame would arrive as roughly 700 KB of text.
 *
 * The layout is mirrored in `screenshot.rs` (`CHAT_CAPTURE_HEADER_LEN`) and both
 * sides must agree.
 */
import { invoke } from "@tauri-apps/api/core";
import { asArrayBuffer } from "./screenFrame";
import { blobToBase64, type ChatAttachment } from "./chatAttachments";

/** width u32 | height u32 | captured_at_ms i64, all little-endian. */
export const CHAT_CAPTURE_HEADER_LEN = 4 + 4 + 8;

/** The wire type now lives with the user-picked attachments; re-exported so
 * every existing importer keeps its path. */
export type { ChatAttachment };

export interface ChatScreenCapture {
  widthPx: number;
  heightPx: number;
  capturedAtMs: number;
  bytes: Uint8Array;
}

export function parseChatCapture(buffer: ArrayBuffer): ChatScreenCapture | null {
  // Empty means nothing is pending, which is a normal answer: the user may have
  // opened chat from the bar rather than the hotkey, or the capture may have
  // been refused because Guide Mode owns the screen.
  if (buffer.byteLength === 0) return null;
  if (buffer.byteLength <= CHAT_CAPTURE_HEADER_LEN) {
    throw new Error(`chat capture was ${buffer.byteLength} bytes, too short to hold a frame`);
  }
  const view = new DataView(buffer);
  return {
    widthPx: view.getUint32(0, true),
    heightPx: view.getUint32(4, true),
    // Milliseconds since the epoch fits in a double well past the year 275760,
    // so narrowing the i64 here loses nothing.
    capturedAtMs: Number(view.getBigInt64(8, true)),
    bytes: new Uint8Array(buffer, CHAT_CAPTURE_HEADER_LEN),
  };
}

export async function takeChatCapture(): Promise<ChatScreenCapture | null> {
  return parseChatCapture(asArrayBuffer(await invoke("take_chat_capture")));
}

export async function refreshChatCapture(): Promise<void> {
  await invoke("refresh_chat_capture");
}

export async function discardChatCapture(): Promise<void> {
  await invoke("discard_chat_capture");
}

/** Kept as the name the capture path already uses; the encoder itself is
 * shared with picked files in chatAttachments.ts. */
export function toBase64(bytes: Uint8Array): Promise<string> {
  return blobToBase64(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
}

export function screenAttachment(data: string): ChatAttachment {
  return {
    type: "image",
    mime_type: "image/jpeg",
    file_name: "screen.jpg",
    data,
  };
}
