import { Store } from "@tauri-apps/plugin-store";
import { desktopAnonIdKey, overlayStorePath } from "./copy";

export async function getOrCreateDesktopInstallId(store?: Store): Promise<string> {
  const resolvedStore = store ?? await Store.load(overlayStorePath);
  const existing = await resolvedStore.get<string>(desktopAnonIdKey);
  if (existing) return existing;
  const installId = crypto.randomUUID();
  await resolvedStore.set(desktopAnonIdKey, installId);
  return installId;
}
