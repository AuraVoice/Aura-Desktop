import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Mic } from "lucide-react";
import { GlassSurface } from "./GlassSurface";
import { MEETING_SILENCE, type MeetingSilencePayload } from "../lib/ipcEvents";
import { logError } from "../lib/log";
import { meetingSilenceCopy as copy } from "../lib/meetingCopy";
import { useTauriEvent } from "../lib/useTauriEvent";
import "./MeetingPromptCard.css";

export interface MeetingSilenceState {
  /** The engine heard no one for a while and will stop the capture. */
  warning: boolean;
  /** Seconds left when the warning arrived; drives the drain bar. */
  stopsInS: number;
  /** Bumped per warning so the drain restarts on a second one. */
  warningId: number;
  keepRecording: () => void;
  stopNow: () => void;
}

/**
 * Rust's silence auto-stop (meeting/audio.rs): after ten minutes with no
 * speech on a live capture it warns, and stops a minute later unless someone
 * speaks or the user keeps recording. A warning brings the bar up so the card
 * is seen; Rust clears it itself when speech returns or the capture ends.
 */
export function useMeetingSilence(): MeetingSilenceState {
  const [state, setState] = useState({ warning: false, stopsInS: 60, warningId: 0 });

  useTauriEvent<MeetingSilencePayload>(
    MEETING_SILENCE,
    (payload) => {
      setState((current) => ({
        warning: payload.warning,
        stopsInS: payload.stopsInS,
        warningId: payload.warning ? current.warningId + 1 : current.warningId,
      }));
      if (payload.warning) {
        void invoke("summon_bar").catch((err) => logError("useMeetingSilence: summon_bar", err));
      }
    },
    "useMeetingSilence: listen",
  );

  const keepRecording = useCallback(() => {
    setState((current) => ({ ...current, warning: false }));
    void invoke("meeting_keep_recording").catch((err) =>
      logError("useMeetingSilence: keep recording", err),
    );
  }, []);

  const stopNow = useCallback(() => {
    setState((current) => ({ ...current, warning: false }));
    void invoke("stop_meeting_capture", { reason: "stopped_by_user" }).catch((err) =>
      logError("useMeetingSilence: stop", err),
    );
  }, []);

  return { ...state, keepRecording, stopNow };
}

/** "No one's talking" in the notch slot, in the Record prompt's shape and
 *  height (MEETING_PROMPT_HEIGHT): the two never show at once, since the
 *  prompt hides while a capture runs and this exists only during one. */
export function MeetingSilenceCard({ silence }: { silence: MeetingSilenceState }) {
  return (
    <GlassSurface className="meeting-prompt-card theme-pinned-dark" draggable={false}>
      <div className="meeting-prompt-clip">
        <div className="meeting-prompt-inner">
          <div className="meeting-prompt-header">
            <span className="meeting-prompt-icon">
              <Mic size={18} aria-hidden="true" />
            </span>
            <span className="meeting-prompt-title">{copy.title}</span>
          </div>
          <p className="meeting-prompt-consent">{copy.detail(silence.stopsInS)}</p>
          <div className="meeting-prompt-actions">
            <button type="button" className="meeting-prompt-snooze" onClick={silence.stopNow}>
              {copy.stopNow}
            </button>
            <button type="button" className="meeting-prompt-record" onClick={silence.keepRecording}>
              {copy.keepRecording}
            </button>
          </div>
        </div>
        <div
          key={silence.warningId}
          className="meeting-prompt-drain meeting-prompt-drain-running"
          style={{ animationDuration: `${silence.stopsInS * 1000}ms` }}
        />
      </div>
    </GlassSurface>
  );
}
