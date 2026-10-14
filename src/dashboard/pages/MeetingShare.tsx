import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, LoaderCircle } from "lucide-react";
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

/** Where a meeting can be sent, and the question its confirm asks. */
const DESTINATIONS: Partial<Record<PendingActionTool, (title: string, preview: PendingAction["preview"]) => string>> = {
  notion_save_meeting: (title, preview) => copy.confirmNotion(title, preview.account),
  slack_post_meeting: (title, preview) => copy.confirmSlack(title, preview.channel),
};

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
  if (error || (channels && channels.length === 0)) {
    return (
      <div className="db-meeting-action-status is-error" role="alert">
        <span>{error || copy.noChannels}</span>
        <button type="button" className="db-secondary-btn" onClick={onClose}>
          {copy.close}
        </button>
      </div>
    );
  }
  if (!channels) {
    return (
      <p className="db-meeting-action-status" role="status">
        <LoaderCircle size={15} className="db-meeting-spin" />
        {copy.loadingChannels}
      </p>
    );
  }
  return (
    <div className="db-meeting-action-status" role="group" aria-label={copy.pickChannel}>
      <span>{copy.pickChannel}</span>
      <select
        className="db-meeting-channel-select"
        value={picked}
        onChange={(event) => setPicked(event.target.value)}
      >
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            #{channel.name}{channel.isPrivate ? " (private)" : ""}
          </option>
        ))}
      </select>
      <button type="button" className="db-secondary-btn" onClick={onClose}>
        {copy.cancel}
      </button>
      <button
        type="button"
        className="db-primary-btn"
        disabled={!picked}
        onClick={() => setChosen(channels.find((channel) => channel.id === picked) ?? null)}
      >
        {copy.next}
      </button>
    </div>
  );
}

/**
 * Send a meeting's note somewhere outside Aura, through the same approval path
 * every connector write uses (juno-backend services/pending_actions.py): the
 * backend stores the action and builds the preview, this asks the user right
 * here on the Meetings page, and only Save calls approve. Proposed with origin
 * "meetings", so the overlay card and Home's Needs you never show it twice.
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

  if (phase === "proposing") {
    return (
      <p className="db-meeting-action-status" role="status">
        <LoaderCircle size={15} className="db-meeting-spin" />
        {copy.saving}
      </p>
    );
  }
  if (phase === "error") {
    return (
      <div className="db-meeting-action-status is-error" role="alert">
        <span>{error}</span>
        <button type="button" className="db-secondary-btn" onClick={onClose}>
          {copy.cancel}
        </button>
      </div>
    );
  }
  if (phase === "done" && action) {
    const ok = action.status === "done";
    return (
      <div className={`db-meeting-action-status${ok ? "" : " is-error"}`} role="status">
        <span>{pendingActionOutcomeCopy(action)}</span>
        {action.resultUrl && (
          <button
            type="button"
            className="db-secondary-btn"
            onClick={() => {
              const url = action.resultUrl;
              if (url) void openUrl(url).catch((err) => logError("MeetingShare: open", err));
            }}
          >
            <ExternalLink size={15} />
            {copy.open}
          </button>
        )}
        <button type="button" className="db-secondary-btn" onClick={onClose}>
          {copy.close}
        </button>
      </div>
    );
  }
  const question = DESTINATIONS[tool]?.(meeting.title || "this meeting", action?.preview ?? ({} as PendingAction["preview"])) ?? "";
  return (
    <div className="db-meeting-action-status" role="alert">
      <span>{question}</span>
      <button type="button" className="db-secondary-btn" disabled={phase === "saving"} onClick={cancel}>
        {copy.cancel}
      </button>
      <button type="button" className="db-primary-btn" disabled={phase === "saving"} onClick={() => void save()}>
        {phase === "saving" ? copy.saving : copy.save}
      </button>
    </div>
  );
}
