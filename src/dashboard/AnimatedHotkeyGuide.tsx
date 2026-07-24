import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { hotkeyHints } from "../lib/copy";
import { logError } from "../lib/log";

const ROTATE_MS = 4200;

interface VoiceToggleKeyStatus {
  available: boolean;
  keyLabel: string;
  reason?: string;
}

interface GuideItem {
  keys: string[];
  action: string;
  detail: string;
  available?: boolean;
}

export function AnimatedHotkeyGuide({ onTryVoice }: { onTryVoice: () => void }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceToggleKeyStatus | null>(null);

  useEffect(() => {
    invoke<VoiceToggleKeyStatus>("voice_toggle_key_status")
      .then(setVoiceStatus)
      .catch((err) => logError("AnimatedHotkeyGuide: voice status", err));
  }, []);

  const items = useMemo<GuideItem[]>(() => {
    const voiceKey = voiceStatus?.keyLabel || "Left Ctrl";
    return [
      {
        keys: [`Double tap ${voiceKey}`],
        action: "Double-tap to talk.",
        detail: voiceStatus?.available === false
          ? voiceStatus.reason || "This shortcut is unavailable on this device."
          : "Double-tap, then talk naturally.",
        available: voiceStatus?.available,
      },
      {
        keys: [...hotkeyHints.summon.keys],
        action: "Bring Aura back instantly.",
        detail: "Bring the companion forward from any app.",
      },
      {
        keys: [...hotkeyHints.dashboard.keys],
        action: "Your workspace is one shortcut away.",
        detail: "Return to this dashboard from anywhere.",
      },
      {
        keys: [...hotkeyHints.screenSight.keys],
        action: "Show Aura what you are working on.",
        detail: "Share your current screen only when you choose.",
      },
      {
        keys: ["Ctrl", "Alt", "G"],
        action: "Get guidance while your screen changes.",
        detail: "Let Aura follow meaningful screen changes while you work.",
      },
    ];
  }, [voiceStatus]);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % items.length), ROTATE_MS);
    return () => clearInterval(timer);
  }, [paused, items.length]);

  const item = items[index];
  return (
    <section
      className="db-hero-hotkey"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      aria-label="Aura keyboard shortcut guide"
    >
      <div className="db-hero-hotkey-slide" key={index}>
        <div className="db-hero-rotating-title">{item.action}</div>
        <div className="db-hero-hotkey-detail">{item.detail}</div>
        <div className={`db-hero-keycaps${item.available === false ? " unavailable" : ""}`}>
          {item.keys.map((key, keyIndex) => (
            <span key={`${key}:${keyIndex}`}>
              {keyIndex > 0 && <span className="db-hero-key-separator">
                {index === 0 ? "then" : "+"}
              </span>}
              <kbd style={{ animationDelay: `${keyIndex * 220}ms` }}>{key}</kbd>
            </span>
          ))}
        </div>
      </div>

      <div className="db-hero-hotkey-actions">
        {index === 0 && item.available !== false && (
          <button type="button" onClick={onTryVoice}>Start voice</button>
        )}
      </div>
    </section>
  );
}
