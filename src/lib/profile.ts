import { Store } from "@tauri-apps/plugin-store";
import { authFetch, AuthRequiredError } from "./api";
import { aliasAnonymousToUser, setPersonProperties } from "./analytics";
import { auth as firebaseAuth } from "./firebase";
import {
  desktopAnonIdKey,
  desktopAnonAliasedUidKey,
  desktopProfileSyncedKey,
  desktopRoleKey,
  desktopWhereHeardKey,
  overlayStorePath,
} from "./copy";
import {
  collectDesktopMetadata,
  posthogSafeMetadata,
  type DesktopMetadata,
} from "./desktopMetadata";
import { logError } from "./log";

/** One first-run question answer: the stable option id plus optional freetext
 * from the "other" field. Persisted under desktopWhereHeardKey / desktopRoleKey
 * and read back by the post-sign-in sync. */
export interface StoredAnswer {
  id: string;
  other?: string;
}

export interface DesktopAuthMetadata {
  created_at?: string | null;
  last_login_at?: string | null;
  sign_in_method?: string | null;
  provider_ids?: string[];
  email_verified?: boolean;
}

interface DesktopOnboardingEvent {
  event_id: string;
  event: string;
  occurred_at: string;
  properties: Record<string, unknown>;
}

const desktopPendingEventsKey = "desktop_pending_onboarding_events";
const desktopLastSignInMethodKey = "desktop_last_sign_in_method";
const desktopLastSignInStatusKey = "desktop_last_sign_in_status";
const desktopLastSignInAtKey = "desktop_last_sign_in_at";
const MAX_PENDING_EVENTS = 50;

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

function cleanAnswer(answer: StoredAnswer | undefined): StoredAnswer | undefined {
  if (!answer) return undefined;
  return {
    ...answer,
    other: answer.other?.trim() || undefined,
  };
}

function eventProperties(properties?: Record<string, unknown>): Record<string, unknown> {
  if (!properties) return {};
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    )),
  );
}

async function pendingEvents(store: Store): Promise<DesktopOnboardingEvent[]> {
  const events = await store.get<DesktopOnboardingEvent[]>(desktopPendingEventsKey);
  return Array.isArray(events) ? events : [];
}

async function replacePendingEvents(store: Store, events: DesktopOnboardingEvent[]): Promise<void> {
  await store.set(desktopPendingEventsKey, events.slice(-MAX_PENDING_EVENTS));
}

export async function rememberDesktopSignIn(method: string, status: string): Promise<void> {
  try {
    const store = await Store.load(overlayStorePath);
    await Promise.all([
      store.set(desktopLastSignInMethodKey, method),
      store.set(desktopLastSignInStatusKey, status),
      store.set(desktopLastSignInAtKey, new Date().toISOString()),
    ]);
  } catch (err) {
    logError("profile: rememberDesktopSignIn", err);
  }
}

export async function recordDesktopOnboardingEvent(
  event: string,
  properties?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<boolean> {
  let store: Store;
  try {
    store = await Store.load(overlayStorePath);
  } catch (err) {
    logError("profile: recordDesktopOnboardingEvent load store", err);
    return false;
  }

  const eventId = idempotencyKey ?? crypto.randomUUID();
  const nextEvent = {
    event_id: eventId,
    event,
    occurred_at: new Date().toISOString(),
    properties: eventProperties(properties),
  };
  const queued = await pendingEvents(store);
  const withoutDuplicate = queued.filter((queuedEvent) => queuedEvent.event_id !== eventId);
  await replacePendingEvents(store, [...withoutDuplicate, nextEvent]);
  return flushPendingDesktopEvents(store);
}

async function flushPendingDesktopEvents(store: Store): Promise<boolean> {
  const events = await pendingEvents(store);
  if (events.length === 0) return true;
  if (!firebaseAuth.currentUser) return false;
  const ok = await syncProfileToBackend({ events });
  if (ok) await replacePendingEvents(store, []);
  return ok;
}

/** Persists first-run attribution answers and desktop metadata to the backend user profile.
 * Fail-soft: the endpoint may not exist yet, so any failure only logs and
 * returns false - onboarding never blocks on it. Returns true only on 2xx. */
export async function syncProfileToBackend(profile: {
  whereHeard?: StoredAnswer;
  role?: StoredAnswer;
  metadata?: DesktopMetadata;
  auth?: DesktopAuthMetadata;
  onboarding?: Record<string, unknown>;
  events?: DesktopOnboardingEvent[];
}): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = {
      desktop: {
        install: profile.metadata?.install ?? null,
        device: profile.metadata?.device ?? null,
        auth: profile.auth ?? null,
        onboarding: profile.onboarding ?? null,
      },
      events: profile.events ?? [],
    };
    if (profile.whereHeard !== undefined) {
      payload.where_heard = profile.whereHeard?.id ?? null;
      payload.where_heard_other = profile.whereHeard?.other ?? null;
    }
    if (profile.role !== undefined) {
      payload.role = profile.role?.id ?? null;
      payload.role_other = profile.role?.other ?? null;
    }
    const response = await authFetch("/devices/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
export async function syncProfileOnSignIn(
  uid: string,
  authMetadata: Omit<DesktopAuthMetadata, "sign_in_method"> = {},
): Promise<void> {
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

  const signInMethod = await store.get<string>(desktopLastSignInMethodKey);
  const signInStatus = await store.get<string>(desktopLastSignInStatusKey);
  const signInAt = await store.get<string>(desktopLastSignInAtKey);
  const metadata = await collectDesktopMetadata(store, anonId ?? uid);
  setPersonProperties(posthogSafeMetadata(metadata), uid);
  const auth = {
    ...authMetadata,
    sign_in_method: signInMethod ?? null,
  };

  const alreadySynced = await store.get<boolean>(desktopProfileSyncedKey);
  const whereHeard = await store.get<StoredAnswer>(desktopWhereHeardKey);
  const role = await store.get<StoredAnswer>(desktopRoleKey);
  const cleanedWhereHeard = cleanAnswer(whereHeard);
  const cleanedRole = cleanAnswer(role);
  const events = await pendingEvents(store);
  const onboarding = {
    sign_in_method: signInMethod ?? null,
    sign_in_status: signInStatus ?? null,
    sign_in_at: signInAt ?? null,
    completed: metadata.install.onboarding_seen,
  };

  // A user who finished onboarding before this feature existed has no answers
  // to sync. A new user has not reached the profile screen yet, so leave the
  // guard open for that screen to save and sync the answers after sign-in.
  if (!cleanedWhereHeard && !cleanedRole) {
    const synced = await syncProfileToBackend({
      metadata,
      auth,
      onboarding,
      events,
    });
    if (synced && events.length > 0) await replacePendingEvents(store, []);
    if (metadata.install.onboarding_seen) {
      await store.set(desktopProfileSyncedKey, true).catch((err) =>
        logError("profile: mark synced (no answers)", err),
      );
    }
    return;
  }

  const props: Record<string, unknown> = {};
  if (cleanedWhereHeard) {
    props.where_heard = cleanedWhereHeard.id;
    if (cleanedWhereHeard.other) props.where_heard_other = cleanedWhereHeard.other;
  }
  if (cleanedRole) {
    props.role = cleanedRole.id;
    if (cleanedRole.other) props.role_other = cleanedRole.other;
  }
  if (!alreadySynced) setPersonProperties(props, uid);

  // Best-effort backend write; failure never blocks the synced flag (see doc).
  const synced = await syncProfileToBackend({
    whereHeard: cleanedWhereHeard,
    role: cleanedRole,
    metadata,
    auth,
    onboarding,
    events,
  });
  if (synced && events.length > 0) await replacePendingEvents(store, []);

  if (!alreadySynced) {
    await store.set(desktopProfileSyncedKey, true).catch((err) =>
      logError("profile: mark synced", err),
    );
  }
}
