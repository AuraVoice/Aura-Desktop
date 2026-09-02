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
