import { getVersion } from "@tauri-apps/api/app";
import {
  arch,
  family,
  hostname,
  locale,
  platform,
  type as osType,
  version as osVersion,
} from "@tauri-apps/plugin-os";
import { Store } from "@tauri-apps/plugin-store";
import {
  desktopOnboardingSeenKey,
  desktopOnboardingSeenForUidKey,
  overlayStorePath,
} from "./copy";
import { logError } from "./log";

export const firstStartedAtKey = "desktop_first_started_at";
export const firstStartedVersionKey = "desktop_first_started_version";
export const lastStartedAtKey = "desktop_last_started_at";
export const lastStartedVersionKey = "desktop_last_started_version";

export interface DesktopInstallMetadata {
  install_id: string;
  first_started_at: string;
  first_started_version: string;
  last_started_at: string;
  last_started_version: string;
  previous_version: string | null;
  is_returning_install: boolean;
  onboarding_seen: boolean;
}

export interface DesktopDeviceMetadata {
  device_name: string | null;
  os_platform: string;
  os_family: string;
  os_type: string;
  os_version: string;
  os_arch: string;
  locale: string | null;
  browser_language: string | null;
  region: string | null;
  timezone: string | null;
  timezone_offset_minutes: number;
}

export interface DesktopMetadata {
  install: DesktopInstallMetadata;
  device: DesktopDeviceMetadata;
}

function regionFromLocale(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.replace("_", "-").split("-");
  const region = parts.find((part) => /^[A-Z]{2}$/.test(part));
  return region ?? null;
}

function browserLanguage(): string | null {
  return navigator.language || navigator.languages?.[0] || null;
}

function timezone(): string | null {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
}

export function posthogSafeMetadata(metadata: DesktopMetadata): Record<string, unknown> {
  return {
    app_version: metadata.install.last_started_version,
    install_id: metadata.install.install_id,
    first_started_at: metadata.install.first_started_at,
    first_started_version: metadata.install.first_started_version,
    is_returning_install: metadata.install.is_returning_install,
    onboarding_seen: metadata.install.onboarding_seen,
    os_platform: metadata.device.os_platform,
    os_family: metadata.device.os_family,
    os_type: metadata.device.os_type,
    os_version: metadata.device.os_version,
    os_arch: metadata.device.os_arch,
    locale: metadata.device.locale,
    browser_language: metadata.device.browser_language,
    region: metadata.device.region,
    timezone: metadata.device.timezone,
    timezone_offset_minutes: metadata.device.timezone_offset_minutes,
  };
}

export async function collectDesktopMetadata(
  store: Store,
  installId: string,
  uid?: string,
): Promise<DesktopMetadata> {
  const now = new Date().toISOString();
  const [
    appVersion,
    existingFirstStartedAt,
    existingFirstStartedVersion,
    previousVersion,
    onboardingSeen,
    deviceName,
    osLocale,
  ] = await Promise.all([
    getVersion().catch(() => "unknown"),
    store.get<string>(firstStartedAtKey),
    store.get<string>(firstStartedVersionKey),
    store.get<string>(lastStartedVersionKey),
    store.get<boolean>(uid ? desktopOnboardingSeenForUidKey(uid) : desktopOnboardingSeenKey),
    hostname().catch((err) => {
      logError("desktopMetadata: hostname", err);
      return null;
    }),
    locale().catch((err) => {
      logError("desktopMetadata: locale", err);
      return null;
    }),
  ]);
  const firstStartedAt = existingFirstStartedAt ?? now;
  const firstStartedVersion = existingFirstStartedVersion ?? appVersion;
  if (!existingFirstStartedAt) await store.set(firstStartedAtKey, firstStartedAt);
  if (!existingFirstStartedVersion) await store.set(firstStartedVersionKey, firstStartedVersion);
  await store.set(lastStartedAtKey, now);
  await store.set(lastStartedVersionKey, appVersion);

  const lang = browserLanguage();
  const resolvedRegion = regionFromLocale(osLocale) ?? regionFromLocale(lang);
  return {
    install: {
      install_id: installId,
      first_started_at: firstStartedAt,
      first_started_version: firstStartedVersion,
      last_started_at: now,
      last_started_version: appVersion,
      previous_version: previousVersion ?? null,
      is_returning_install: Boolean(existingFirstStartedAt),
      onboarding_seen: Boolean(onboardingSeen),
    },
    device: {
      device_name: deviceName,
      os_platform: platform(),
      os_family: family(),
      os_type: osType(),
      os_version: osVersion(),
      os_arch: arch(),
      locale: osLocale,
      browser_language: lang,
      region: resolvedRegion,
      timezone: timezone(),
      timezone_offset_minutes: new Date().getTimezoneOffset(),
    },
  };
}

export async function loadDesktopMetadata(installId: string): Promise<DesktopMetadata> {
  const store = await Store.load(overlayStorePath);
  return collectDesktopMetadata(store, installId);
}
