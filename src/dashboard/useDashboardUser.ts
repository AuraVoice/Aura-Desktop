import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "../lib/firebase";

/** Read-only Firebase user for the dashboard window. Does NOT run the overlay
 * AuthProvider's native side effects (set_panel_variant, dismiss_bar), which
 * must never fire from this window. */
export function useDashboardUser(): User | null {
  const [user, setUser] = useState<User | null>(auth.currentUser);
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return user;
}
