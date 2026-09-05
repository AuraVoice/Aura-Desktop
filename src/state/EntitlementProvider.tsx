import { createContext, useContext, type ReactNode } from "react";
import { useEntitlement, type EntitlementState } from "./useEntitlement";

/** What a component reads when it renders outside a provider (a test harness, a
 * stray root). Deliberately `known: false`, so anything gating on it fails OPEN.
 * A padlock invented by a missing provider is worse than briefly offering a
 * voice the backend will refuse to save. */
const UNRESOLVED: EntitlementState = {
  loaded: false,
  known: false,
  tier: "free",
  effectiveTier: "free",
  status: "unknown",
  trialDaysLeft: 0,
  trialEndDate: null,
  cancelAtPeriodEnd: false,
  isTrialing: false,
  isPurchased: false,
  checkout: { phase: "idle" },
  startCheckout: () => {},
  cancelCheckout: () => {},
  refresh: () => {},
};

const EntitlementContext = createContext<EntitlementState>(UNRESOLVED);

/**
 * One GET /entitlement per WINDOW, not per component. The overlay and the
 * dashboard are separate webviews and cannot share React state, so each mounts
 * this once at its own root and feeds it that window's user: the overlay from
 * AuthProvider, the dashboard from useDashboardUser. They still share the Rust
 * cache underneath, so the second window's read is normally served from disk.
 */
export function EntitlementProvider({
  signedIn,
  uid,
  children,
}: {
  signedIn: boolean;
  uid: string | null;
  children: ReactNode;
}) {
  const state = useEntitlement({ signedIn, uid });
  return <EntitlementContext.Provider value={state}>{children}</EntitlementContext.Provider>;
}

export function useEntitlementState(): EntitlementState {
  return useContext(EntitlementContext);
}
