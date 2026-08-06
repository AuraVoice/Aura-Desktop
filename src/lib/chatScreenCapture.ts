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

/** width u32 | height u32 | captured_at_ms i64, all little-endian. */
export const CHAT_CAPTURE_HEADER_LEN = 4 + 4 + 8;

/** What /chat accepts, matching `_validate_and_filter_attachments` on the
 * backend exactly. Any drift here is a 422 the user sees as a failed send. */
export interface ChatAttachment {
  type: "image";
  mime_type: string;
  file_name: string;
  /** Base64, no data-URL prefix. */
  data: string;
}

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

/**
 * Base64 without touching the call stack. `String.fromCharCode(...bytes)` on a
 * 200 KB frame spreads 200k arguments and throws; a chunked loop works but
 * blocks. FileReader does the encode natively and hands it back on a task.
 */
export function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("chat capture could not be encoded"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("chat capture read failed"));
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
  });
}

export function screenAttachment(data: string): ChatAttachment {
  return {
    type: "image",
    mime_type: "image/jpeg",
    file_name: "screen.jpg",
    data,
  };
}
