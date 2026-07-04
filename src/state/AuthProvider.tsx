import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { auth } from "../lib/firebase";
import { logError } from "../lib/log";

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
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      invoke("set_session_cached", { hasSession: nextUser !== null }).catch((err) =>
        logError("AuthProvider: set_session_cached", err),
      );
      // Setup/Bar is a pure mirror of live auth state now (OverlayRoot's own
      // content decision already reads useAuth() directly) - this only
      // drives Rust's window sizing, so it's safe to push unconditionally on
      // every callback, including the first, unlike the old two-mode design.
      invoke("set_panel_variant", { variant: nextUser ? "bar" : "setup" }).catch((err) =>
        logError("AuthProvider: set_panel_variant", err),
      );

      setUser(nextUser);
      setInitializing(false);
    });

    return unsubscribe;
  }, []);

  // Ctrl+Shift+D: sign out immediately, bypassing VoiceBar's usual confirm step.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("sign-out-requested", () => {
      signOut(auth).catch((err) => logError("AuthProvider: sign-out-requested", err));
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
