import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useDictationStatus } from "../../lib/dictationStatus";
import { voiceTriggerPhrase } from "../../lib/hotkeys";
import { useAuth } from "../../state/AuthProvider";
import { useHotkeyBindings } from "../../state/useHotkeyBindings";

interface StatusChip {
  key: string;
  tone: "ok" | "warn" | "neutral";
  label: string;
  route: string;
}

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Greeting plus a strip of chips that only speak up when something needs a
 * fix. Each chip opens the page where that fix lives. */
export function HomeHeader() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { voice } = useHotkeyBindings();
  const dictation = useDictationStatus();
  const now = new Date();
  const firstName = user?.displayName?.trim().split(/\s+/)[0] ?? "";

  const chips: StatusChip[] = [];
  if (voice && !voice.available) {
    chips.push({
      key: "voice",
      tone: "warn",
      label: voice.reason || "Voice shortcut is unavailable",
      route: "/voice",
    });
  } else if (voice) {
    chips.push({ key: "voice", tone: "ok", label: `Voice ready · ${voiceTriggerPhrase(voice)}`, route: "/voice" });
  }
  if (dictation && !dictation.available) {
    chips.push(
      dictation.blocker === "relaunch"
        ? { key: "dictation", tone: "warn", label: "Restart Aura to finish turning on dictation", route: "/dictation" }
        : dictation.blocker === "inputMonitoring"
          ? { key: "dictation", tone: "warn", label: "Dictation needs Input Monitoring", route: "/dictation" }
          : { key: "dictation", tone: "neutral", label: "Set up dictation", route: "/dictation" },
    );
  }

  return (
    <header className="db-home-head">
      <div>
        <h2 className="db-home-greeting">
          {firstName ? `${greeting(now)}, ${firstName}` : greeting(now)}
        </h2>
        <p className="db-home-date">
          {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </p>
      </div>
      {chips.length > 0 && (
        <div className="db-home-chips">
          {chips.map((chip) => (
            <button
              type="button"
              key={chip.key}
              className={`db-home-chip is-${chip.tone}`}
              onClick={() => navigate(chip.route)}
            >
              <span className="db-home-chip-dot" aria-hidden />
              {chip.label}
              {chip.tone !== "ok" && <ChevronRight size={14} aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
