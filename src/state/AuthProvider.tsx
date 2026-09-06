import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
import { auth } from "../lib/firebase";
import { logError } from "../lib/log";
import { useTauriEvent } from "../lib/useTauriEvent";
import { SIGN_OUT_REQUESTED } from "../lib/ipcEvents";
import { syncProfileOnSignIn } from "../lib/profile";
import { initializeAcquisitionAnalytics } from "../lib/acquisitionAnalytics";
import { signOutSession } from "../lib/signOutSession";

interface AuthContextValue {
  user: User | null;
  initializing: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  initializing: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    // onAuthStateChanged fires its FIRST callback with null whenever the
    // persisted session has not been rehydrated yet, and both the overlay and
    // the dashboard mount their own provider. Reporting that null to Rust
    // announces a signed-out session on every launch, which used to be read as
    // a real account boundary and pruned the per-account local stores.
    // security.rs now ignores a no-change report, and this keeps the phantom
    // from being sent at all. Awaiting persistence costs nothing: it resolves
    // immediately when there is no stored session.
    void auth.authStateReady().then(() => {
      if (cancelled) return;
      unsubscribe = attach();
    });

    function attach() {
      return onAuthStateChanged(auth, async (nextUser) => {
      // Rust's security state (security.rs) is the authorization boundary
      // for screen capture / meeting audio / pointing; it must be current
      // BEFORE React exposes the user, or a signed-in-gated effect (the
      // meeting upload pump, for one) could invoke a guarded command that
      // Rust still believes is signed out. Awaited for exactly that
      // ordering; on failure the native state simply keeps its previous,
      // more restrictive value (fresh processes start signed out) - fail
      // closed, never open.
      await invoke("set_auth_state", {
        signedIn: nextUser !== null,
        uid: nextUser?.uid ?? null,
      }).catch((err) => logError("AuthProvider: set_auth_state", err));

      // The persisted startup hint (window pre-seeding only - never an
      // authorization input; see auth_cache.rs).
      invoke("set_session_cached", { hasSession: nextUser !== null }).catch((err) =>
        logError("AuthProvider: set_session_cached", err),
      );
      // Setup/Companion is a pure mirror of live auth state now (OverlayRoot's own
      // content decision already reads useAuth() directly) - this only
      // drives Rust's window sizing, so it's safe to push unconditionally on
      // every callback, including the first, unlike the old two-mode design.
      invoke("set_panel_variant", { variant: nextUser ? "companion" : "setup" }).catch((err) =>
        logError("AuthProvider: set_panel_variant", err),
      );

      setUser(nextUser);
      setInitializing(false);

      // Sign-in choke point: sync first-run attribution (PostHog alias + $set,
      // backend profile) exactly once. Self-guards on desktop_profile_synced
      // and is a cheap no-op for returning users, so it's safe to fire on
      // every signed-in callback including the initial one.
      if (nextUser) {
        void initializeAcquisitionAnalytics()
          .then(() => syncProfileOnSignIn(nextUser.uid, {
            created_at: nextUser.metadata.creationTime ?? null,
            last_login_at: nextUser.metadata.lastSignInTime ?? null,
            provider_ids: nextUser.providerData.map((provider) => provider.providerId),
            email_verified: nextUser.emailVerified,
          }))
          .catch((err) => logError("AuthProvider: syncProfileOnSignIn", err));
      }
      });
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Ctrl+Shift+D: sign out immediately, bypassing VoiceBar's usual confirm step.
  useTauriEvent(
    SIGN_OUT_REQUESTED,
    () => {
      signOutSession().catch((err) => {
        logError("AuthProvider: sign-out-requested", err);
      });
    },
    "AuthProvider: listen sign-out-requested",
  );

  return <AuthContext.Provider value={{ user, initializing }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
