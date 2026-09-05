import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CircleCheck, LockKeyhole, Play, Square } from "lucide-react";
import { buddyVoices, defaultBuddyVoiceSlug, type BuddyVoice } from "../lib/buddyVoices";
import { useEntitlementState } from "../state/EntitlementProvider";
import { logError } from "../lib/log";
import { fetchVoicePreference, saveVoicePreference } from "../lib/voicePreferences";
import "./VoicePickerCards.css";

const WAVE_HEIGHTS = [8, 13, 19, 27, 34, 24, 38, 31, 21, 35, 26, 18, 12, 7] as const;

interface VoicePickerCardsProps {
  surface: "onboarding" | "settings";
  onLockedVoice?: (voice: BuddyVoice) => void;
  onSavingChange?: (saving: boolean) => void;
}

type VoiceStyle = CSSProperties & Record<"--voice-tint" | "--voice-tint-soft" | "--voice-tint-faint", string>;

function tintStyle(tint: string): VoiceStyle {
  return {
    "--voice-tint": tint,
    "--voice-tint-soft": `${tint}33`,
    "--voice-tint-faint": `${tint}12`,
  };
}

export function VoicePickerCards({
  surface,
  onLockedVoice,
  onSavingChange,
}: VoicePickerCardsProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [selectedSlug, setSelectedSlug] = useState(defaultBuddyVoiceSlug);
  const [playingSlug, setPlayingSlug] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entitlement = useEntitlementState();

  // Fail OPEN. A voice is locked only once the shared entitlement actually
  // resolved AND says free. While it is in flight, or after a failed read,
  // everything stays pickable: the backend refuses a locked voice on
  // PUT /voice/preferences and re-resolves the tier at call time in the voice
  // worker, whose own catalog fails open for exactly this reason. A padlock on
  // someone who really is inside the 45 day trial is the worse failure.
  const paidLocked = entitlement.known && entitlement.effectiveTier === "free";

  useEffect(() => {
    let active = true;
    // `loaded` now means only "the saved voice resolved". It never had any
    // business gating the lock, and conflating the two is what let a slow
    // entitlement read padlock a paid account.
    void fetchVoicePreference()
      .then((preference) => {
        if (active) setSelectedSlug(preference.voiceId);
      })
      .catch((err) => {
        if (!active) return;
        logError("VoicePickerCards: load preference", err);
        setError("Your saved voice couldn't be loaded. You can try again here.");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  async function preview(voice: BuddyVoice) {
    setError(null);
    if (playingSlug === voice.slug) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingSlug(null);
      return;
    }

    audioRef.current?.pause();
    const audio = new Audio(voice.previewUrl);
    audioRef.current = audio;
    setPlayingSlug(voice.slug);
    audio.addEventListener("ended", () => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPlayingSlug(null);
      }
    });
    try {
      await audio.play();
    } catch (err) {
      logError(`VoicePickerCards: preview ${voice.slug}`, err);
      if (audioRef.current === audio) audioRef.current = null;
      setPlayingSlug(null);
      setError("That preview couldn't play. Try it again.");
    }
  }

  async function choose(voice: BuddyVoice) {
    const locked = voice.paidOnly && paidLocked;
    if (locked) {
      onLockedVoice?.(voice);
      return;
    }
    if (savingSlug || voice.slug === selectedSlug) return;

    const previousSlug = selectedSlug;
    setSelectedSlug(voice.slug);
    setSavingSlug(voice.slug);
    setError(null);
    onSavingChange?.(true);
    try {
      const saved = await saveVoicePreference(voice.slug);
      setSelectedSlug(saved.voiceId);
    } catch (err) {
      logError(`VoicePickerCards: save ${voice.slug}`, err);
      setSelectedSlug(previousSlug);
      setError("That voice couldn't be saved. Your previous voice is still selected.");
      // If we optimistically let a lapsed account pick a paid voice, the backend
      // 403 lands here. Re-resolve so the padlocks appear on the next render
      // instead of the same click failing again.
      entitlement.refresh();
    } finally {
      setSavingSlug(null);
      onSavingChange?.(false);
    }
  }

  const ambientVoice = buddyVoices.find((voice) => voice.slug === playingSlug);

  return (
    <div
      className={`voice-picker-shell voice-picker-${surface}${playingSlug ? " is-playing" : ""}`}
      style={ambientVoice ? tintStyle(ambientVoice.tint) : tintStyle("#4fb3a5")}
    >
      <div className="voice-picker-ambient" aria-hidden="true" />
      <div className="voice-card-grid" role="radiogroup" aria-label="Buddy voices" aria-busy={!loaded}>
        {buddyVoices.map((voice) => {
          const selected = voice.slug === selectedSlug;
          const playing = voice.slug === playingSlug;
          const locked = voice.paidOnly && paidLocked;
          return (
            <div
              key={voice.slug}
              className={`voice-card${selected ? " is-selected" : ""}${playing ? " is-playing" : ""}${locked ? " is-locked" : ""}`}
              style={tintStyle(voice.tint)}
            >
              <button
                type="button"
                className="voice-card-choice"
                role="radio"
                aria-checked={selected}
                aria-label={`${selected ? "Selected" : "Choose"} ${voice.label}${locked ? ", paid voice" : ""}`}
                disabled={voice.slug === savingSlug}
                onClick={() => void choose(voice)}
              />
              <div className="voice-card-topline">
                <button
                  type="button"
                  className="voice-preview-button"
                  aria-label={`${playing ? "Stop" : "Preview"} ${voice.label}`}
                  onClick={() => void preview(voice)}
                >
                  {playing ? <Square size={15} fill="currentColor" aria-hidden /> : <Play size={18} fill="currentColor" aria-hidden />}
                </button>
                <span className="voice-card-state" aria-hidden="true">
                  {selected ? <CircleCheck size={20} /> : locked ? <LockKeyhole size={16} /> : null}
                </span>
              </div>
              <div className={`voice-waveform${playing ? " is-active" : ""}`} aria-hidden="true">
                {WAVE_HEIGHTS.map((height, index) => (
                  <span
                    key={`${voice.slug}-${index}`}
                    style={{ height, animationDelay: `${index * -73}ms` }}
                  />
                ))}
              </div>
              <div className="voice-card-copy">
                <strong>{voice.label}</strong>
                <span>{voice.blurb}</span>
              </div>
            </div>
          );
        })}
      </div>
      {!loaded && <p className="voice-picker-status">Loading your voice...</p>}
      {error && <p className="voice-picker-error" role="alert">{error}</p>}
    </div>
  );
}
