import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
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
  const previousUserRef = useRef<User | null>(null);
  const hasResolvedInitialRef = useRef(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      invoke("set_session_cached", { hasSession: nextUser !== null }).catch(
        (err) => logError("AuthProvider: set_session_cached", err),
      );

      // Only force a mode transition on an actual sign-in/sign-out edge, not
      // on the initial state resolution — a cold start with a valid cached
      // session is already showing avatar mode via Rust's own startup check,
      // and forcing it again here would fight an explicitly-opened dashboard.
      if (hasResolvedInitialRef.current) {
        const wasSignedIn = previousUserRef.current !== null;
        const isSignedIn = nextUser !== null;
        if (wasSignedIn && !isSignedIn) {
          invoke("switch_mode", { mode: "dashboard" }).catch((err) =>
            logError("AuthProvider: switch_mode(dashboard)", err),
          );
        } else if (!wasSignedIn && isSignedIn) {
          invoke("switch_mode", { mode: "avatar" }).catch((err) =>
            logError("AuthProvider: switch_mode(avatar)", err),
          );
        }
      }

      previousUserRef.current = nextUser;
      hasResolvedInitialRef.current = true;
      setUser(nextUser);
      setInitializing(false);
    });

    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ user, initializing }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
