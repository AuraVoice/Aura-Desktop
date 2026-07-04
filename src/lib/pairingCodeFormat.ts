import { pairingCodeLength } from "./pairingCopy";

/** Strips non-alphanumerics and uppercases - the raw form sent to the backend. */
export function rawPairingCode(text: string): string {
  return text.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/** Caps at 8 raw chars and inserts a hyphen after the 4th, for display in the input. */
export function formatPairingCodeForDisplay(text: string): string {
  const raw = rawPairingCode(text).slice(0, pairingCodeLength);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}
