import { loadGeneralSettings, saveGeneralSettings } from "./generalSettings";
import { logError, logInfo } from "./log";

// Output mute: Aura keeps thinking and keeps streaming text, and says nothing.
//
// Held at module scope for the same reason as chatConversation.ts's id: the
// voice start path (voice.ts builds the /voice/token query), the transport hook
// that mutes live audio (useVoiceBar), and the hook that owns the hotkey and the
// indicator (useOutputMode) have no shared ancestor state, and threading a bit
// through fetchVoiceToken would change a signature useVoiceBar's tests pin.
//
// The generation is the race guard, exactly as encodeGuideMode uses one
// (clientControl.ts): every toggle bumps it, the worker ignores anything at or
// below the generation it already applied, and the client only trusts an ack
// whose generation matches the toggle it is still waiting on. Generation 0 is
// reserved for the mode stamped into the token metadata at connect.
export type OutputMode = "voice" | "text";

type OutputModeListener = (muted: boolean, generation: number) => void;

let muted = false;
let generation = 0;
const listeners = new Set<OutputModeListener>();

export function outputMuted(): boolean {
  return muted;
}

export function outputMode(): OutputMode {
  return muted ? "text" : "voice";
}

export function outputGeneration(): number {
  return generation;
}

/** Reads the persisted preference once at startup. Never throws: a store read
 * that fails leaves Aura audible, which is the safe direction to fail (a user
 * who wanted silence hears one reply; the reverse is a call they cannot hear). */
export async function loadOutputMode(): Promise<void> {
  try {
    const settings = await loadGeneralSettings();
    if (settings.textOutputMuted === muted) return;
    muted = settings.textOutputMuted;
    generation += 1;
    notify();
  } catch (err) {
    logError("outputMode: load", err);
  }
}

/** Flips the bit, bumps the generation, and persists. Returns the generation the
 * caller should publish and match an ack against. Local state changes first and
 * synchronously: muting must not wait on a disk write. */
export function setOutputMuted(next: boolean): number {
  if (next !== muted) {
    muted = next;
    generation += 1;
    notify();
    void persist(next);
  }
  return generation;
}

async function persist(next: boolean): Promise<void> {
  try {
    const settings = await loadGeneralSettings();
    await saveGeneralSettings({ ...settings, textOutputMuted: next });
  } catch (err) {
    logError("outputMode: persist", err);
  }
}

function notify(): void {
  logInfo("outputMode: changed", `muted=${muted} generation=${generation}`);
  for (const listener of listeners) {
    try {
      listener(muted, generation);
    } catch (err) {
      logError("outputMode: listener", err);
    }
  }
}

/** Fires immediately with the current value so a late subscriber (a room that
 * connects after the toggle) applies the mode instead of waiting for the next
 * change that may never come. */
export function subscribeOutputMode(listener: OutputModeListener): () => void {
  listeners.add(listener);
  try {
    listener(muted, generation);
  } catch (err) {
    logError("outputMode: listener", err);
  }
  return () => {
    listeners.delete(listener);
  };
}
