import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "../lib/firebase";

/** Read-only Firebase user for the dashboard window. Does NOT run the overlay
 * AuthProvider's native side effects (set_panel_variant, dismiss_bar), which
 * must never fire from this window.
 *
 * `undefined` until Firebase has rehydrated the persisted session. auth.currentUser
 * is null for the first few hundred milliseconds of every launch even when a
 * session is stored, and reading that null as "signed out" showed the Google
 * welcome screen on every start before the app replaced it. Waiting on
 * authStateReady costs nothing when nothing is stored: it resolves at once. */
export function useDashboardUser(): User | null | undefined {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void auth.authStateReady().then(() => {
      if (cancelled) return;
      unsubscribe = onAuthStateChanged(auth, setUser);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  return user;
}
