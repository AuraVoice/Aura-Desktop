/**
 * Files the user attaches to a text chat message from the composer's "+" menu.
 *
 * Mirrors the mobile app's attachment pipeline
 * (lib/data/services/attachment_processor.dart + attachment_validator.dart):
 * images are recompressed to a 1600px JPEG before they leave the machine, the
 * limits and error strings are the same, and the wire shape is the one the
 * backend's `_validate_and_filter_attachments` (handlers/chat.py) accepts.
 * Anything that drifts from that validator is a 422 the user sees as a failed
 * send, so the MIME lists below are copied from it, not from a browser table.
 */

/** What /chat accepts, matching `_validate_and_filter_attachments` on the
 * backend exactly. Any drift here is a 422 the user sees as a failed send. */
export interface ChatAttachment {
  type: "image" | "document";
  mime_type: string;
  file_name: string;
  /** Base64, no data-URL prefix. */
  data: string;
}

export type ChatAttachmentKind = ChatAttachment["type"];

/** One picked file, prepared and waiting in the composer. `data` is already
 * base64 so sending never has to read the disk again; `previewUrl` is an
 * object URL for the image tile and must be revoked when the row goes away. */
export interface PendingAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
  data: string;
  previewUrl?: string;
}

/** What a sent bubble keeps: enough to draw the tile, never the bytes. */
export interface ChatMessageAttachment {
  fileName: string;
  kind: ChatAttachmentKind;
  previewUrl?: string;
}

export const SUPPORTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const SUPPORTED_DOCUMENT_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "application/rtf",
  "application/epub+zip",
]);

export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** `accept` for the two hidden file inputs. */
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
export const DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.txt,.csv,.tsv,.html,.htm,.rtf,.epub";
/** The Files picker takes everything the backend accepts, images included. */
export const ATTACHMENT_ACCEPT = `${IMAGE_ACCEPT},${DOCUMENT_ACCEPT}`;

/** Windows hands the webview an empty `File.type` for several of these, so the
 * extension is the fallback rather than the exception. */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  rtf: "application/rtf",
  epub: "application/epub+zip",
};

export const ATTACHMENT_ERRORS = {
  tooMany: "Max 5 attachments per message",
  imageTooLarge: "Image must be under 5 MB",
  documentTooLarge: "Document must be under 10 MB",
  unsupported: "Format not supported. Try JPEG, PNG, PDF, DOCX, or TXT",
  totalTooLarge: "Total attachments too large. Remove one and try again",
  unreadable: "That file could not be read. Try again",
} as const;

/** Longest edge after recompression and the JPEG quality, both from mobile. */
const IMAGE_MAX_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 0.85;

export function resolveMimeType(file: File): string {
  const declared = file.type.trim().toLowerCase();
  if (declared) return declared;
  const dot = file.name.lastIndexOf(".");
  const extension = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "";
}

export function kindForMime(mime: string): ChatAttachmentKind | null {
  if (SUPPORTED_IMAGE_MIME.has(mime)) return "image";
  if (SUPPORTED_DOCUMENT_MIME.has(mime)) return "document";
  return null;
}

/** The size and count checks, run BEFORE any bytes are read so a 2 GB video
 * never gets decoded just to be refused. Returns the message to show, or null
 * when the file may be added. */
export function validateAdd(existing: PendingAttachment[], file: File): string | null {
  if (existing.length >= MAX_ATTACHMENTS) return ATTACHMENT_ERRORS.tooMany;
  const kind = kindForMime(resolveMimeType(file));
  if (!kind) return ATTACHMENT_ERRORS.unsupported;
  if (kind === "image" && file.size > MAX_IMAGE_BYTES) return ATTACHMENT_ERRORS.imageTooLarge;
  if (kind === "document" && file.size > MAX_DOCUMENT_BYTES) return ATTACHMENT_ERRORS.documentTooLarge;
  const total = existing.reduce((sum, item) => sum + item.sizeBytes, 0) + file.size;
  if (total > MAX_TOTAL_BYTES) return ATTACHMENT_ERRORS.totalTooLarge;
  return null;
}

/**
 * Base64 without touching the call stack. `String.fromCharCode(...bytes)` on a
 * 200 KB frame spreads 200k arguments and throws; a chunked loop works but
 * blocks. FileReader does the encode natively and hands it back on a task.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("attachment could not be encoded"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("attachment read failed"));
    reader.readAsDataURL(blob);
  });
}

/** Re-encodes any supported image as a JPEG no larger than 1600px on its
 * longest edge, which is what the model sees anyway and keeps a 12 MP phone
 * photo from riding along as 5 MB of base64. A GIF loses its animation here,
 * exactly as it does on mobile. Falls back to the original bytes when the
 * webview cannot decode the file, so an odd PNG still gets sent rather than
 * silently dropped. */
async function downscaleImage(file: File): Promise<{ blob: Blob; mimeType: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { blob: file, mimeType: resolveMimeType(file) };
  }
  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { blob: file, mimeType: resolveMimeType(file) };
    // Transparent PNG pixels would otherwise encode as black in JPEG.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", IMAGE_JPEG_QUALITY),
    );
    if (!blob) return { blob: file, mimeType: resolveMimeType(file) };
    return { blob, mimeType: "image/jpeg" };
  } finally {
    bitmap.close();
  }
}

/** Reads and encodes one already-validated file. The caller owns
 * `previewUrl` from here on. */
export async function prepareAttachment(file: File): Promise<PendingAttachment> {
  const mime = resolveMimeType(file);
  const kind = kindForMime(mime);
  if (!kind) throw new Error(ATTACHMENT_ERRORS.unsupported);
  if (kind === "image") {
    const { blob, mimeType } = await downscaleImage(file);
    return {
      id: crypto.randomUUID(),
      fileName: file.name,
      mimeType,
      sizeBytes: blob.size,
      kind,
      data: await blobToBase64(blob),
      previewUrl: URL.createObjectURL(blob),
    };
  }
  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    mimeType: mime,
    sizeBytes: file.size,
    kind,
    data: await blobToBase64(file),
  };
}

export function toRequestAttachment(pending: PendingAttachment): ChatAttachment {
  return {
    type: pending.kind,
    mime_type: pending.mimeType,
    file_name: pending.fileName,
    data: pending.data,
  };
}

export function toMessageAttachment(pending: PendingAttachment): ChatMessageAttachment {
  return { fileName: pending.fileName, kind: pending.kind, previewUrl: pending.previewUrl };
}

/** "PDF", "DOCX", "TXT": the label on a document tile. */
export function extensionLabel(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot >= 0 ? fileName.slice(dot + 1) : "";
  return (extension || "FILE").toUpperCase().slice(0, 5);
}
