import { GlassSurface } from "../GlassSurface";
import { isInterviewCaptureActive } from "./useInterviewCompanion";
import type { InterviewCompanionState } from "./useInterviewCompanion";
import "./InterviewCompanionCard.css";

export const INTERVIEW_COMPANION_SLOT_HEIGHT = 360;

export function InterviewCompanionCard({
  companion,
}: {
  companion: InterviewCompanionState;
}) {
  const active = isInterviewCaptureActive(companion.phase);
  const reflectionMode = ["ended", "reflecting", "reflection"].includes(companion.phase);
  const status = companion.candidateSpeaking
    ? "You are speaking. Answer held."
    : companion.message
      ?? (companion.phase === "paused"
        ? "Paused"
        : companion.phase === "listening"
          ? "Listening for interviewer questions"
          : companion.phase === "starting"
            ? "Starting transcription..."
            : companion.phase === "checking"
              ? "Checking the active call..."
              : null);

  return (
    <GlassSurface className="interview-companion-card" draggable={false}>
      <div className="interview-companion-inner">
        <div className="interview-companion-header">
          <div>
            <div className="interview-companion-title">Interview Companion</div>
            {status && <div className="interview-companion-status">{status}</div>}
          </div>
          {active || companion.phase === "error" ? (
            <button
              type="button"
              className="interview-companion-text-button"
              onClick={companion.stop}
            >
              Stop
            </button>
          ) : (
            // Every non-capturing phase needs its own way out. Checking and
            // preflight had none, and the card suppresses chat and Escape while
            // it is open, so there was nothing left to close it with.
            !reflectionMode && (
              <button
                type="button"
                className="interview-companion-text-button"
                onClick={companion.dismiss}
              >
                Cancel
              </button>
            )
          )}
        </div>

        {(companion.phase === "preflight" || companion.phase === "checking") && (
          <div className="interview-companion-preflight">
            <div className="interview-companion-source">
              <span>You</span>
              <strong>Microphone</strong>
            </div>
            <div className="interview-companion-source">
              <span>Call</span>
              <strong>{companion.callName ?? "Checking..."}</strong>
            </div>
            <div className="interview-companion-source">
              <span>Brief</span>
              <strong>{companion.briefReady ? "Reviewed and ready" : "Not prepared"}</strong>
            </div>
          </div>
        )}

        {companion.phase === "preflight" && (
          <button
            type="button"
            className="interview-companion-primary"
            onClick={companion.start}
          >
            Start Interview Companion
          </button>
        )}

        {companion.phase === "error" && !active && (
          <button
            type="button"
            className="interview-companion-primary"
            onClick={companion.recoverable ? companion.resume : companion.openPreflight}
          >
            {companion.recoverable ? "Retry transcription" : "Check again"}
          </button>
        )}

        {active && (
          <div className="interview-companion-answer" aria-live="polite">
            {companion.answer || "Answers will appear here."}
          </div>
        )}

        {active && companion.phase !== "starting" && (
          <div className="interview-companion-answer-actions">
            <button type="button" disabled={!companion.canSuggest || companion.candidateSpeaking} onClick={companion.suggest}>Suggest</button>
            <button type="button" disabled={!companion.answer || companion.candidateSpeaking} onClick={companion.shorter}>Shorter</button>
            <button type="button" disabled={!companion.answer || companion.candidateSpeaking} onClick={companion.anotherExample}>Another example</button>
            <button type="button" disabled={!companion.answer || companion.candidateSpeaking} onClick={companion.moreTechnical}>More technical</button>
            <button
              type="button"
              disabled={!companion.canSuggest || companion.candidateSpeaking || companion.capturingScreen || companion.phase !== "listening"}
              onClick={companion.screenSight}
            >
              {companion.capturingScreen ? "Looking..." : "Screen Sight"}
            </button>
          </div>
        )}

        {active && companion.phase !== "starting" && (
          <div className="interview-companion-controls">
            {companion.phase === "paused" ? (
              <button
                type="button"
                className="interview-companion-primary"
                onClick={companion.resume}
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                className="interview-companion-secondary"
                onClick={companion.pause}
              >
                Pause
              </button>
            )}
          </div>
        )}

        {reflectionMode && companion.phase !== "reflection" && (
          <div className="interview-companion-answer">
            {companion.phase === "reflecting"
              ? "Aura is building a private reflection from this session."
              : "The interview transcript is still in memory for this card. Nothing has been saved."}
          </div>
        )}

        {companion.phase === "reflection" && companion.reflection && (
          <div className="interview-companion-answer interview-companion-reflection">
            <p>{companion.reflection.summary}</p>
            {companion.reflection.strengths.length > 0 && <h4>Strengths</h4>}
            {companion.reflection.strengths.length > 0 && <ul>{companion.reflection.strengths.map((item) => <li key={item}>{item}</li>)}</ul>}
            {companion.reflection.improvements.length > 0 && <h4>Improve next time</h4>}
            {companion.reflection.improvements.length > 0 && <ul>{companion.reflection.improvements.map((item) => <li key={item}>{item}</li>)}</ul>}
            {companion.reflection.followUpActions.length > 0 && <h4>Follow-up actions</h4>}
            {companion.reflection.followUpActions.length > 0 && <ul>{companion.reflection.followUpActions.map((item) => <li key={item}>{item}</li>)}</ul>}
          </div>
        )}

        {reflectionMode && (
          <div className="interview-companion-controls">
            <button type="button" className="interview-companion-text-button" onClick={companion.dismissReflection}>Dismiss</button>
            {companion.phase === "ended" && <button type="button" className="interview-companion-primary" onClick={companion.reflect}>Reflect</button>}
            {companion.phase === "reflection" && <button type="button" className="interview-companion-primary" disabled={companion.savingReflection} onClick={companion.saveReflection}>{companion.savingReflection ? "Saving" : "Save reflection"}</button>}
          </div>
        )}
      </div>
    </GlassSurface>
  );
}
