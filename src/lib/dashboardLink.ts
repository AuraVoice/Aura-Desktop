import { openUrl } from "@tauri-apps/plugin-opener";
import { authFetch } from "./api";
import { dashboardUrl } from "./copy";
import { auth } from "./firebase";
import { logError } from "./log";

export interface DashboardLinkResult {
  code: string;
  expiresInSeconds: number;
}

/** Mints a short-lived, single-use code (juno-backend's
 * `/devices/dashboard-link/start`) that gets embedded in the dashboard URL
 * so the browser opens already signed in, without a second login. */
export async function mintDashboardLink(): Promise<DashboardLinkResult> {
  const response = await authFetch("/devices/dashboard-link/start", { method: "POST" });
  if (!response.ok) {
    throw new Error(`Dashboard link request failed (${response.status})`);
  }
  const data = (await response.json()) as { code?: string; expires_in_seconds?: number };
  if (!data.code || !data.expires_in_seconds) {
    throw new Error("Dashboard link response missing code");
  }
  return { code: data.code, expiresInSeconds: data.expires_in_seconds };
}

/** Shared by the tray's "Open Dashboard" item and the bar's dashboard button
 * so both triggers mint/open/fallback identically instead of duplicating the
 * sequence per call site.
 *
 * Includes the desktop's own current uid alongside the one-time code so the
 * dashboard page can tell "this browser is already signed into the same
 * account" (skip straight in, no reauth) apart from "this browser has some
 * *other* account's session cached" (a shared machine - must still claim the
 * code to switch accounts). The uid carries no authorization weight by
 * itself - it's a plain, non-secret identifier, and the dashboard's actual
 * data access always goes through a real Firebase-verified session token,
 * never anything derived from this URL. */
// Module-level, not component state: openDashboard() has two independent
// call sites (tray menu, bar button), and the bar button in particular is a
// single click away next to the mic - far easier to double-fire than a tray
// menu item ever was. A shared in-flight guard covers both call sites at
// once, so a rapid double click doesn't mint (and immediately waste) two
// single-use codes and open two browser tabs.
let openInFlight: Promise<void> | null = null;

export async function openDashboard(): Promise<void> {
  if (openInFlight) return openInFlight;
  openInFlight = (async () => {
    try {
      const { code } = await mintDashboardLink();
      const url = new URL(dashboardUrl);
      url.searchParams.set("code", code);
      if (auth.currentUser?.uid) {
        url.searchParams.set("uid", auth.currentUser.uid);
      }
      await openUrl(url.toString());
    } catch (err) {
      logError("openDashboard", err);
      await openUrl(dashboardUrl);
    } finally {
      openInFlight = null;
    }
  })();
  return openInFlight;
}
