import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { GlassSurface } from "./GlassSurface";
import { callVisual } from "./interview/callIcons";
import type { AmbientCallPayload } from "../lib/ipcEvents";
import { callLabel, meetingPrompt as copy } from "../lib/meetingCopy";
import { siteIcon } from "../lib/siteIconCache";
import googleMeetIcon from "../assets/icons/google-meet.png";
import type { UpcomingMeeting } from "../lib/calendar";
import {
  PROMPT_TIMEOUT_MS,
  type MeetingPromptState,
  type MeetingPromptStatus,
} from "./useMeetingPrompt";
import "./MeetingPromptCard.css";

/** Must fit the rendered CSS (Rust grows the window by exactly this many
 * logical px): the 11px inset that leaves room for the corner X, 12px
 * padding, the 24px header, a 10px gap, the 28px action row, 12px padding. */
export const MEETING_PROMPT_HEIGHT = 97;
/** Kept equal to the .meeting-prompt-leaving animation duration. */
export const MEETING_PROMPT_EXIT_MS = 200;

/** Meet's official product logo, bundled: meet.google.com's favicon is the
 * generic Google "G", not the Meet camera. */
const BUNDLED_ICON: Record<string, string> = {
  "google-meet": googleMeetIcon,
};

/** A browser-hosted call shows the meeting site's own icon, not the browser's. */
const SITE_ICON_HOST: Record<string, string> = {
  "teams-web": "teams.microsoft.com",
  "zoom-web": "zoom.us",
};

/** The detected app's real icon: the native app's own (read by Rust), else a
 * bundled logo, else the meeting site's favicon, else null while loading or
 * when none exists. */
function useCallIcon(call: AmbientCallPayload | null): string | null {
  const host = call ? SITE_ICON_HOST[call.app] ?? null : null;
  const [site, setSite] = useState<{ host: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void siteIcon(host).then((url) => {
      if (!cancelled) setSite({ host, url });
    });
    return () => {
      cancelled = true;
    };
  }, [host]);
  if (call?.appIcon) return call.appIcon;
  if (call && BUNDLED_ICON[call.app]) return BUNDLED_ICON[call.app];
  if (host && site?.host === host) return site.url;
  return null;
}

interface Shown {
  call: AmbientCallPayload;
  event: UpcomingMeeting | null;
  status: MeetingPromptStatus;
}

/**
 * "Record this ... call?" in the below-bar slot, shown by useMeetingPrompt
 * when the ambient scanner sees a call. Real <button>s only, per the
 * drag-region rule. The X straddles the top-right corner; the bar along the
 * bottom edge drains over the auto-dismiss window and pauses with the clock.
 */
export function MeetingPromptCard({
  prompt,
  leaving = false,
}: {
  prompt: MeetingPromptState;
  leaving?: boolean;
}) {
  // Snapshot of what was on screen, frozen while leaving: an exit caused by the
  // call going away has no call left to render, and hide() resets the status.
  const shownRef = useRef<Shown | null>(null);
  if (prompt.call && !leaving) {
    shownRef.current = { call: prompt.call, event: prompt.event, status: prompt.status };
  }
  const shown = shownRef.current;
  const iconUrl = useCallIcon(shown?.call ?? null);
  if (!shown) return null;

  const { call, event, status } = shown;
  const title = event ? copy.titleForEvent(event.title) : copy.title(callLabel(call.app));
  const answering = status === "prompt" || status === "starting";
  const starting = status === "starting";
  return (
    <GlassSurface
      className={`meeting-prompt-card${leaving ? " meeting-prompt-leaving" : ""}`}
      draggable={false}
    >
      <div className="meeting-prompt-clip">
        <div className="meeting-prompt-inner">
          <div className="meeting-prompt-header">
            <span className="meeting-prompt-icon">
              {iconUrl ? <img src={iconUrl} alt="" draggable={false} /> : callVisual(call.app, 22).icon}
            </span>
            <span className="meeting-prompt-title">{title}</span>
          </div>
          {answering ? (
            <div className="meeting-prompt-actions">
              <button
                type="button"
                className="meeting-prompt-snooze"
                onClick={prompt.snooze}
                disabled={starting || leaving}
              >
                {copy.snooze}
              </button>
              <button
                type="button"
                className="meeting-prompt-record"
                onClick={prompt.record}
                disabled={starting || leaving}
              >
                {starting ? copy.starting : copy.recordNow}
              </button>
            </div>
          ) : (
            <p className="meeting-prompt-status">
              {status === "cap" ? copy.capReached : copy.failed}
            </p>
          )}
        </div>
        {status === "prompt" && !leaving && (
          <div
            key={prompt.promptId}
            className={`meeting-prompt-drain${prompt.ticking ? " meeting-prompt-drain-running" : ""}`}
            style={{ animationDuration: `${PROMPT_TIMEOUT_MS}ms` }}
          />
        )}
      </div>
      <button
        type="button"
        className="meeting-prompt-close"
        onClick={prompt.decline}
        disabled={leaving}
        aria-label={copy.dismiss}
      >
        <X size={12} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </GlassSurface>
  );
}
