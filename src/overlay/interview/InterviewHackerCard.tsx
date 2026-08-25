import iconUrl from "../../assets/icons/Aura-Icon.png";
import { GlassSurface } from "../GlassSurface";
import { StopSquareIcon } from "../icons";
import { isInterviewCaptureActive } from "./useInterviewHacker";
import type { InterviewHackerState } from "./useInterviewHacker";
import "./InterviewHackerCard.css";

export const INTERVIEW_HACKER_SLOT_HEIGHT = 360;

export function InterviewHackerControlBar({
  expanded,
  onToggle,
  onStop,
}: {
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
}) {
  return (
    <GlassSurface className="interview-hacker-control-bar">
      <div className="interview-hacker-control-inner">
        <div className="interview-hacker-aura-mark" aria-label="Aura">
          <img src={iconUrl} alt="" />
        </div>
        <button
          type="button"
          className="interview-hacker-visibility-button"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d={expanded ? "M5 7.5 10 12.5 15 7.5" : "M5 12.5 10 7.5 15 12.5"} />
          </svg>
          {expanded ? "Hide" : "Unhide"}
        </button>
        <button
          type="button"
          className="interview-hacker-stop-button"
          onClick={onStop}
          aria-label="Stop Interview Companion"
          title="Stop Interview Companion"
        >
          <StopSquareIcon />
        </button>
      </div>
    </GlassSurface>
  );
}

export function InterviewHackerCard({
  hacker,
}: {
  hacker: InterviewHackerState;
}) {
  const active = isInterviewCaptureActive(hacker.phase);
  const reflectionMode = ["ended", "reflecting", "reflection"].includes(hacker.phase);
  const status = hacker.candidateSpeaking
    ? "You are speaking. Answer held."
    : hacker.message
      ?? (hacker.phase === "paused"
        ? "Paused"
        : hacker.phase === "listening"
          ? "Listening for interviewer questions"
          : hacker.phase === "starting"
            ? "Starting transcription..."
            : hacker.phase === "checking"
              ? "Checking the active call..."
              : null);

  return (
    <GlassSurface className="interview-hacker-card">
      <div className="interview-hacker-inner">
        <div className="interview-hacker-header">
          <div>
            <div className="interview-hacker-title">Interview Companion</div>
            {status && <div className="interview-hacker-status">{status}</div>}
          </div>
        </div>

        {(hacker.phase === "preflight" || hacker.phase === "checking") && (
          <div className="interview-hacker-preflight">
            <div className="interview-hacker-source">
              <span>You</span>
              <strong>Microphone</strong>
            </div>
            <div className="interview-hacker-source">
              <span>Call</span>
              <strong>{hacker.callName ?? "Checking..."}</strong>
            </div>
            <div className="interview-hacker-source">
              <span>Brief</span>
              <strong>{hacker.briefReady ? "Reviewed and ready" : "Not prepared"}</strong>
            </div>
          </div>
        )}

        {hacker.phase === "preflight" && (
          <button
            type="button"
            className="interview-hacker-primary"
            onClick={hacker.start}
          >
            Start Interview Companion
          </button>
        )}

        {hacker.phase === "error" && !active && (
          <button
            type="button"
            className="interview-hacker-primary"
            onClick={hacker.recoverable ? hacker.resume : hacker.openPreflight}
          >
            {hacker.recoverable ? "Retry transcription" : "Check again"}
          </button>
        )}

        {hacker.errorDetail && (
          <details className="interview-hacker-error-detail">
            <summary>Error details</summary>
            <code>{hacker.errorDetail}</code>
          </details>
        )}

        {active && (
          <div className="interview-hacker-response">
            <div className="interview-hacker-transcript" aria-live="polite">
              <span>Interviewer</span>
              <div>{hacker.question || "Questions will appear here."}</div>
            </div>
            <div className="interview-hacker-answer" aria-live="polite">
              <span>Suggested answer</span>
              <div>{hacker.answer || "Answers will appear here."}</div>
            </div>
          </div>
        )}

        {active && hacker.phase !== "starting" && (
          <div className="interview-hacker-answer-actions">
            <button type="button" disabled={!hacker.canSuggest || hacker.candidateSpeaking} onClick={hacker.suggest}>Suggest</button>
            <button type="button" disabled={!hacker.answer || hacker.candidateSpeaking} onClick={hacker.shorter}>Shorter</button>
            <button type="button" disabled={!hacker.answer || hacker.candidateSpeaking} onClick={hacker.anotherExample}>Another example</button>
            <button type="button" disabled={!hacker.answer || hacker.candidateSpeaking} onClick={hacker.moreTechnical}>More technical</button>
            <button
              type="button"
              disabled={!hacker.canSuggest || hacker.candidateSpeaking || hacker.capturingScreen || hacker.phase !== "listening"}
              onClick={hacker.screenSight}
            >
              {hacker.capturingScreen ? "Looking..." : "Screen Sight"}
            </button>
          </div>
        )}

        {reflectionMode && hacker.phase !== "reflection" && (
          <div className="interview-hacker-answer">
            {hacker.phase === "reflecting"
              ? "Aura is building a private reflection from this session."
              : "The interview transcript is still in memory for this card. Nothing has been saved."}
          </div>
        )}

        {hacker.phase === "reflection" && hacker.reflection && (
          <div className="interview-hacker-answer interview-hacker-reflection">
            <p>{hacker.reflection.summary}</p>
            {hacker.reflection.strengths.length > 0 && <h4>Strengths</h4>}
            {hacker.reflection.strengths.length > 0 && <ul>{hacker.reflection.strengths.map((item) => <li key={item}>{item}</li>)}</ul>}
            {hacker.reflection.improvements.length > 0 && <h4>Improve next time</h4>}
            {hacker.reflection.improvements.length > 0 && <ul>{hacker.reflection.improvements.map((item) => <li key={item}>{item}</li>)}</ul>}
            {hacker.reflection.followUpActions.length > 0 && <h4>Follow-up actions</h4>}
            {hacker.reflection.followUpActions.length > 0 && <ul>{hacker.reflection.followUpActions.map((item) => <li key={item}>{item}</li>)}</ul>}
          </div>
        )}

        {reflectionMode && (
          <div className="interview-hacker-controls">
            <button type="button" className="interview-hacker-text-button" onClick={hacker.dismissReflection}>Dismiss</button>
            {hacker.phase === "ended" && <button type="button" className="interview-hacker-primary" onClick={hacker.reflect}>Reflect</button>}
            {hacker.phase === "reflection" && <button type="button" className="interview-hacker-primary" disabled={hacker.savingReflection} onClick={hacker.saveReflection}>{hacker.savingReflection ? "Saving" : "Save reflection"}</button>}
          </div>
        )}
      </div>
    </GlassSurface>
  );
}
