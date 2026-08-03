import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { auth } from "../lib/firebase";
import { logError } from "../lib/log";
import { syncProfileOnSignIn } from "../lib/profile";
import { initializeAcquisitionAnalytics } from "../lib/acquisitionAnalytics";

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
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
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
          .then(() => syncProfileOnSignIn(nextUser.uid))
          .catch((err) => logError("AuthProvider: syncProfileOnSignIn", err));
      }
    });

    return unsubscribe;
  }, []);

  // Ctrl+Shift+D: sign out immediately, bypassing VoiceBar's usual confirm step.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("sign-out-requested", () => {
      signOut(auth).catch((err) => {
        logError("AuthProvider: sign-out-requested", err);
        // Rust already revoked its native authorization before emitting this
        // event; if Firebase's own sign-out failed, the user is still signed
        // in on the JS side - re-assert the real state so the two sides
        // can't stay split (signed-in UI over locked-out native commands).
        invoke("set_auth_state", {
          signedIn: auth.currentUser !== null,
          uid: auth.currentUser?.uid ?? null,
        }).catch((reassertErr) => logError("AuthProvider: set_auth_state re-assert", reassertErr));
      });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("AuthProvider: listen sign-out-requested", err));
    return () => unlisten?.();
  }, []);

  return <AuthContext.Provider value={{ user, initializing }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
