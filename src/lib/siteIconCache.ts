import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";

/**
 * Frontend half of the favicon cache for research source chips. The Rust side
 * (site_icons.rs) downloads, stores, and prunes; this module owns the
 * object-URL lifecycle and the in-session dedupe.
 *
 * Icons arrive as raw bytes over binary IPC rather than a remote URL because
 * the app's CSP only allows images from 'self', data: and blob:. A chip that
 * has no icon is not an error - the caller draws a coloured monogram instead.
 */

// host -> object URL. Module-scoped so moving between the Interview and
// Research pages within a session reuses blobs instead of re-reading over IPC.
const objectUrls = new Map<string, string>();
// Hosts already known to have no icon, so a monogram-only host is asked for
// once per session rather than once per chip.
const missing = new Set<string>();
// A progress panel renders the same host several times at once; every extra
// render awaits the first request instead of starting its own.
const inFlight = new Map<string, Promise<string | null>>();

/** Picks the Blob type from the leading bytes. WebView2 chooses its decoder
 * from the type, so an ICO handed over as image/png will not paint. */
function imageMimeType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01) return "image/x-icon";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
  if (bytes[0] === 0x3c) return "image/svg+xml"; // '<' opens an <svg> or an <?xml
  return "image/png";
}

async function fetchIcon(host: string): Promise<string | null> {
  try {
    const raw = await invoke<ArrayBuffer>("site_icon", { host });
    const bytes = new Uint8Array(raw);
    if (bytes.length === 0) {
      missing.add(host);
      return null;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: imageMimeType(bytes) }));
    objectUrls.set(host, url);
    return url;
  } catch (err) {
    logError("siteIconCache: fetch", err);
    missing.add(host);
    return null;
  }
}

/** Resolves one host's favicon to a blob URL, or null when it has none.
 * Never throws: a missing icon is the expected case, not a failure. */
export function siteIcon(host: string): Promise<string | null> {
  const cached = objectUrls.get(host);
  if (cached) return Promise.resolve(cached);
  if (missing.has(host)) return Promise.resolve(null);
  const pending = inFlight.get(host);
  if (pending) return pending;

  const request = fetchIcon(host).finally(() => inFlight.delete(host));
  inFlight.set(host, request);
  return request;
}

/** Asks Rust to keep the on-disk icon cache bounded. Fire and forget from a
 * page mount; a failure here has no user-visible effect. */
export function pruneSiteIcons(): void {
  void invoke("prune_site_icons").catch((err) => logError("siteIconCache: prune", err));
}
