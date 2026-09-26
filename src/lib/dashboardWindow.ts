import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";

export const DASHBOARD_ROUTES = [
  "/home",
  "/history",
  "/meetings",
  "/interview",
  "/agents",
  "/research",
  "/browser-agent",
  "/insights",
  "/general",
  "/connectors",
  "/account",
  "/billing",
  "/usage",
  "/mobile",
  "/help",
] as const;

export type DashboardRoute = (typeof DASHBOARD_ROUTES)[number];

export function isDashboardRoute(value: unknown): value is DashboardRoute {
  return typeof value === "string" && (DASHBOARD_ROUTES as readonly string[]).includes(value);
}

/** The assistant asked for a Settings or dashboard page by route (a
 * `client.open_settings` data message). Rust repeats the allow-list check. */
export async function openSettingsRoute(route: DashboardRoute): Promise<void> {
  try {
    await invoke("open_settings_route", { route });
  } catch (err) {
    logError(`openSettingsRoute: ${route}`, err);
  }
}

/** Opens or focuses the native dashboard at a validated route. Rust repeats
 * the allow-list check so a compromised webview cannot navigate arbitrarily.
 * `tab` picks the agent on the Agents page (`computer` or `research`) and is
 * ignored for every other route. */
export async function openDashboardWindow(route: DashboardRoute = "/home", resourceId?: string | null, tab?: "computer" | "research"): Promise<void> {
  try {
    await invoke("open_dashboard_route", { route, resourceId: resourceId ?? null, tab: tab ?? null });
  } catch (err) {
    logError(`openDashboardWindow: ${route}`, err);
  }
}
