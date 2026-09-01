import { invoke } from "@tauri-apps/api/core";
import { isMac, modifierLabel, osName } from "./platform";

export interface HotkeyBinding {
  id: string;
  label: string;
  accelerator: string;
  keys: string[];
  registered: boolean;
}

export interface VoiceToggleKeyStatus {
  available: boolean;
  keyLabel: string;
  accelerator: string;
  keys: string[];
  gesture: "doubleTap" | "press";
  reason?: string;
}

/** Keys the voice trigger can be double-tapped on. Mirrors DOUBLE_TAP_SENTINELS
 * in src-tauri/src/hotkeys.rs. Alt is absent on purpose: a lone Alt tap drops
 * the focused window into Windows keyboard menu mode. */
export const DOUBLE_TAP_PRESETS: { accelerator: string; label: string }[] = [
  { accelerator: "ControlLeft", label: "Left Ctrl" },
  { accelerator: "ControlRight", label: "Right Ctrl" },
  { accelerator: "ShiftRight", label: "Right Shift" },
  { accelerator: "ShiftLeft", label: "Left Shift" },
];

export function isDoubleTapAccelerator(accelerator: string): boolean {
  return DOUBLE_TAP_PRESETS.some((preset) => preset.accelerator === accelerator);
}

export function loadHotkeyBindings(): Promise<HotkeyBinding[]> {
  return invoke<HotkeyBinding[]>("hotkey_bindings");
}

export function updateHotkeyBinding(id: string, accelerator: string): Promise<HotkeyBinding[]> {
  return invoke<HotkeyBinding[]>("set_hotkey_binding", { id, accelerator });
}

export function resetHotkeyBindings(): Promise<HotkeyBinding[]> {
  return invoke<HotkeyBinding[]>("reset_hotkey_bindings");
}

export function loadVoiceToggleKey(): Promise<VoiceToggleKeyStatus> {
  return invoke<VoiceToggleKeyStatus>("voice_toggle_key_status");
}

export function updateVoiceToggleKey(keyCode: string): Promise<VoiceToggleKeyStatus> {
  return invoke<VoiceToggleKeyStatus>("set_voice_toggle_key", { keyCode });
}

const MODIFIER_CODES = [
  "ControlLeft", "ControlRight",
  "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight",
  "MetaLeft", "MetaRight",
];

/** Useless as a bare shortcut because the user needs them to type and navigate.
 * With any modifier held they are fine. Mirrors BARE_KEY_BLOCKLIST in hotkeys.rs. */
const BARE_KEY_BLOCKLIST = [
  "Tab", "Enter", "Backspace", "Delete", "Escape",
  "CapsLock", "NumLock", "ScrollLock", "PrintScreen", "Pause", "ContextMenu",
];

export type ShortcutCapture =
  /** Only modifiers held so far, keep listening. */
  | { kind: "pending" }
  /** Windows will never deliver this combination. */
  | { kind: "rejected"; reason: string }
  /** Usable. `warning` is advisory only and never blocks saving. */
  | { kind: "ok"; accelerator: string; keys: string[]; warning?: string };

/** Human name for a KeyboardEvent.code, e.g. "KeyA" -> "A", "Digit1" -> "1". */
function displayKey(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return code.slice(5);
  return code;
}

/** Deliberately a blocklist, not an allowlist: the user binds whatever they
 * want and we refuse only what Windows reserves outright. Everything merely
 * risky comes back as `ok` carrying a `warning`. Rust re-checks all of this in
 * validate_shortcut; this exists so the message appears before Save, not after. */
export function captureShortcut(event: KeyboardEvent): ShortcutCapture {
  if (MODIFIER_CODES.includes(event.code)) return { kind: "pending" };

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  if (event.metaKey) {
    // The Windows key belongs to the shell; Command is the primary modifier on
    // macOS and Tauri registers it through the same "Super" accelerator part.
    if (!isMac) {
      return { kind: "rejected", reason: "Windows-key shortcuts are reserved for Windows. Use Ctrl, Alt, and Shift instead." };
    }
    modifiers.push("Super");
  }
  if (event.code === "F12" && !isMac) {
    return { kind: "rejected", reason: "F12 is reserved by Windows for debuggers." };
  }
  if (modifiers.length === 0 && BARE_KEY_BLOCKLIST.includes(event.code)) {
    return { kind: "rejected", reason: "Pick a key you do not need for normal typing." };
  }
  if (event.code === "Tab" && (isMac ? event.metaKey : event.altKey)) {
    return { kind: "rejected", reason: isMac ? "Cmd+Tab is reserved for switching apps." : "Alt+Tab is reserved for switching windows." };
  }
  if (event.code === "Escape" && (event.altKey || event.ctrlKey || event.metaKey)) {
    return { kind: "rejected", reason: `That Escape shortcut is reserved by ${osName}.` };
  }
  if (isMac ? event.code === "KeyQ" && event.metaKey : event.code === "F4" && event.altKey) {
    return { kind: "rejected", reason: isMac ? "Cmd+Q is reserved for quitting apps." : "Alt+F4 is reserved for closing windows." };
  }

  const key = displayKey(event.code);
  const isTypingKey = /^Key[A-Z]$/.test(event.code) || /^Digit[0-9]$/.test(event.code) || event.code === "Space";
  let warning: string | undefined;
  if (modifiers.length === 0) {
    warning = `This captures ${key} everywhere in ${osName}, including while you type. You will not be able to use it in other apps.`;
  } else if (modifiers.length === 1 && isTypingKey) {
    warning = "Single-modifier shortcuts often collide with whatever app you are in.";
  } else if (event.ctrlKey && event.altKey && !event.shiftKey && /^Key[A-Z]$/.test(event.code)) {
    warning = "On some international keyboards this is AltGr and may interfere with typing.";
  }

  return {
    kind: "ok",
    accelerator: [...modifiers, event.code].join("+"),
    keys: [...modifiers.map(modifierLabel), key],
    warning,
  };
}

export function keysFromAccelerator(accelerator: string): string[] {
  return accelerator.split("+").map((part) => {
    if (part === "Control" || part === "Alt" || part === "Shift" || part === "Super") {
      return modifierLabel(part);
    }
    return displayKey(part);
  });
}

const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Super"];

/** Sorts modifiers into a fixed order so two accelerators for the same physical
 * combination compare equal. Required because this module builds them in DOM
 * event order while Rust returns them in Shortcut::to_string() order, so a raw
 * string compare would miss real conflicts. */
export function canonicalAccelerator(accelerator: string): string {
  const parts = accelerator.split("+");
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
  const key = parts.find((part) => !MODIFIER_ORDER.includes(part)) ?? "";
  return [...modifiers, key].join("+");
}

/** The action already bound to `accelerator`, or null. `skipId` is the binding
 * being edited, which must not conflict with itself. */
export function findConflict(
  accelerator: string,
  bindings: HotkeyBinding[],
  voice: VoiceToggleKeyStatus | null,
  skipId: string,
): { id: string; label: string } | null {
  const target = canonicalAccelerator(accelerator);
  if (
    skipId !== "voice"
    && voice
    && voice.gesture === "press"
    && canonicalAccelerator(voice.accelerator) === target
  ) {
    return { id: "voice", label: "Start or end voice" };
  }
  const clash = bindings.find(
    (binding) => binding.id !== skipId && canonicalAccelerator(binding.accelerator) === target,
  );
  return clash ? { id: clash.id, label: clash.label } : null;
}
