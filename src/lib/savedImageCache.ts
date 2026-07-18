import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";
import type { RawScreenSave } from "./dashboardApi";

/**
 * Frontend half of the encrypted local image cache for the Saved page. The
 * Rust side (saved_images.rs) downloads, encrypts, decrypts, and prunes; this
 * module orchestrates it and owns the object-URL lifecycle.
 *
 * Rendering from these local blobs instead of the signed `image_url` is the
 * point: once an item is cached the page never depends on a fresh signed URL
 * again, so Saved works offline and stops flashing blank when a URL expires.
 */

// item_id -> object URL of the decrypted image. Module-scoped so re-opening the
// Saved page within a session reuses blobs instead of re-decrypting over IPC.
const objectUrls = new Map<string, string>();

/** Reads an already-cached image off disk (decrypt in Rust) into a blob URL.
 * Returns null when nothing is cached yet - the expected offline-first-view
 * and pre-download cases, not an error. */
async function readCachedImage(itemId: string): Promise<string | null> {
  try {
    const raw = await invoke<ArrayBuffer>("read_saved_image", { itemId });
    const url = URL.createObjectURL(new Blob([new Uint8Array(raw)], { type: "image/jpeg" }));
    objectUrls.set(itemId, url);
    return url;
  } catch {
    return null;
  }
}

/** Ensures one save has a local encrypted copy: reuse an in-memory blob, else
 * read an on-disk copy, else (only with a live signed URL) download+encrypt and
 * read it back. */
async function ensureLocalImage(save: RawScreenSave): Promise<void> {
  const { item_id: itemId, image_url: imageUrl } = save;
  if (objectUrls.has(itemId)) return;
  if (await readCachedImage(itemId)) return;
  if (!imageUrl) return; // offline first view: nothing to download from
  try {
    const cached = await invoke<boolean>("cache_saved_image", { itemId, url: imageUrl });
    if (cached) await readCachedImage(itemId);
  } catch (err) {
    logError("savedImageCache: cache", err);
  }
}

/** Ensures each save has a local copy, prunes evicted items on disk and in
 * memory, and returns item_id -> blob URL for everything currently cached.
 * Never throws - a failure just leaves that item without a local copy. */
export async function resolveSavedImages(
  saves: RawScreenSave[],
): Promise<Map<string, string>> {
  await Promise.all(saves.map((save) => ensureLocalImage(save)));

  const keepIds = saves.map((save) => save.item_id);
  try {
    await invoke("prune_saved_images", { keepIds });
  } catch (err) {
    logError("savedImageCache: prune", err);
  }

  // Drop in-memory blobs for anything no longer saved (mirrors the disk prune).
  const keep = new Set(keepIds);
  for (const [id, url] of objectUrls) {
    if (!keep.has(id)) {
      URL.revokeObjectURL(url);
      objectUrls.delete(id);
    }
  }

  const resolved = new Map<string, string>();
  for (const id of keepIds) {
    const url = objectUrls.get(id);
    if (url) resolved.set(id, url);
  }
  return resolved;
}

/** Revokes every cached object URL. Call on sign-out so one account's decrypted
 * images do not linger in memory for the next. */
export function revokeSavedImages(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}
