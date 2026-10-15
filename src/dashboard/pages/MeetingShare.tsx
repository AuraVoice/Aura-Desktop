import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ExternalLink, Hash, LoaderCircle, Lock } from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import {
  ConnectorReauthorizationRequiredError,
  fetchSlackChannels,
  type SlackChannel,
} from "../../lib/connectors";
import { logError } from "../../lib/log";
import { meetingShareCopy as copy } from "../../lib/meetingCopy";
import type { MeetingDoc } from "../../lib/meetings";
import {
  approvePendingAction,
  pendingActionOutcomeCopy,
  proposeAction,
  rejectPendingAction,
  type PendingAction,
  type PendingActionTool,
} from "../../lib/pendingActions";

/** Where a meeting can be sent: the dialog's title, what its confirm says, and
 *  the button that does it. */
const DESTINATIONS: Partial<Record<PendingActionTool, {
  title: string;
  question: (title: string, preview: PendingAction["preview"]) => string;
  confirm: string;
  working: string;
}>> = {
  notion_save_meeting: {
    title: copy.notion,
    question: (title, preview) => copy.confirmNotion(title, preview.account),
    confirm: copy.saveNotion,
    working: copy.saving,
  },
  slack_post_meeting: {
    title: copy.slack,
    question: (title, preview) => copy.confirmSlack(title, preview.channel),
    confirm: copy.postSlack,
    working: copy.posting,
  },
};

/** The centred dialog the Meetings page uses for sends and exports, the same
 *  panel as deleting local audio. Portalled into `.db-app` so it keeps the
 *  theme tokens. Escape and the scrim dismiss it unless a write is in flight. */
export function MeetingDialog({
  title,
  busy = false,
  onDismiss,
  children,
  actions,
}: {
  title: string;
  busy?: boolean;
  onDismiss: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  const titleId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onDismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onDismiss]);

  const host = document.querySelector(".db-app");
  if (!host) return null;
  return createPortal(
    <div className="db-local-confirm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button
        type="button"
        className="db-local-confirm-scrim"
        aria-label={copy.cancel}
        disabled={busy}
        onClick={onDismiss}
      />
      <div className="db-local-confirm-panel db-share-dialog">
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="db-local-confirm-actions">{actions}</div>
      </div>
    </div>,
    host,
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="db-share-dialog-waiting" role="status">
      <LoaderCircle size={15} className="db-meeting-spin" />
      {text}
    </p>
  );
}

/** The channel picker: every channel as a row, the picked one marked with a
 *  check. A radio group, so arrows move the pick, and Enter or a double click
 *  goes straight on to the confirm. */
function ChannelList({
  channels,
  picked,
  onPick,
  onChoose,
}: {
  channels: SlackChannel[];
  picked: string;
  onPick: (id: string) => void;
  onChoose: (channel: SlackChannel) => void;
}) {
  const labelId = useId();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const move = (step: number) => {
    const index = channels.findIndex((channel) => channel.id === picked);
    const next = channels[Math.min(channels.length - 1, Math.max(0, index + step))];
    if (!next) return;
    onPick(next.id);
    rowRefs.current.get(next.id)?.focus();
  };

  return (
    <div className="db-share-dialog-field">
      <span id={labelId}>{copy.pickChannel}</span>
      <div
        className="db-channel-list"
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        {channels.map((channel) => {
          const isPicked = channel.id === picked;
          return (
            <button
              key={channel.id}
              ref={(node) => {
                if (node) rowRefs.current.set(channel.id, node);
                else rowRefs.current.delete(channel.id);
              }}
              type="button"
              role="radio"
              aria-checked={isPicked}
              tabIndex={isPicked ? 0 : -1}
              autoFocus={isPicked}
              className={`db-channel-option${isPicked ? " is-picked" : ""}`}
              onClick={() => onPick(channel.id)}
              onDoubleClick={() => onChoose(channel)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onChoose(channel);
                }
              }}
            >
              {channel.isPrivate
                ? <Lock size={14} aria-hidden="true" />
                : <Hash size={15} aria-hidden="true" />}
              <span className="db-channel-name">{channel.name}</span>
              {channel.isPrivate && <span className="db-channel-tag">{copy.privateChannel}</span>}
              {isPicked && <Check size={16} className="db-channel-check" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Send to Slack: pick a channel the user is in, then the same confirm. */
export function MeetingSendToSlack({ meeting, onClose }: { meeting: MeetingDoc; onClose: () => void }) {
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState("");
  const [chosen, setChosen] = useState<SlackChannel | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSlackChannels()
      .then((rows) => {
        if (cancelled) return;
        setChannels(rows);
        setPicked(rows[0]?.id ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        logError("MeetingSendToSlack: channels", err);
        setError(err instanceof ConnectorReauthorizationRequiredError ? copy.reconnectSlack : copy.channelsFailed);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (chosen) {
    return (
      <MeetingShare
        meeting={meeting}
        tool="slack_post_meeting"
        extraArgs={{ channel_id: chosen.id, channel_name: chosen.name }}
        onClose={onClose}
      />
    );
  }
  const failed = error || (channels && channels.length === 0);
  return (
    <MeetingDialog
      title={copy.slack}
      onDismiss={onClose}
      actions={
        failed ? (
          <button type="button" className="db-local-confirm-cancel" autoFocus onClick={onClose}>
            {copy.close}
          </button>
        ) : (
          <>
            <button type="button" className="db-local-confirm-cancel" onClick={onClose}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="db-local-confirm-primary"
              disabled={!channels || !picked}
              onClick={() => setChosen(channels?.find((channel) => channel.id === picked) ?? null)}
            >
              {copy.next}
            </button>
          </>
        )
      }
    >
      {failed ? (
        <p role="alert">{error || copy.noChannels}</p>
      ) : !channels ? (
        <Waiting text={copy.loadingChannels} />
      ) : (
        <ChannelList
          channels={channels}
          picked={picked}
          onPick={setPicked}
          onChoose={(channel) => setChosen(channel)}
        />
      )}
    </MeetingDialog>
  );
}

/**
 * Send a meeting's note somewhere outside Aura, through the same approval path
 * every connector write uses (juno-backend services/pending_actions.py): the
 * backend stores the action and builds the preview, this asks the user in a
 * centred dialog on the Meetings page, and only the confirm button calls
 * approve. Proposed with origin "meetings", so the overlay card and Home's
 * Needs you never show it twice.
 */
export function MeetingShare({
  meeting,
  tool,
  extraArgs = {},
  onClose,
}: {
  meeting: MeetingDoc;
  tool: PendingActionTool;
  extraArgs?: Record<string, string>;
  onClose: () => void;
}) {
  const [action, setAction] = useState<PendingAction | null>(null);
  const [phase, setPhase] = useState<"proposing" | "confirm" | "saving" | "done" | "error">("proposing");
  const [error, setError] = useState("");
  // One request id per opened confirm, so a re-render never proposes twice.
  const requestId = useRef(`meeting-${meeting.meetingId}-${Date.now().toString(36)}`);
  const destination = DESTINATIONS[tool];

  useEffect(() => {
    let cancelled = false;
    proposeAction(
      tool,
      {
        meeting_id: meeting.meetingId,
        note_version: meeting.updatedAt,
        title: meeting.title,
        summary: meeting.editedNote?.summary ?? meeting.note?.summary ?? "",
        ...extraArgs,
      },
      requestId.current,
      "meetings",
    )
      .then((result) => {
        if (cancelled) return;
        if (result.kind === "proposed") {
          setAction(result.item);
          setPhase("confirm");
          return;
        }
        setError(result.kind === "notConnected" ? copy.notConnected : copy.failed);
        setPhase("error");
      })
      .catch((err) => {
        if (cancelled) return;
        logError(`MeetingShare(${tool}): propose`, err);
        setError(copy.failed);
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
    // extraArgs is fixed for the life of one confirm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.meetingId, tool]);

  const save = async () => {
    if (!action) return;
    setPhase("saving");
    try {
      const finished = await approvePendingAction(action.approvalId);
      setAction(finished ?? action);
      setPhase("done");
      trackEvent("meeting_shared", { tool, status: finished?.status ?? "unknown" });
    } catch (err) {
      logError(`MeetingShare(${tool}): approve`, err);
      setError(copy.failed);
      setPhase("error");
    }
  };

  const cancel = () => {
    if (action && phase === "confirm") {
      void rejectPendingAction(action.approvalId).catch((err) =>
        logError(`MeetingShare(${tool}): reject`, err),
      );
    }
    onClose();
  };

  const title = destination?.title ?? "";
  const closeOnly = (
    <button type="button" className="db-local-confirm-cancel" autoFocus onClick={onClose}>
      {copy.close}
    </button>
  );

  if (phase === "error") {
    return (
      <MeetingDialog title={title} onDismiss={onClose} actions={closeOnly}>
        <p role="alert">{error}</p>
      </MeetingDialog>
    );
  }
  if (phase === "done" && action) {
    const url = action.resultUrl;
    return (
      <MeetingDialog
        title={title}
        onDismiss={onClose}
        actions={
          <>
            {closeOnly}
            {url && (
              <button
                type="button"
                className="db-local-confirm-primary"
                onClick={() => void openUrl(url).catch((err) => logError("MeetingShare: open", err))}
              >
                <ExternalLink size={15} />
                {copy.open}
              </button>
            )}
          </>
        }
      >
        <p role="status">{pendingActionOutcomeCopy(action)}</p>
      </MeetingDialog>
    );
  }
  const saving = phase === "saving";
  return (
    <MeetingDialog
      title={title}
      busy={saving}
      onDismiss={cancel}
      actions={
        <>
          <button type="button" className="db-local-confirm-cancel" autoFocus disabled={saving} onClick={cancel}>
            {copy.cancel}
          </button>
          <button
            type="button"
            className="db-local-confirm-primary"
            disabled={phase !== "confirm"}
            onClick={() => void save()}
          >
            {saving ? destination?.working : destination?.confirm}
          </button>
        </>
      }
    >
      {phase === "proposing" ? (
        <Waiting text={copy.preparing} />
      ) : (
        <p>{destination?.question(meeting.title || "this meeting", action?.preview ?? ({} as PendingAction["preview"]))}</p>
      )}
    </MeetingDialog>
  );
}
