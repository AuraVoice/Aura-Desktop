import { Store } from "@tauri-apps/plugin-store";
import { overlayStorePath } from "./copy";
import { logError } from "./log";

// Connectors the user can register interest in before they ship. Stored locally
// (same overlay store as generalSettings.ts) as a simple id -> interested map;
// absent keys mean "not interested yet".
export type FutureConnectorId = "gmail" | "slack" | "notion";
export type ConnectorInterest = Partial<Record<FutureConnectorId, boolean>>;

export const CONNECTOR_INTEREST_KEY = "dashboard_connector_interest";

export async function loadConnectorInterest(): Promise<ConnectorInterest> {
  try {
    const store = await Store.load(overlayStorePath);
    return (await store.get<ConnectorInterest>(CONNECTOR_INTEREST_KEY)) ?? {};
  } catch (err) {
    logError("connectorPreferences: load", err);
    return {};
  }
}

export async function saveConnectorInterest(interest: ConnectorInterest): Promise<void> {
  const store = await Store.load(overlayStorePath);
  await store.set(CONNECTOR_INTEREST_KEY, interest);
  await store.save();
}
