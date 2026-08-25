import { load, type Store } from "@tauri-apps/plugin-store";
import { logError } from "./log";

/**
 * Bounded, versioned local-disk cache for dashboard resources, backed by a
 * single @tauri-apps/plugin-store file. Exactly one snapshot per key (latest
 * wins) - never an append log - so the file stays small and predictable.
 *
 * Two disciplines keep disk I/O minimal:
 *  - One latest snapshot per account-scoped resource key, never an append log.
 *    Successful validation always advances `cachedAt`, even when the payload
 *    is unchanged, so a restart does not trigger an avoidable backend read.
 *  - Version guard: an envelope whose schema version does not match is treated
 *    as a miss, so a shape change across app updates can never crash a read.
 *
 * Ephemeral fields (e.g. screen-save signed image URLs) must be stripped by the
 * caller before writeCache; this layer persists exactly what it is given.
 */

const STORE_FILE = "dashboard-cache.v1.json";
const SCHEMA_VERSION = 1;
const ACCOUNT_PREFIX = "uid:";

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

async function getStore(): Promise<Store> {
  if (storeRef) return storeRef;
  const store = await load(STORE_FILE);
  const legacyKeys = (await store.keys()).filter((key) => !key.startsWith(ACCOUNT_PREFIX));
  if (legacyKeys.length > 0) {
    await Promise.all(legacyKeys.map((key) => store.delete(key)));
    await store.save();
  }
  storeRef = store;
  return store;
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

function accountPrefix(uid: string): string {
  return `${ACCOUNT_PREFIX}${encodeURIComponent(uid)}:`;
}

export function dashboardCacheKey(uid: string, key: string): string {
  return `${accountPrefix(uid)}${key}`;
}

export async function readCache<T>(key: string): Promise<CacheEntry<T> | null> {
  try {
    const store = await getStore();
    const env = await store.get<CacheEnvelope<T>>(key);
    if (!env || env.v !== SCHEMA_VERSION || typeof env.cachedAt !== "number") {
      return null;
    }
    return { data: env.data, cachedAt: env.cachedAt };
  } catch (err) {
    logError(`dashboardCache: read ${key}`, err);
    return null;
  }
}

/** Persists `data` under `key` with the latest successful validation time. */
export async function writeCache<T>(key: string, data: T, cachedAt: number): Promise<boolean> {
  try {
    const hash = hashPayload(data);
    const store = await getStore();
    const env: CacheEnvelope<T> = { v: SCHEMA_VERSION, data, cachedAt, hash };
    await store.set(key, env);
    await store.save();
    return true;
  } catch (err) {
    logError(`dashboardCache: write ${key}`, err);
    return false;
  }
}

export async function deleteCache(key: string): Promise<void> {
  try {
    const store = await getStore();
    await store.delete(key);
    await store.save();
  } catch (err) {
    logError(`dashboardCache: delete ${key}`, err);
  }
}

/** Removes one account's private dashboard snapshots on explicit sign-out. */
export async function clearDashboardCache(uid: string | null): Promise<void> {
  if (!uid) return;
  const prefix = accountPrefix(uid);
  try {
    const store = await getStore();
    const keys = (await store.keys()).filter((key) => key.startsWith(prefix));
    if (keys.length === 0) return;
    await Promise.all(keys.map((key) => store.delete(key)));
    await store.save();
  } catch (err) {
    logError("dashboardCache: clear account", err);
  }
}
