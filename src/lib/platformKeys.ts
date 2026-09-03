import { platform } from "@tauri-apps/plugin-os";

/** The ONE place user-facing copy asks which OS it is running on and what the
 * platform calls its keys. Everything that used to hardcode "Windows", "Win",
 * or "Alt" reads from here so the macOS build renders macOS words with no
 * per-callsite branching.
 *
 * platform() is synchronous in Tauri v2 but throws outside a Tauri webview
 * (vitest/jsdom), so it is read lazily with a Windows fallback: tests and the
 * Windows build both resolve to the exact strings shipped before this module
 * existed. */
let cachedPlatform: string | null = null;

function currentPlatform(): string {
  if (cachedPlatform === null) {
    try {
      cachedPlatform = platform();
    } catch {
      cachedPlatform = "windows";
    }
  }
  return cachedPlatform;
}

export function isMac(): boolean {
  return currentPlatform() === "macos";
}

/** "Windows" or "macOS", for copy like "anywhere in Windows". */
export function osName(): string {
  return isMac() ? "macOS" : "Windows";
}

/** What the platform prints on its Super key: Win or Cmd. */
export function superLabel(): string {
  return isMac() ? "Cmd" : "Win";
}

/** What the platform prints on its Alt key: Alt or Option. */
export function altLabel(): string {
  return isMac() ? "Option" : "Alt";
}

/** The value backend and analytics expect. Lowercase, matching the mobile
 * clients' convention for the same header. */
export function platformTag(): string {
  return isMac() ? "macos" : "windows";
}

/** What a user calls the machine this app is installed on. "PC" reads as
 * Windows-specific to a Mac user. */
export function deviceNoun(): string {
  return isMac() ? "Mac" : "PC";
}

/** Where the app rests when it has no window open. */
export function trayNoun(): string {
  return isMac() ? "menu bar" : "system tray";
}

/** The modifier a user reaches for by default. macOS reserves Cmd for app
 * shortcuts, so the cross-app global bindings stay on Control there too, which
 * is free on both platforms. */
export function primaryModifierLabel(): string {
  return "Ctrl";
}

/** The voice-trigger key's default label, used only until Rust replies with
 * the configured one. Both platforms have this physical key; only the
 * conventional spelling differs. */
export function defaultVoiceKeyLabel(): string {
  return isMac() ? "Left Control" : "Left Ctrl";
}
