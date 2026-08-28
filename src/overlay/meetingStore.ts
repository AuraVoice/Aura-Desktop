import { load, type Store } from "@tauri-apps/plugin-store";

/** The one calendar-state store file, written by BOTH useMeetings
 * (dismissed / auto-summoned snoozes) and useMeetingArm (arm state). The
 * shared constant is the contract: renaming the file in one writer would
 * silently fork the data. */
export const CALENDAR_STORE = "calendar.json";

/** Namespaces a key by Firebase uid, so per-person state (recording consent,
 * snoozes) never leaks across accounts on a shared Windows profile. */
export function scopedKey(base: string, uid: string): string {
  return `${base}:${uid}`;
}

/** id -> local date string. An entry is only meaningful for the day (or the
 * bounded window) it was written in; the prune helpers keep maps bounded. */
export type IdDateMap = Record<string, string>;

export function prunedToToday(map: IdDateMap | undefined, today: string): IdDateMap {
  if (!map) return {};
  const next: IdDateMap = {};
  for (const [id, date] of Object.entries(map)) {
    if (date === today) next[id] = date;
  }
  return next;
}

/** One lazy handle per store file. plugin-store dedups handles natively;
 * this just spares each hook its own ref + load ceremony. */
export function lazyStore(file: string): () => Promise<Store> {
  let pending: Promise<Store> | null = null;
  return () => (pending ??= load(file));
}
