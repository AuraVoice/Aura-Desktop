import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import iconUrl from "../../assets/icons/Aura-Icon.png";
import { logError } from "../../lib/log";
import { GlassSurface } from "../GlassSurface";
import { ChevronDownIcon, DocumentIcon, DownArrowIcon, MicIcon, MicOffIcon, StopSquareIcon, UploadArrowIcon } from "../icons";
import { callVisual } from "./callIcons";
import { useMicPreflightLevel } from "./useMicPreflightLevel";
import { RESUME_ACCEPT } from "../../lib/resumeText";
import { PLANNED_MINUTES_OPTIONS, ROUND_KIND_OPTIONS } from "../../lib/interviewPolicy";
import { isInterviewCaptureActive } from "./useInterviewHacker";
import type { InterviewExchange, InterviewHackerState } from "./useInterviewHacker";
import "./InterviewHackerCard.css";

// The overlay is always-on-top by a static, once-at-creation setting (see
// overlay::set_dialog_friendly on the Rust side for the full story). A native
// file-open dialog is an ordinary, non-topmost window, so left as-is it
// renders trapped underneath the overlay and neither it nor the overlay can
// be clicked. Toggling this around the dialog's lifetime is idempotent on the
// Rust side, so callers never need to track whether it is already applied.
function setOverlayDialogFriendly(friendly: boolean) {
  void invoke("set_overlay_dialog_friendly", { friendly }).catch((error: unknown) =>
    logError("InterviewHackerCard: set_overlay_dialog_friendly", error),
  );
}

export const INTERVIEW_HACKER_SLOT_HEIGHT = 420;
/** Preflight is the tallest non-pitch state: three widgets with icon bands, both
 * pickers with their pills wrapped, and the Start button. Measured against the
 * six-option Round row wrapping to three lines, which is the worst case. */
export const INTERVIEW_HACKER_PREFLIGHT_SLOT_HEIGHT = 420;
/** Taller slot while the opening pitch is expanded. See OverlayRoot's slotHeight. */
export const INTERVIEW_HACKER_PITCH_SLOT_HEIGHT = 480;
/** Preflight height plus room for the Brief switcher popover (a handful of
 * rows plus the "start fresh" action) before it scrolls internally. See
 * OverlayRoot's slotHeight - the overlay window is physically resized to
 * this, it is not free CSS overflow. */
export const INTERVIEW_HACKER_BRIEF_MENU_SLOT_HEIGHT = 620;

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

/**
 * The three preflight widgets.
 *
 * Each one answers "is this leg actually working" rather than restating what the
 * feature is: the mic shows live level, the call shows the app's own mark, and
 * the brief is the place a resume gets attached when nothing was prepared.
 */

function MicSource({ active }: { active: boolean }) {
  const mic = useMicPreflightLevel(active);
  const blocked = mic.status === "denied" || mic.status === "no-device";
  const caption =
    mic.status === "denied"
      ? "Blocked"
      : mic.status === "no-device"
        ? "No mic found"
        : mic.status === "requesting"
          ? "Checking..."
          : "Speak to test";
  return (
    <div className={`interview-hacker-source${blocked ? " is-warning" : ""}`}>
      <span>You</span>
      <div className="interview-hacker-source-body">
        <i className="interview-hacker-source-icon" aria-hidden="true">
          {blocked ? <MicOffIcon /> : <MicIcon />}
        </i>
        <div
          className="interview-hacker-meter"
          role="img"
          aria-label={mic.status === "live" ? "Microphone level" : caption}
        >
          {mic.bars.map((height, index) => (
            <span
              key={index}
              style={{ transform: `scaleY(${0.16 + (blocked ? 0 : height) * 0.84})` }}
            />
          ))}
        </div>
      </div>
      <strong>{caption}</strong>
    </div>
  );
}

function CallSource({ app, name }: { app: string | null; name: string | null }) {
  const visual = callVisual(app);
  return (
    <div className="interview-hacker-source">
      <span>Call</span>
      <div className="interview-hacker-source-body">
        <i className="interview-hacker-source-icon" aria-hidden="true">{visual.icon}</i>
      </div>
      <strong>{visual.name ?? name ?? "Checking..."}</strong>
    </div>
  );
}

/**
 * The Brief widget's switcher. Opens on click whether or not a brief is
 * already active: a "Reviewed and ready" brief used to be a dead end, so a
 * user who suddenly had to join a different, unprepped meeting had no way out
 * short of the dashboard's full builder. This lists every other interview
 * that already has a reviewed brief (near-instant to activate, no rebuild),
 * plus a fresh-start action for a meeting nothing was prepared for.
 */
function BriefMenu({
  hacker,
  onAttachNew,
}: {
  hacker: InterviewHackerState;
  onAttachNew: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        hacker.closeBriefMenu();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [hacker]);

  return (
    <div
      ref={containerRef}
      className="interview-hacker-brief-menu"
      onKeyDown={(event) => {
        // Stops here so the overlay's window-level Escape handler never sees
        // it - that handler dismisses the whole interview card, not just this
        // popover.
        if (event.key === "Escape") {
          event.stopPropagation();
          hacker.closeBriefMenu();
        }
      }}
    >
      <GlassSurface className="interview-hacker-brief-menu-surface" draggable={false}>
        <div className="interview-hacker-brief-menu-inner">
          <span className="interview-hacker-brief-menu-label">Switch prepared interview</span>
          {hacker.preparedInterviews.length === 0 ? (
            <p className="interview-hacker-brief-menu-empty">No other prepared interviews yet</p>
          ) : (
            <ul className="interview-hacker-brief-menu-list">
              {hacker.preparedInterviews.map((interview) => (
                <li key={interview.interviewId}>
                  <button
                    type="button"
                    className="interview-hacker-brief-menu-item"
                    disabled={hacker.briefMenuBusy}
                    onClick={() => hacker.switchToInterview(interview.interviewId)}
                  >
                    <strong>{interview.input.company.trim() || "Untitled interview"}</strong>
                    <span>
                      {interview.input.role.trim() || "Target role not added"}
                      {interview.draftBrief?.reviewedAtMs == null && " · Unreviewed"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hacker.briefMenuError && (
            <p className="interview-hacker-brief-menu-error">{hacker.briefMenuError}</p>
          )}
          <button
            type="button"
            className="interview-hacker-brief-menu-fresh"
            disabled={hacker.briefMenuBusy}
            onClick={() => {
              // Harmless when there is nothing to clear yet: clearing an
              // already-empty or resume-only slot before attaching is a no-op
              // beyond the round trip, and it keeps this one action correct
              // in every state instead of needing a branch here too.
              hacker.startFresh();
              onAttachNew();
            }}
          >
            {hacker.briefReady
              ? "Start fresh with a resume"
              : hacker.resumeWords === null
                ? "Attach a resume"
                : "Replace resume"}
          </button>
        </div>
      </GlassSurface>
    </div>
  );
}

function BriefSource({ hacker }: { hacker: InterviewHackerState }) {
  const caption = hacker.briefReady
    ? "Reviewed and ready"
    : hacker.attachingResume
      ? "Reading resume..."
      : hacker.resumeError
        ?? (hacker.resumeWords !== null
          ? `Resume added, ${hacker.resumeWords} words`
          : "Add your resume");
  const body = (
    <>
      <div className="interview-hacker-source-body">
        <i className="interview-hacker-source-icon" aria-hidden="true">
          {hacker.briefReady ? <DocumentIcon /> : <UploadArrowIcon />}
        </i>
      </div>
      <span className="interview-hacker-source-caption">
        <strong>{caption}</strong>
        {/* Ready-but-static text read as a dead status line, not a control -
            this chevron is the only signal that clicking it opens the
            switcher. Always shown: the click always opens the same popover
            now, whether or not a brief is active yet. */}
        <i
          className={`interview-hacker-source-chevron${hacker.briefMenuOpen ? " is-open" : ""}`}
          aria-hidden="true"
        >
          <ChevronDownIcon />
        </i>
      </span>
    </>
  );
  return (
    <div className={`interview-hacker-source${!hacker.briefReady && hacker.resumeError ? " is-warning" : ""}`}>
      <span>Brief</span>
      <button
        type="button"
        className="interview-hacker-source-action"
        // Always the switcher, never a direct file-picker trigger: the
        // popover is the one place both "switch to a prepared interview" and
        // "attach/replace the resume" live, in every state. A resume-only
        // state used to skip straight to the OS file picker here, which left
        // no way back to the prepared-interview list once you'd attached one.
        onClick={hacker.briefMenuOpen ? hacker.closeBriefMenu : hacker.openBriefMenu}
        disabled={hacker.attachingResume}
        aria-expanded={hacker.briefMenuOpen}
        title="Switch prepared interview or attach a resume"
      >
        {body}
      </button>
    </div>
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
  const resumeFileRef = useRef<HTMLInputElement | null>(null);
  const triggerAttach = () => {
    setOverlayDialogFriendly(true);
    resumeFileRef.current?.click();
  };
  // Two independent restores, because neither is fully reliable alone: a
  // "cancel" listener misses if the WebView's cancel event support is spotty
  // (WKWebView's is less certain than WebView2's), and window focus alone
  // would miss a same-window re-click before the dialog ever closes. Both
  // just call the same idempotent toggle, so firing twice is harmless.
  useEffect(() => {
    const input = resumeFileRef.current;
    if (!input) return;
    const restore = () => setOverlayDialogFriendly(false);
    input.addEventListener("cancel", restore);
    window.addEventListener("focus", restore);
    return () => {
      input.removeEventListener("cancel", restore);
      window.removeEventListener("focus", restore);
    };
    // resumeFileRef's <input> only exists while phase is "preflight" (it's
    // conditionally rendered below), so this must re-run when that flips -
    // an empty deps array would bind to a still-null ref on first mount and
    // never attach once the input actually appears.
  }, [hacker.phase]);
  // Whether the reader is pinned to the bottom. Tracked from scroll events
  // rather than measured inside the effect, because by the time the effect runs
  // the new content is already in the DOM and "was I at the bottom?" can no
  // longer be answered from the current scroll position.
  const followingRef = useRef(true);
  // Mirrors !followingRef.current into render state so the jump-to-latest pill
  // can appear. The ref stays the source of truth for the auto-scroll effect
  // (it must be readable synchronously before paint); this only drives the pill.
  const [detached, setDetached] = useState(false);
  const handleThreadScroll = () => {
    const thread = threadRef.current;
    if (!thread) return;
    followingRef.current =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight <= FOLLOW_THRESHOLD_PX;
    setDetached(!followingRef.current);
  };
  const jumpToLatest = () => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
    followingRef.current = true;
    setDetached(false);
  };
  useEffect(() => {
    const thread = threadRef.current;
    if (thread && followingRef.current) {
      // Smooth rather than instant: a question transition shrinks the thread
      // (archived answer clears, "Drafting..." shows) then regrows as the new
      // answer streams in. An instant scrollTop snap on every one of those
      // steps reads as an up/down bounce; scrollTo(behavior: "smooth") glides
      // through the sequence instead.
      thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
    }
  }, [hacker.history, hacker.question, hacker.answer, hacker.interimQuestion, hacker.drafting]);

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

        {hacker.phase === "preflight" && (
          <>
            <div className="interview-hacker-preflight">
              <MicSource active={hacker.phase === "preflight"} />
              <CallSource app={hacker.callApp} name={hacker.callName} />
              <BriefSource hacker={hacker} />
            </div>
            <input
              ref={resumeFileRef}
              type="file"
              accept={RESUME_ACCEPT}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared immediately so re-picking the same file fires onChange again.
                event.target.value = "";
                setOverlayDialogFriendly(false);
                if (file) hacker.attachResume(file);
              }}
            />
            {/* Rendered as a sibling of the preflight row, not nested inside
                BriefSource's narrow grid cell: .glass-surface clips overflow
                for its border-radius, so an absolutely-positioned popover
                would be cut off by the card's edge. Flowing in-line and
                growing the window's slot height (OverlayRoot) instead keeps
                it fully visible. */}
            {hacker.briefMenuOpen && (
              <BriefMenu hacker={hacker} onAttachNew={triggerAttach} />
            )}
          </>
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

        {/* Optional, not a gate: Start above already works without it. This
            only unlocks the "Call" widget's app label. */}
        {hacker.phase === "preflight" && hacker.callBlocker === "accessibility" && (
          <button
            type="button"
            className="interview-hacker-secondary"
            onClick={hacker.requestCallAccess}
          >
            {hacker.blockerAsked ? "Open System Settings again" : "Allow in System Settings to label the call"}
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
          <div className="interview-hacker-thread-wrap">
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
              {hacker.drafting && !hacker.answer && (
                <div className="interview-hacker-bubble is-answer is-drafting" aria-live="polite">
                  Drafting...
                </div>
              )}
              {threadIsEmpty && (
                <div className="interview-hacker-thread-empty">
                  Questions and answers appear here.
                </div>
              )}
            </div>
            {detached && (
              <button
                type="button"
                className="interview-hacker-jump"
                onClick={jumpToLatest}
                aria-label="Jump to latest"
                title="Jump to latest"
              >
                <DownArrowIcon />
              </button>
            )}
          </div>
        )}

        {active && hacker.screenNote && (
          <div className="interview-hacker-screen-note">
            Looked at: {hacker.screenNote}
          </div>
        )}

        {active && hacker.phase !== "starting" && (
          <div className="interview-hacker-answer-actions">
            <button
              type="button"
              disabled={!hacker.questionPending || hacker.phase !== "listening"}
              onClick={hacker.sendNow}
              title="Answer what has been said so far, without waiting"
            >
              Answer now
            </button>
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
              : "This session is saved to your device, encrypted. Reflect to add coaching notes to it."}
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
            {hacker.phase === "reflection" && <button type="button" className="interview-hacker-primary" disabled={hacker.savingReflection} onClick={hacker.saveReflection}>{hacker.savingReflection ? "Downloading" : "Download"}</button>}
          </div>
        )}
      </div>
    </GlassSurface>
  );
}
