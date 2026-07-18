import { load, type Store } from "@tauri-apps/plugin-store";
import { logError } from "./log";

/**
 * Bounded, versioned local-disk cache for dashboard resources, backed by a
 * single @tauri-apps/plugin-store file. Exactly one snapshot per key (latest
 * wins) - never an append log - so the file stays small and predictable.
 *
 * Two disciplines keep disk I/O minimal:
 *  - Change-detected writes: a cheap FNV-1a hash of the payload is compared to
 *    the last-written hash for that key; an unchanged revalidate skips the
 *    write (and the save) entirely.
 *  - Version guard: an envelope whose schema version does not match is treated
 *    as a miss, so a shape change across app updates can never crash a read.
 *
 * Ephemeral fields (e.g. screen-save signed image URLs) must be stripped by the
 * caller before writeCache; this layer persists exactly what it is given.
 */

const STORE_FILE = "dashboard-cache.v1.json";
const SCHEMA_VERSION = 1;

interface CacheEnvelope<T> {
  v: number;
  data: T;
  cachedAt: number;
  hash: string;
}

export interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

let storeRef: Store | null = null;
const lastHash = new Map<string, string>();

async function getStore(): Promise<Store> {
  return storeRef ?? (storeRef = await load(STORE_FILE));
}

/** FNV-1a 32-bit over the JSON form - fast, allocation-light, good enough to
 * detect "did this payload change" for write-skipping. */
function hashPayload(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export async function readCache<T>(key: string): Promise<CacheEntry<T> | null> {
  try {
    const store = await getStore();
    const env = await store.get<CacheEnvelope<T>>(key);
    if (!env || env.v !== SCHEMA_VERSION || typeof env.cachedAt !== "number") {
      return null;
    }
    // Seed the write-skip guard so an unchanged first write this session is a
    // no-op even though we never wrote it ourselves yet.
    lastHash.set(key, env.hash);
    return { data: env.data, cachedAt: env.cachedAt };
  } catch (err) {
    logError(`dashboardCache: read ${key}`, err);
    return null;
  }
}

/** Persists `data` under `key` with `cachedAt`. Skips the write when the
 * payload hash is unchanged from the last known value for this key. */
export async function writeCache<T>(key: string, data: T, cachedAt: number): Promise<void> {
  try {
    const hash = hashPayload(data);
    if (lastHash.get(key) === hash) return;
    const store = await getStore();
    const env: CacheEnvelope<T> = { v: SCHEMA_VERSION, data, cachedAt, hash };
    await store.set(key, env);
    await store.save();
    lastHash.set(key, hash);
  } catch (err) {
    logError(`dashboardCache: write ${key}`, err);
  }
}
