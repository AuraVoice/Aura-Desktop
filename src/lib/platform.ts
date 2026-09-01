/**
 * The single source of truth for which desktop OS this build is running on,
 * and for every user-visible string that differs between them.
 *
 * Before this existed the answer was hardcoded in ~40 places: key labels said
 * "Ctrl" and "Win", settings copy said "Windows" and "taskbar", and the
 * backend/analytics headers reported every install as Windows regardless. One
 * module means a new platform string is added once, not hunted for.
 *
 * `platform()` from @tauri-apps/plugin-os is synchronous and cheap (the value
 * is baked in at build time), so this is a plain const rather than a hook or a
 * promise. Reading it at module scope keeps it usable from non-React code like
 * api.ts and analytics.ts.
 */

import { platform } from "@tauri-apps/plugin-os";

type DesktopPlatform = "macos" | "windows" | "other";

function detect(): DesktopPlatform {
  try {
    const value = platform();
    if (value === "macos") return "macos";
    if (value === "windows") return "windows";
    return "other";
  } catch {
    // The OS plugin is unavailable in a plain browser context (vitest, the
    // Vite dev server without a native shell). Windows stays the default so
    // existing behavior is unchanged wherever detection cannot run.
    return "windows";
  }
}

export const currentPlatform: DesktopPlatform = detect();
export const isMac = currentPlatform === "macos";
export const isWindows = currentPlatform === "windows";

/** The value backend and analytics expect. Lowercase, matching the mobile
 * clients' convention for the same header. */
export const platformTag = isMac ? "macos" : "windows";

/** PostHog's `$os` property, which is title-cased by convention. */
export const analyticsOsName = isMac ? "macOS" : "Windows";

/** The OS name as it appears mid-sentence in product copy. */
export const osName = isMac ? "macOS" : "Windows";

/** What a user calls the machine this app is installed on. "PC" reads as
 * Windows-specific to a Mac user. */
export const deviceNoun = isMac ? "Mac" : "PC";

/** Where the app rests when it has no window open. */
export const trayNoun = isMac ? "menu bar" : "system tray";

/**
 * Renders one accelerator part as the symbol that platform's users expect.
 * Tauri's accelerator grammar is shared ("Control", "Alt", "Shift", "Super"),
 * only the label differs.
 */
export function modifierLabel(part: string): string {
  if (isMac) {
    if (part === "Control") return "⌃";
    if (part === "Alt") return "⌥";
    if (part === "Shift") return "⇧";
    if (part === "Super") return "⌘";
    return part;
  }
  if (part === "Control") return "Ctrl";
  if (part === "Super") return "Win";
  return part;
}

/**
 * The modifier a user reaches for by default. macOS reserves Cmd for app
 * shortcuts, so the cross-app global bindings stay on Control+Alt there too,
 * which is free on both platforms.
 */
export const primaryModifierLabel = modifierLabel("Control");

/** The voice-trigger key's default label, used only until Rust replies with
 * the configured one. Both platforms have this physical key; only the
 * conventional spelling differs. */
export const defaultVoiceKeyLabel = isMac ? "Left Control" : "Left Ctrl";

/** Deep link into the System Settings pane that grants a TCC permission, so a
 * denied prompt can offer a button instead of a sentence. macOS only; returns
 * null elsewhere, and callers should hide the affordance when it does. */
export function privacySettingsUrl(
  pane: "Microphone" | "Accessibility" | "ScreenCapture" | "ListenEvent",
): string | null {
  if (!isMac) return null;
  return `x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`;
}
