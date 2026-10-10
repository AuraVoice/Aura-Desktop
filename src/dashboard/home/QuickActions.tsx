import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { chordKeysOf, useDictationStatus } from "../../lib/dictationStatus";
import { START_VOICE_REQUESTED } from "../../lib/ipcEvents";
import { logError } from "../../lib/log";
import { useHotkeyBindings } from "../../state/useHotkeyBindings";
import { agentsPath } from "../pages/AgentsPage";

/* Hand-drawn glyphs, cropped to lucide's ~20 unit live area so they sit with the
   sidebar's icons. Each takes its tone from the tile via currentColor. */
const GLYPHS: Record<string, ReactNode> = {
  talk: <path d="M4 10v4M8 7v10M12 3v18M16 7v10M20 10v4" />,
  chat: (
    <>
      <path d="M3 5h18v11H10l-5 4v-4H3z" strokeLinejoin="round" />
      <path d="M8 10.5h8" />
    </>
  ),
  dictate: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
    </>
  ),
  meetings: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </>
  ),
  research: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21" />
    </>
  ),
  swarm: (
    <>
      <circle cx="6" cy="7" r="3" />
      <circle cx="18" cy="7" r="3" />
      <circle cx="12" cy="18" r="3" />
      <path d="M8.5 9 11 15.5M15.5 9 13 15.5M9 7h6" />
    </>
  ),
};

interface QuickAction {
  id: keyof typeof GLYPHS;
  name: string;
  desc: string;
  keys: string[];
  tone: "teal" | "violet" | "cyan" | "ember";
  run: () => void;
}

/** Verbs first, each with its real shortcut, so Home teaches the hotkeys by
 * being used. Every key label comes from the live bindings, never a literal. */
export function QuickActions() {
  const navigate = useNavigate();
  const { bindings, voice } = useHotkeyBindings();
  const dictation = useDictationStatus();
  const chat = bindings.find((binding) => binding.id === "chat");

  const voiceKeys = !voice
    ? []
    : voice.gesture === "doubleTap"
      ? [`2× ${voice.keyLabel}`]
      : voice.keys;

  const actions: QuickAction[] = [
    {
      id: "talk",
      name: "Talk",
      desc: "Voice call with Aura",
      keys: voiceKeys,
      tone: "teal",
      run: () =>
        void emitTo("main", START_VOICE_REQUESTED).catch((err) =>
          logError("HomePage: start voice", err),
        ),
    },
    {
      id: "chat",
      name: "Chat",
      desc: "Type a question",
      keys: chat?.registered ? chat.keys : [],
      tone: "violet",
      run: () => void invoke("summon_chat").catch((err) => logError("HomePage: open chat", err)),
    },
    {
      id: "dictate",
      name: "Dictate",
      desc: "Type by voice in any app",
      keys: dictation?.available ? ["Hold", ...chordKeysOf(dictation)] : [],
      tone: "cyan",
      run: () => navigate("/dictation"),
    },
    {
      id: "meetings",
      name: "Meetings",
      desc: "Notes and recordings",
      keys: [],
      tone: "ember",
      run: () => navigate("/meetings"),
    },
    {
      id: "research",
      name: "Research",
      desc: "Deep dive on a topic",
      keys: [],
      tone: "teal",
      run: () => navigate(agentsPath("research")),
    },
    {
      id: "swarm",
      name: "Swarm",
      desc: "Hand work to your managers",
      keys: [],
      tone: "violet",
      run: () => navigate(agentsPath("swarm")),
    },
  ];

  return (
    <section className="db-home-actions" aria-label="Quick actions">
      {actions.map((action) => (
        <button
          type="button"
          key={action.id}
          className={`db-home-action is-${action.tone}`}
          onClick={action.run}
        >
          <svg
            className="db-home-action-glyph"
            viewBox="2 2 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden
          >
            {GLYPHS[action.id]}
          </svg>
          <span className="db-home-action-text">
            <span className="db-home-action-name">{action.name}</span>
            <span className="db-home-action-desc">{action.desc}</span>
          </span>
          {action.keys.length > 0 && (
            <span className="db-home-keys">
              {action.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </span>
          )}
        </button>
      ))}
    </section>
  );
}
