import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { emitTo } from "@tauri-apps/api/event";
import { AudioLines, Bookmark, FileText, Smartphone, Mic, Video } from "lucide-react";
import type { HistorySessions, RawDraft, RawScreenSave } from "../../lib/dashboardApi";
import { START_VOICE_REQUESTED } from "../../lib/ipcEvents";
import { logError } from "../../lib/log";
import type { MeetingDoc } from "../../lib/meetings";
import { bodyAfterTitle, deriveDraftTitle, deriveSessionTitle, relativeTime } from "../format";
import { historyPath } from "../pages/HistoryPage";
import { meetingPath } from "../pages/MeetingsPage";
import { HomeRow, type HomeRowTone } from "./HomeRow";
import type { ResourceHandle } from "../useDashboardResource";

interface JumpCard {
  key: string;
  kind: string;
  tone: HomeRowTone;
  icon: ReactNode;
  title: string;
  sub: string;
  when: string;
  open: () => void;
}

function newest<T>(items: T[], at: (item: T) => string): T | null {
  let best: T | null = null;
  let bestAt = -Infinity;
  for (const item of items) {
    const time = new Date(at(item)).getTime();
    if (time > bestAt) {
      best = item;
      bestAt = time;
    }
  }
  return best;
}

/** The newest item of each kind, titled by its content, each opening that
 * exact item. A user with nothing yet gets starter cards instead. */
export function JumpBackIn({
  history,
  drafts,
  saves,
  meetings,
}: {
  history: ResourceHandle<HistorySessions>;
  drafts: ResourceHandle<RawDraft[]>;
  saves: ResourceHandle<RawScreenSave[]>;
  meetings: ResourceHandle<MeetingDoc[]>;
}) {
  const navigate = useNavigate();
  const cards: JumpCard[] = [];

  const session = newest(history.data?.sessions ?? [], (s) => s.started_at);
  if (session) {
    cards.push({
      key: "conversation",
      kind: "Conversation",
      tone: "violet",
      icon: <AudioLines size={16} />,
      title: deriveSessionTitle(session.summary),
      sub: session.num_of_turns > 0 ? `${session.num_of_turns} turns` : "Voice conversation",
      when: relativeTime(session.started_at),
      open: () => navigate(historyPath("conversations", session.session_id)),
    });
  }
  const draft = newest(drafts.data ?? [], (d) => d.updated_at || d.created_at);
  if (draft) {
    cards.push({
      key: "draft",
      kind: "Draft",
      tone: "cyan",
      icon: <FileText size={16} />,
      title: deriveDraftTitle(draft.text),
      sub: bodyAfterTitle(draft.text) || draft.context_summary,
      when: relativeTime(draft.updated_at || draft.created_at),
      open: () => navigate(historyPath("drafts", draft.draft_id)),
    });
  }
  const save = newest(saves.data ?? [], (s) => s.created_at);
  if (save) {
    cards.push({
      key: "saved",
      kind: "Saved",
      tone: "teal",
      icon: <Bookmark size={16} />,
      title: save.title || "Saved item",
      sub: save.description || save.note,
      when: relativeTime(save.created_at),
      open: () => navigate(historyPath("saved")),
    });
  }
  const meeting = newest(meetings.data ?? [], (m) => m.createdAt);
  if (meeting) {
    cards.push({
      key: "meeting",
      kind: "Meeting",
      tone: "ember",
      icon: <Video size={16} />,
      title: meeting.title || "Meeting",
      sub: meeting.note?.summary
        || (meeting.status === "ready"
          ? "Notes ready"
          : meeting.status === "failed" || meeting.status === "needs_attention"
            ? "Needs a look"
            : meeting.status === "excluded"
              ? "No notes for this one"
              : "Notes on the way"),
      when: relativeTime(meeting.createdAt),
      open: () => navigate(meetingPath(meeting.meetingId)),
    });
  }

  const loading = cards.length === 0
    && (history.loading || drafts.loading || saves.loading || meetings.loading);
  const starter = cards.length === 0 && !loading;

  const starterCards: JumpCard[] = [
    {
      key: "talk",
      kind: "Start here",
      tone: "teal",
      icon: <Mic size={16} />,
      title: "Say hi to Aura",
      sub: "Start a voice call and ask about whatever is on your screen.",
      when: "Takes 30 seconds",
      open: () =>
        void emitTo("main", START_VOICE_REQUESTED).catch((err) => logError("HomePage: start voice", err)),
    },
    {
      key: "dictate",
      kind: "Start here",
      tone: "cyan",
      icon: <FileText size={16} />,
      title: "Dictate into any app",
      sub: "Hold the shortcut, speak, and Aura types it for you.",
      when: "Takes a minute",
      open: () => navigate("/dictation"),
    },
    {
      key: "meeting",
      kind: "Start here",
      tone: "ember",
      icon: <Video size={16} />,
      title: "Record your next meeting",
      sub: "Get notes and action items when the call ends.",
      when: "On your next call",
      open: () => navigate("/meetings"),
    },
    {
      key: "mobile",
      kind: "Start here",
      tone: "violet",
      icon: <Smartphone size={16} />,
      title: "Get Aura on your phone",
      sub: "Your history follows you across devices.",
      when: "Takes 2 minutes",
      open: () => navigate("/mobile"),
    },
  ];

  return (
    <section className="db-home-panel" aria-labelledby="db-home-jump-title">
      <div className="db-home-panel-head">
        <h3 id="db-home-jump-title">{starter ? "Start here" : "Jump back in"}</h3>
        {!starter && (
          <button type="button" className="db-link" onClick={() => navigate(historyPath("conversations"))}>
            All history
          </button>
        )}
      </div>
      {loading ? (
        <div className="db-home-skeleton" aria-hidden>
          <span />
          <span />
        </div>
      ) : (
        <div className="db-home-rows">
          {(starter ? starterCards : cards).map((card) => (
            <HomeRow
              key={card.key}
              icon={card.icon}
              tone={card.tone}
              title={card.title}
              detail={starter ? card.sub : [card.kind, card.sub].filter(Boolean).join(" · ")}
              time={card.when}
              onClick={card.open}
            />
          ))}
        </div>
      )}
    </section>
  );
}
