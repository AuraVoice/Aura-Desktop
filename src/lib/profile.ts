import { Store } from "@tauri-apps/plugin-store";
import { authFetch, AuthRequiredError } from "./api";
import { aliasAnonymousToUser, setPersonProperties } from "./analytics";
import {
  desktopAnonIdKey,
  desktopAnonAliasedUidKey,
  desktopProfileSyncedKey,
  desktopRoleKey,
  desktopWhereHeardKey,
  overlayStorePath,
} from "./copy";
import { logError } from "./log";

/** One first-run question answer: the stable option id plus optional freetext
 * from the "other" field. Persisted under desktopWhereHeardKey / desktopRoleKey
 * and read back by the post-sign-in sync. */
export interface StoredAnswer {
  id: string;
  other?: string;
}

/** Returns the per-install anonymous id, generating and persisting one on first
 * call. Used as the PostHog distinct_id for pre-sign-in attribution capture so
 * it can later be aliased to the real uid (never the shared "anonymous"). */
export async function getOrCreateAnonId(store: Store): Promise<string> {
  const existing = await store.get<string>(desktopAnonIdKey);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await store.set(desktopAnonIdKey, id);
  return id;
}

/** Persists first-run attribution answers to the backend user profile.
 * Fail-soft: the endpoint may not exist yet, so any failure only logs and
 * returns false - onboarding never blocks on it. Returns true only on 2xx. */
export async function syncProfileToBackend(profile: {
  whereHeard?: StoredAnswer;
  role?: StoredAnswer;
}): Promise<boolean> {
  try {
    const response = await authFetch("/devices/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        where_heard: profile.whereHeard?.id ?? null,
        where_heard_other: profile.whereHeard?.other ?? null,
        role: profile.role?.id ?? null,
        role_other: profile.role?.other ?? null,
      }),
    });
    if (!response.ok) {
      logError("profile: syncProfileToBackend", `HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // AuthRequiredError should never reach here (callers only run this after
    // sign-in), but treat it like any other failure: log, don't throw.
    if (err instanceof AuthRequiredError) {
      logError("profile: syncProfileToBackend", "called without a signed-in user");
      return false;
    }
    logError("profile: syncProfileToBackend", err);
    return false;
  }
}

/** Runs once after sign-in: merges the anonymous PostHog person into the uid,
 * re-sets the attribution properties on the uid person, and POSTs them to the
 * backend profile. Guarded by desktop_profile_synced so it's a no-op on every
 * later launch.
 *
 * The synced flag is set once the PostHog work is dispatched (the signal-gate
 * critical path), not gated on the backend write. The backend endpoint is a
 * fail-soft cross-repo dependency that may not exist yet; blocking the flag on
 * its response would re-fire the PostHog alias on every launch for weeks until
 * it ships. Backend sync is best-effort within this one run. */
export async function syncProfileOnSignIn(uid: string): Promise<void> {
  let store: Store;
  try {
    store = await Store.load(overlayStorePath);
  } catch (err) {
    logError("profile: syncProfileOnSignIn load store", err);
    return;
  }

  const anonId = await store.get<string>(desktopAnonIdKey);
  const aliasedUid = await store.get<string>(desktopAnonAliasedUidKey);
  if (anonId && aliasedUid !== uid && await aliasAnonymousToUser(anonId, uid)) {
    await store.set(desktopAnonAliasedUidKey, uid).catch((err) =>
      logError("profile: persist aliased uid", err),
    );
  }

  const alreadySynced = await store.get<boolean>(desktopProfileSyncedKey);
  if (alreadySynced) return;

  const whereHeard = await store.get<StoredAnswer>(desktopWhereHeardKey);
  const role = await store.get<StoredAnswer>(desktopRoleKey);

  // A user who onboarded before this feature existed has no answers to sync.
  // Mark done so we don't re-read the store on every future launch.
  if (!whereHeard && !role) {
    await store.set(desktopProfileSyncedKey, true).catch((err) =>
      logError("profile: mark synced (no answers)", err),
    );
    return;
  }

  const props: Record<string, unknown> = {};
  if (whereHeard) {
    props.where_heard = whereHeard.id;
    if (whereHeard.other) props.where_heard_other = whereHeard.other;
  }
  if (role) {
    props.role = role.id;
    if (role.other) props.role_other = role.other;
  }
  setPersonProperties(props, uid);

  // Best-effort backend write; failure never blocks the synced flag (see doc).
  await syncProfileToBackend({ whereHeard, role });

  await store.set(desktopProfileSyncedKey, true).catch((err) =>
    logError("profile: mark synced", err),
  );
}
