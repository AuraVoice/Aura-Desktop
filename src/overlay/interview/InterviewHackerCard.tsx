import { useEffect, useRef } from "react";
import iconUrl from "../../assets/icons/Aura-Icon.png";
import { GlassSurface } from "../GlassSurface";
import { StopSquareIcon } from "../icons";
import { PLANNED_MINUTES_OPTIONS, ROUND_KIND_OPTIONS } from "../../lib/interviewPolicy";
import { isInterviewCaptureActive } from "./useInterviewHacker";
import type { InterviewExchange, InterviewHackerState } from "./useInterviewHacker";
import "./InterviewHackerCard.css";

export const INTERVIEW_HACKER_SLOT_HEIGHT = 360;
/** Taller slot while the opening pitch is expanded. See OverlayRoot's slotHeight. */
export const INTERVIEW_HACKER_PITCH_SLOT_HEIGHT = 480;

/**
 * Segmented picker local to the overlay.
 *
 * Deliberately not `src/dashboard/components/SegmentedChoice`: the overlay has
 * no other dependency on dashboard components and should not grow one for a
 * two-row control.
 */
function OverlayChoice<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="interview-hacker-choice">
      <span>{label}</span>
      <div role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={option.value === value ? "is-selected" : ""}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Distance from the bottom, in px, within which the thread counts as "being
 * followed" and keeps auto-scrolling. Above it the reader has deliberately
 * scrolled back and must not be yanked forward by the next delta. */
const FOLLOW_THRESHOLD_PX = 48;

function Exchange({
  question,
  answer,
  unverified,
  live = false,
}: {
  question: string;
  answer: string;
  unverified: boolean;
  live?: boolean;
}) {
  return (
    <>
      {question && (
        <div className="interview-hacker-bubble is-question">{question}</div>
      )}
      {answer && (
        <div
          className="interview-hacker-bubble is-answer"
          aria-live={live ? "polite" : undefined}
        >
          {unverified && (
            <span className="interview-hacker-unverified">Not from your brief</span>
          )}
          <div className="interview-hacker-answer-text">{answer}</div>
        </div>
      )}
    </>
  );
}

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
  const threadRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is pinned to the bottom. Tracked from scroll events
  // rather than measured inside the effect, because by the time the effect runs
  // the new content is already in the DOM and "was I at the bottom?" can no
  // longer be answered from the current scroll position.
  const followingRef = useRef(true);
  const handleThreadScroll = () => {
    const thread = threadRef.current;
    if (!thread) return;
    followingRef.current =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight <= FOLLOW_THRESHOLD_PX;
  };
  useEffect(() => {
    const thread = threadRef.current;
    if (thread && followingRef.current) thread.scrollTop = thread.scrollHeight;
  }, [hacker.history, hacker.question, hacker.answer, hacker.interimQuestion]);

  const active = isInterviewCaptureActive(hacker.phase);
  const threadIsEmpty =
    hacker.history.length === 0
    && !hacker.question
    && !hacker.answer
    && !hacker.interimQuestion;
  const reflectionMode = ["ended", "reflecting", "reflection"].includes(hacker.phase);
  // Steady-state "listening" has no caption on purpose: the card being on
  // screen already says it is listening, and a line that never changes is chrome
  // in the one place the answer needs the room. Only actionable states speak.
  const status = hacker.candidateSpeaking
    ? "You are speaking. Answer held."
    : hacker.message
      ?? (hacker.phase === "paused"
        ? "Paused"
        : hacker.phase === "starting"
          ? "Starting transcription..."
          : hacker.phase === "checking"
            ? "Checking the active call..."
            : null);

  return (
    <GlassSurface className="interview-hacker-card">
      <div className="interview-hacker-inner">
        {(status || (active && hacker.pacingCaption)) && (
          <div className="interview-hacker-header">
            <div>{status && <div className="interview-hacker-status">{status}</div>}</div>
            {active && hacker.pacingCaption && (
              <div className="interview-hacker-pacing" aria-live="polite">{hacker.pacingCaption}</div>
            )}
          </div>
        )}

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
          <div className="interview-hacker-round">
            <OverlayChoice
              label="Round"
              options={ROUND_KIND_OPTIONS}
              value={hacker.roundKind}
              onChange={hacker.setRoundKind}
            />
            <OverlayChoice
              label="Planned length"
              options={PLANNED_MINUTES_OPTIONS}
              value={hacker.plannedMinutes}
              onChange={hacker.setPlannedMinutes}
            />
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

        {active && hacker.pitch && (
          <div className="interview-hacker-pitch" data-expanded={hacker.pitchExpanded}>
            <div className="interview-hacker-pitch-head">
              <span>Your opening pitch</span>
              <button
                type="button"
                onClick={hacker.togglePitch}
                aria-expanded={hacker.pitchExpanded}
              >
                {hacker.pitchExpanded ? "Collapse" : "Expand"}
              </button>
            </div>
            {hacker.pitchExpanded && (
              <>
                <ul>
                  {hacker.pitch.lines.map((line) => (
                    <li key={line.lineId}>
                      <span>{line.label}</span>
                      <p>{line.text}</p>
                    </li>
                  ))}
                </ul>
                <div className="interview-hacker-pitch-foot">
                  {hacker.pitch.sourceIds.length === 1
                    ? "1 confirmed source"
                    : `${hacker.pitch.sourceIds.length} confirmed sources`}
                </div>
              </>
            )}
          </div>
        )}

        {active && (
          <div
            className="interview-hacker-thread"
            ref={threadRef}
            onScroll={handleThreadScroll}
          >
            {hacker.history.map((exchange: InterviewExchange) => (
              <Exchange
                key={exchange.id}
                question={exchange.question}
                answer={exchange.answer}
                unverified={exchange.unverified}
              />
            ))}
            {(hacker.question || hacker.answer) && (
              <Exchange
                question={hacker.question}
                answer={hacker.answer}
                unverified={!hacker.briefReady}
                live
              />
            )}
            {hacker.interimQuestion && (
              <div className="interview-hacker-bubble is-question is-pending">
                {hacker.interimQuestion}
              </div>
            )}
            {threadIsEmpty && (
              <div className="interview-hacker-thread-empty">
                Questions and answers appear here.
              </div>
            )}
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
