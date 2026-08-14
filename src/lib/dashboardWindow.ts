import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";

export type DashboardRoute =
  | "/home"
  | "/conversations"
  | "/drafts"
  | "/saved"
  | "/meetings"
  | "/research"
  | "/insights"
  | "/general"
  | "/connectors"
  | "/account"
  | "/billing"
  | "/usage"
  | "/mobile"
  | "/help";

/** Opens or focuses the native dashboard at a validated route. Rust repeats
 * the allow-list check so a compromised webview cannot navigate arbitrarily. */
export async function openDashboardWindow(route: DashboardRoute = "/home", resourceId?: string | null): Promise<void> {
  try {
    await invoke("open_dashboard_route", { route, resourceId: resourceId ?? null });
  } catch (err) {
    logError(`openDashboardWindow: ${route}`, err);
  }
}
