import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  INTERVIEW_HACKER_STATUS,
  INTERVIEW_HACKER_TRANSCRIPT,
} from "../../lib/ipcEvents";
import {
  mintInterviewCredential,
  createInterviewReflection,
  streamInterviewAnswer,
  type InterviewAnswerAction,
  type InterviewReflection,
  type InterviewScreenSightFrame,
  type InterviewTranscriptTurn,
} from "../../lib/interviewHackerApi";
import {
  relevantInterviewBriefSlice,
  stableInterviewBriefSlice,
  type InterviewBrief,
} from "../../lib/interviewBrief";
import {
  clearInterviewBrief,
  listenForInterviewBrief,
  loadInterviewBrief,
  storeInterviewBrief,
} from "../../lib/interviewBriefMemory";
import { osName } from "../../lib/platformKeys";
import {
  listenForInterviewResume,
  loadInterviewResume,
  storeInterviewResume,
} from "../../lib/interviewResumeMemory";
import {
  RESUME_MAX_CHARS,
  ResumeExtractionError,
  extractResumeText,
  resumeStats,
} from "../../lib/resumeText";
import { loadInterviewWorkspace, type InterviewWorkspaceRecord } from "../../lib/interviewWorkspace";
import { interviewKeyterms } from "../../lib/interviewKeyterms";
import {
  checkpointInterviewSession,
  saveInterviewSession,
  saveInterviewReflection,
  type InterviewSessionRecord,
} from "../../lib/interviewSessions";
import { AuthRequiredError, TimeoutError } from "../../lib/api";
import { useAuth } from "../../state/AuthProvider";
import {
  DEFAULT_PLANNED_MINUTES,
  DEFAULT_ROUND_KIND,
  answerShapeFor,
  assemblyMsFor,
  pacingCaption,
  type AnswerShape,
  type PlannedMinutes,
  type RoundKind,
} from "../../lib/interviewPolicy";
import { buildSelfPitch, type SelfPitch } from "../../lib/selfPitch";
import { toBase64 } from "../../lib/chatScreenCapture";
import { asArrayBuffer, parseCapturedFrame } from "../../lib/screenFrame";
import { trackEvent } from "../../lib/analytics";
import { logError, logInfo } from "../../lib/log";

/** Tauri rejects Rust `Result<T, String>` commands with the bare string. */
function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
}

/** One answered question, kept so the card can show the whole conversation
 * rather than only the turn in flight. Memory-only, same lifetime as the
 * session: nothing here is ever written to disk or sent anywhere. */
export interface InterviewExchange {
  id: string;
  question: string;
  answer: string;
  unverified: boolean;
}

export type InterviewHackerPhase =
  | "idle"
  | "preflight"
  | "starting"
  | "listening"
  | "paused"
  | "degraded"
  | "error"
  | "ended"
  | "reflecting"
  | "reflection";

/// The phases that own a live capture session. They are the only ones that must
/// not be dismissed out from under the user, so both the card's Stop/Cancel
/// split and OverlayRoot's Escape handling read this one predicate rather than
/// keeping their own phase lists.
export function isInterviewCaptureActive(phase: InterviewHackerPhase): boolean {
  return phase === "starting"
    || phase === "listening"
    || phase === "paused"
    || phase === "degraded";
}

interface SupportedCallPayload {
  supported: boolean;
  app: string | null;
  /** "accessibility" when macOS is withholding the grant that lets Aura read
   * window titles. Without it every check answers "no call" forever, which is
   * indistinguishable from waiting, so the card has to say which one it is. */
  blocker: string | null;
}

interface StatusPayload {
  phase: "starting" | "listening" | "paused" | "degraded" | "error" | "stopped";
  sessionId: string | null;
  epoch: number | null;
  app: string | null;
  reason: string | null;
}

function callLabel(app: string | null): string {
  switch (app) {
    case "google-meet": return "Google Meet";
    case "teams-web": return "Microsoft Teams";
    case "zoom-web": return "Zoom";
    case "teams": return "Microsoft Teams";
    case "zoom": return "Zoom";
    default: return "Supported call";
  }
}

// Default same-speaker merge debounce. The session's round can raise it (see
// interviewPolicy), which costs latency on every answer, so the default stays
// where it shipped.
const PANEL_ASSEMBLY_MS = 150;
// A final without terminal punctuation is probably a question split by the
// provider's silence endpointing, so it waits longer for its continuation than
// a punctuated one. Smart formatting is on, so punctuation is dependable.
const INCOMPLETE_HOLD_MS = 700;
// Manual mode collects the interviewer's speech until the user sends it. A
// long monologue is trimmed from the front, at a sentence boundary, so the
// paragraph on screen and in the prompt stays readable and bounded.
const MANUAL_PARAGRAPH_MAX_CHARS = 2_000;

export type AnswerMode = "auto" | "manual";
// While a pending question's speaker is demonstrably still talking (interims
// keep arriving), the flush waits for their next final instead of firing.
const INTERIM_EXTEND_MS = 1_200;
const PACING_TICK_MS = 1_000;
const PITCH_COLLAPSE_AFTER_ACCEPTED = 2;
const ECHO_WINDOW_MS = 2_500;
const MAX_CREDENTIAL_RETRIES = 3;
// Tauri's invoke has no deadline of its own. Past this, Start is treated as
// failed and cancelled rather than left on "Starting..." indefinitely.
const START_TIMEOUT_MS = 20_000;
// Live-session checkpoint cadence: a crash loses at most this much.
const CHECKPOINT_EVERY_MS = 30_000;
// Cosmetic-only since Start no longer waits on this (see openPreflight), so
// the poll can afford to be slower than a gate would need. It used to run
// only until the user reached "preflight"; now it runs for as long as
// preflight is open, which can be a while, so a slower interval matters more
// than it did. macOS's detector is the costlier one to poll repeatedly (see
// interview_supported_call): it walks every running app's accessibility
// window list, versus a single EnumWindows syscall on Windows.
const CALL_DETECTION_RETRY_MS = 4_000;
// A 30 minute round runs 15-25 questions, so this is headroom rather than a
// limit anyone should hit. Strings only, no images, so the cost is negligible.
const MAX_HISTORY_EXCHANGES = 40;

function reflectionMarkdown(reflection: InterviewReflection): string {
  const section = (title: string, items: string[]) =>
    items.length > 0 ? `\n## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}\n` : "";
  return `# Interview reflection\n\n${reflection.summary}\n${section("Strengths", reflection.strengths)}${section("Improve next time", reflection.improvements)}${section("Follow-up actions", reflection.followUpActions)}`;
}

function normalizedWords(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isNearDuplicate(left: string, right: string): boolean {
  const leftWords = normalizedWords(left);
  const rightWords = normalizedWords(right);
  if (leftWords.length < 3 || rightWords.length < 3) return false;
  const leftSet = new Set(leftWords);
  const rightSet = new Set(rightWords);
  const shared = [...leftSet].filter((word) => rightSet.has(word)).length;
  return shared / Math.max(leftSet.size, rightSet.size) >= 0.88;
}

function mergeRemoteTurns(
  current: InterviewTranscriptTurn,
  next: InterviewTranscriptTurn,
): InterviewTranscriptTurn {
  return {
    ...current,
    endMs: Math.max(current.endMs, next.endMs),
    text: `${current.text.trim()} ${next.text.trim()}`.trim(),
    speakerOverlap: Boolean(current.speakerOverlap || next.speakerOverlap),
    finalWordAtMs: next.finalWordAtMs ?? current.finalWordAtMs ?? null,
  };
}

/** Drops whole leading sentences until the text fits the manual-mode cap. */
function trimParagraphFront(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const overflow = text.slice(0, text.length - maxChars);
  const boundary = overflow.search(/[.?!]\s+\S*$/);
  const cut = boundary >= 0
    ? overflow.length - overflow.slice(boundary).replace(/^[.?!]\s+/, "").length
    : overflow.length;
  return text.slice(cut).trimStart();
}

/** Per-turn latency stamps, one object per evaluation. Promoted into
 * `turnTimingRef` on activation so the transcript listener can close the
 * frozen-hold measurement when the candidate stops speaking. */
interface TurnTiming {
  turnId: string;
  action: InterviewAnswerAction;
  finalWordAtMs: number | null;
  queuedAtMs: number;
  requestAtMs: number;
  decisionAtMs: number | null;
  firstDeltaAtMs: number | null;
  frozenAtMs: number | null;
  visibleAtMs: number | null;
  frozenHoldMs: number;
  model: string | null;
  reported: boolean;
}

interface SessionMetrics {
  startedAtMs: number;
  accepted: number;
  rejected: number;
  errors: number;
  reconnects: number;
  deviceSwitches: number;
  credentialRotations: number;
}

interface ReflectionSnapshot {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  turns: InterviewTranscriptTurn[];
  exchanges: Array<{ question: string; answer: string }>;
  brief: ReturnType<typeof relevantInterviewBriefSlice>;
}

export interface InterviewHackerState {
  phase: InterviewHackerPhase;
  callName: string | null;
  /** Raw detector id ("zoom" | "zoom-web" | "google-meet" | "teams" |
   *  "teams-web"), so the card can draw the app's own mark. `callName` stays the
   *  humanized string for copy. */
  callApp: string | null;
  /** Why background call detection cannot succeed, independent of whether the
   *  session can start - it never gates Start. Currently only "accessibility"
   *  (macOS grant missing). */
  callBlocker: string | null;
  /** True once the user has clicked through to the permission dialog, so the
   *  button can switch to "again" wording the way ShortcutEditorDialog does. */
  blockerAsked: boolean;
  /** Raises the macOS Accessibility prompt. Only ever called from a click. */
  requestCallAccess: () => void;
  history: InterviewExchange[];
  question: string;
  answer: string;
  interimQuestion: string;
  briefReady: boolean;
  /** Word count of the attached resume, or null when none is attached. */
  resumeWords: number | null;
  attachingResume: boolean;
  resumeError: string | null;
  attachResume: (file: File) => void;
  /** Other interviews with a reviewed brief, for the "switch" picker. Never
   *  includes the one currently active. */
  preparedInterviews: InterviewWorkspaceRecord[];
  briefMenuOpen: boolean;
  briefMenuBusy: boolean;
  briefMenuError: string | null;
  openBriefMenu: () => void;
  closeBriefMenu: () => void;
  switchToInterview: (interviewId: string) => void;
  startFresh: () => void;
  canSuggest: boolean;
  recoverable: boolean;
  candidateSpeaking: boolean;
  /** True from the moment an answer request is accepted until its first text
   *  is visible, so the card can show something during the wait. */
  drafting: boolean;
  /** A question is forming (interim speech or a pending merge window), so the
   *  Answer now action has something to send. */
  questionPending: boolean;
  sendNow: () => void;
  /** Auto answers every turn the gate accepts; Manual collects everything the
   *  interviewer says into one paragraph until sendNow. Always Auto at Start. */
  answerMode: AnswerMode;
  setAnswerMode: (mode: AnswerMode) => void;
  capturingScreen: boolean;
  /** What Aura saw on the last screen it was shown, for the current answer. */
  screenNote: string | null;
  savingReflection: boolean;
  reflection: InterviewReflection | null;
  message: string | null;
  errorDetail: string | null;
  roundKind: RoundKind;
  plannedMinutes: PlannedMinutes;
  setRoundKind: (value: RoundKind) => void;
  setPlannedMinutes: (value: PlannedMinutes) => void;
  pitch: SelfPitch | null;
  pitchExpanded: boolean;
  togglePitch: () => void;
  pacingCaption: string | null;
  openPreflight: () => void;
  dismiss: () => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  shorter: () => void;
  screenSight: () => void;
  reflect: () => void;
  saveReflection: () => void;
  dismissReflection: () => void;
}

export function useInterviewHacker(signedIn: boolean): InterviewHackerState {
  const { user } = useAuth();
  const [phase, setPhase] = useState<InterviewHackerPhase>("idle");
  const [callName, setCallName] = useState<string | null>(null);
  const [callApp, setCallApp] = useState<string | null>(null);
  const [callBlocker, setCallBlocker] = useState<string | null>(null);
  const [blockerAsked, setBlockerAsked] = useState(false);
  // `resumeText`, not `resume`: `resume` is already the pause/resume action.
  const [resumeText, setResumeText] = useState<string | null>(null);
  const [attachingResume, setAttachingResume] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [preparedInterviews, setPreparedInterviews] = useState<InterviewWorkspaceRecord[]>([]);
  const [briefMenuOpen, setBriefMenuOpen] = useState(false);
  const [briefMenuBusy, setBriefMenuBusy] = useState(false);
  const [briefMenuError, setBriefMenuError] = useState<string | null>(null);
  // Local bookkeeping only, never persisted: the overlay must not write the
  // shared workspace cache (see the read-only note below), so this just lets
  // the picker exclude whichever interview is currently active.
  const activeInterviewIdRef = useRef<string | null>(null);
  const [history, setHistory] = useState<InterviewExchange[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [interimQuestion, setInterimQuestion] = useState("");
  const [answerMode, setAnswerModeState] = useState<AnswerMode>("auto");
  // Read by the transcript listener, which is set up once and cannot close
  // over the state value.
  const answerModeRef = useRef<AnswerMode>("auto");
  // Installed by the listener effect: re-arms or clears the pending merge
  // window when the mode flips mid-session.
  const applyAnswerModeRef = useRef<((mode: AnswerMode) => void) | null>(null);
  const [brief, setBrief] = useState<InterviewBrief | null>(null);
  const [candidateSpeaking, setCandidateSpeaking] = useState(false);
  const [capturingScreen, setCapturingScreen] = useState(false);
  const [screenNote, setScreenNote] = useState<string | null>(null);
  const [savingReflection, setSavingReflection] = useState(false);
  const [reflectionSnapshot, setReflectionSnapshot] = useState<ReflectionSnapshot | null>(null);
  const [reflection, setReflection] = useState<InterviewReflection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [roundKind, setRoundKind] = useState<RoundKind>(DEFAULT_ROUND_KIND);
  const [plannedMinutes, setPlannedMinutes] = useState<PlannedMinutes>(DEFAULT_PLANNED_MINUTES);
  const [pitch, setPitch] = useState<SelfPitch | null>(null);
  const [pitchExpanded, setPitchExpanded] = useState(true);
  const [caption, setCaption] = useState<string | null>(null);
  // Mirrors of identityRef/lastRemoteTurnRef for render. The refs are written
  // outside React's cycle, so deriving the button states from them directly
  // left Suggest and Screen Sight stale whenever the write happened to land
  // without a state change beside it (setMessage bails out when the string is
  // already current, which it is on a second consecutive interviewer turn).
  const [recoverable, setRecoverable] = useState(false);
  const [canSuggest, setCanSuggest] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [questionPending, setQuestionPending] = useState(false);
  const identityRef = useRef<{ sessionId: string; epoch: number } | null>(null);
  const recentRef = useRef<InterviewTranscriptTurn[]>([]);
  const reflectionTurnsRef = useRef<InterviewTranscriptTurn[]>([]);
  const briefRef = useRef<InterviewBrief | null>(null);
  const resumeTextRef = useRef<string | null>(null);
  // Company, role, and JD from the dashboard's prepared interview. Held only to
  // bias recognition at Start; the brief remains the source of truth for answers.
  const prepInputRef = useRef<{
    company: string;
    role: string;
    jobDescription: string;
  } | null>(null);
  const answerRef = useRef("");
  // Streamed deltas not yet committed to `answer` state. Buffered separately
  // from answerRef (rather than appended to it directly) because answerRef is
  // re-synced from `answer` state at the top of every render - appending
  // straight onto answerRef would get silently overwritten by that mirror the
  // next time anything else in this hook re-renders before the batched flush
  // fires. One React render per animation frame instead of one per streamed
  // token, without that data loss.
  const pendingAnswerDeltaRef = useRef("");
  const answerFlushFrameRef = useRef<number | null>(null);

  const flushAnswer = () => {
    answerFlushFrameRef.current = null;
    if (!pendingAnswerDeltaRef.current) return;
    const next = answerRef.current + pendingAnswerDeltaRef.current;
    pendingAnswerDeltaRef.current = "";
    answerRef.current = next;
    setAnswer(next);
  };

  const scheduleAnswerDelta = (delta: string) => {
    pendingAnswerDeltaRef.current += delta;
    if (answerFlushFrameRef.current !== null) return;
    answerFlushFrameRef.current = requestAnimationFrame(flushAnswer);
  };

  // Folds any buffered-but-not-yet-rendered delta into answerRef.current right
  // now, without waiting for the next animation frame. Needed anywhere that
  // reads answerRef.current synchronously (archiving the previous answer into
  // history, prepending it to replayed frozen speech-held deltas) - those
  // reads must never miss the last chunk just because its render hasn't
  // committed yet.
  const flushAnswerSync = () => {
    if (answerFlushFrameRef.current !== null) {
      cancelAnimationFrame(answerFlushFrameRef.current);
      answerFlushFrameRef.current = null;
    }
    if (pendingAnswerDeltaRef.current) {
      answerRef.current += pendingAnswerDeltaRef.current;
      pendingAnswerDeltaRef.current = "";
    }
  };

  const resetAnswer = () => {
    if (answerFlushFrameRef.current !== null) {
      cancelAnimationFrame(answerFlushFrameRef.current);
      answerFlushFrameRef.current = null;
    }
    pendingAnswerDeltaRef.current = "";
    answerRef.current = "";
    setAnswer("");
  };
  const lastRemoteTurnRef = useRef<InterviewTranscriptTurn | null>(null);
  // Tracks whether the answer currently on screen was produced without a
  // reviewed brief, so it carries that flag with it when it becomes history.
  const activeUnverifiedRef = useRef(false);
  const generationRef = useRef<AbortController | null>(null);
  const reflectionRequestRef = useRef<AbortController | null>(null);
  const screenCaptureInFlightRef = useRef(false);
  const screenCaptureSequenceRef = useRef(0);
  // Captions of screens shown this round, newest last. Session-scoped context
  // only: the images themselves are never stored, so these short strings are all
  // that survives a Screen Sight, and they die with the session.
  const screenNotesRef = useRef<string[]>([]);
  const savingReflectionRef = useRef(false);
  const savingReflectionSequenceRef = useRef(0);
  const activeAnswerTurnRef = useRef<InterviewTranscriptTurn | null>(null);
  const activeAnswerActionRef = useRef<InterviewAnswerAction | null>(null);
  const evaluationsRef = useRef(new Set<AbortController>());
  const requestSequenceRef = useRef(0);
  const acceptedSequenceRef = useRef(0);
  const recentAudioRef = useRef<Array<{
    source: "candidate" | "remote";
    text: string;
    atMs: number;
  }>>([]);
  const assemblyRef = useRef<{
    turn: InterviewTranscriptTurn;
    // null while manual mode holds the paragraph: nothing flushes it but the user.
    timer: ReturnType<typeof setTimeout> | null;
    queuedAtMs: number;
  } | null>(null);
  const turnTimingRef = useRef<TurnTiming | null>(null);
  const lastRemoteInterimRef = useRef<InterviewTranscriptTurn | null>(null);
  const flushNowRef = useRef<((action: InterviewAnswerAction) => void) | null>(null);
  const credentialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const credentialRetryRef = useRef(0);
  const credentialRefreshInFlightRef = useRef(false);
  // True while the worker is parked on a rejected token. "Retry transcription"
  // must mint before it resumes, or it resumes with the same dead token.
  const credentialBlockedRef = useRef(false);
  const checkpointRef = useRef<(() => void) | null>(null);
  const lastCheckpointRef = useRef("");
  const rotateCredentialRef = useRef<(() => void) | null>(null);
  const metricsRef = useRef<SessionMetrics | null>(null);
  const candidateSpeakingRef = useRef(false);
  const frozenDeltasRef = useRef("");
  const replaceAfterSpeechRef = useRef(false);
  const acceptNativeEventsRef = useRef(false);
  const startAttemptRef = useRef(0);
  const preflightAttemptRef = useRef(0);
  const lastStoppedEpochRef = useRef(0);
  // Frozen at Start from the round picked in preflight. Read inside the
  // transcript listener, which is set up once and must not close over a
  // changing state value.
  const assemblyMsRef = useRef(PANEL_ASSEMBLY_MS);
  const answerShapeRef = useRef<AnswerShape>(answerShapeFor(DEFAULT_ROUND_KIND));
  const plannedMinutesRef = useRef<PlannedMinutes>(DEFAULT_PLANNED_MINUTES);
  // Mirrored so the Stop handler can collect the finished session without
  // reading changing state through useCallback deps.
  const roundKindRef = useRef<RoundKind>(DEFAULT_ROUND_KIND);
  const historyRef = useRef<InterviewExchange[]>([]);

  briefRef.current = brief;
  resumeTextRef.current = resumeText;
  answerRef.current = answer;
  roundKindRef.current = roundKind;
  historyRef.current = history;

  const clearSession = useCallback(() => {
    generationRef.current?.abort();
    generationRef.current = null;
    reflectionRequestRef.current?.abort();
    reflectionRequestRef.current = null;
    screenCaptureSequenceRef.current += 1;
    screenCaptureInFlightRef.current = false;
    activeAnswerTurnRef.current = null;
    activeAnswerActionRef.current = null;
    evaluationsRef.current.forEach((controller) => controller.abort());
    evaluationsRef.current.clear();
    if (assemblyRef.current?.timer) clearTimeout(assemblyRef.current.timer);
    assemblyRef.current = null;
    turnTimingRef.current = null;
    lastRemoteInterimRef.current = null;
    setDrafting(false);
    setQuestionPending(false);
    if (credentialTimerRef.current) clearTimeout(credentialTimerRef.current);
    credentialTimerRef.current = null;
    identityRef.current = null;
    setRecoverable(false);
    recentRef.current = [];
    reflectionTurnsRef.current = [];
    screenNotesRef.current = [];
    setScreenNote(null);
    lastRemoteTurnRef.current = null;
    setCanSuggest(false);
    activeUnverifiedRef.current = false;
    recentAudioRef.current = [];
    requestSequenceRef.current = 0;
    acceptedSequenceRef.current = 0;
    credentialRetryRef.current = 0;
    credentialRefreshInFlightRef.current = false;
    credentialBlockedRef.current = false;
    lastCheckpointRef.current = "";
    answerModeRef.current = "auto";
    setAnswerModeState("auto");
    candidateSpeakingRef.current = false;
    frozenDeltasRef.current = "";
    replaceAfterSpeechRef.current = false;
    acceptNativeEventsRef.current = false;
    setCandidateSpeaking(false);
    setCapturingScreen(false);
    savingReflectionRef.current = false;
    savingReflectionSequenceRef.current += 1;
    setSavingReflection(false);
    setHistory([]);
    setQuestion("");
    resetAnswer();
    setInterimQuestion("");
    setCallName(null);
    setCallApp(null);
    setMessage(null);
    setErrorDetail(null);
    // The pitch is memory-only and dies with the session, same lifetime as the
    // reflection turns above.
    setPitch(null);
    setPitchExpanded(true);
    setCaption(null);
    assemblyMsRef.current = PANEL_ASSEMBLY_MS;
    answerShapeRef.current = answerShapeFor(DEFAULT_ROUND_KIND);
  }, []);

  const recordSessionEnd = useCallback((reason: string) => {
    const metrics = metricsRef.current;
    if (!metrics) return;
    trackEvent("interview_companion_session_ended", {
      reason,
      duration_ms: Math.max(0, Date.now() - metrics.startedAtMs),
      accepted_questions: metrics.accepted,
      rejected_turns: metrics.rejected,
      error_count: metrics.errors,
      reconnect_count: metrics.reconnects,
      device_switch_count: metrics.deviceSwitches,
      credential_rotation_count: metrics.credentialRotations,
    });
    metricsRef.current = null;
  }, []);

  // One line and one event per answered turn, with the whole pipeline split by
  // stage: STT finalization lag, merge window, network + provider first token,
  // and how long a finished answer sat frozen behind candidate speech.
  const reportTurnLatency = useCallback((timing: TurnTiming) => {
    if (timing.reported || timing.visibleAtMs === null) return;
    timing.reported = true;
    const base = timing.finalWordAtMs ?? timing.queuedAtMs;
    const breakdown = {
      action: timing.action,
      model: timing.model,
      stt_final_lag_ms: timing.finalWordAtMs !== null
        ? Math.max(0, timing.queuedAtMs - timing.finalWordAtMs)
        : null,
      assembly_ms: Math.max(0, timing.requestAtMs - timing.queuedAtMs),
      decision_ms: timing.decisionAtMs !== null
        ? Math.max(0, timing.decisionAtMs - timing.requestAtMs)
        : null,
      first_delta_ms: timing.firstDeltaAtMs !== null
        ? Math.max(0, timing.firstDeltaAtMs - timing.requestAtMs)
        : null,
      frozen_hold_ms: timing.frozenHoldMs,
      total_ms: Math.max(0, timing.visibleAtMs - base),
    };
    // Durable log, not the console: the console is gone the moment the
    // interview is, and this line is the only per-turn split that exists.
    logInfo("interview-latency", JSON.stringify(breakdown));
    trackEvent("interview_companion_turn_latency", breakdown);
  }, []);

  const rememberReflectionTurn = useCallback((turn: InterviewTranscriptTurn) => {
    const next = [...reflectionTurnsRef.current, turn].slice(-120);
    let characters = next.reduce((total, item) => total + item.text.length, 0);
    while (next.length > 1 && characters > 40_000) {
      characters -= next.shift()?.text.length ?? 0;
    }
    reflectionTurnsRef.current = next;
  }, []);

  /**
   * Archived exchanges plus the one still on screen.
   *
   * `history` only gains an exchange when a DIFFERENT question supersedes it
   * (see activate()), so the answer visible at Stop had never been archived and
   * the last question of every session was lost from both the saved session and
   * the reflection. Anything reading exchanges outside the render path must go
   * through here.
   */
  const exchangesIncludingLive = useCallback((): InterviewExchange[] => {
    flushAnswerSync();
    const archived = historyRef.current;
    const liveTurn = activeAnswerTurnRef.current;
    const liveAnswer = answerRef.current.trim();
    if (!liveTurn || !liveAnswer) return archived;
    if (archived.some((exchange) => exchange.id === liveTurn.turnId)) return archived;
    return [...archived, {
      id: liveTurn.turnId,
      question: liveTurn.text,
      answer: liveAnswer,
      unverified: activeUnverifiedRef.current,
    }].slice(-MAX_HISTORY_EXCHANGES);
  }, []);

  const reflectionSnapshotForCurrentSession = useCallback((): ReflectionSnapshot | null => {
    const identity = identityRef.current;
    const metrics = metricsRef.current;
    const turns = [...reflectionTurnsRef.current];
    const pending = assemblyRef.current?.turn;
    if (pending && !turns.some((turn) => turn.turnId === pending.turnId)) turns.push(pending);
    if (!identity || !metrics || turns.length === 0) return null;
    const transcript = turns.map((turn) => turn.text).join(" ");
    return {
      sessionId: identity.sessionId,
      startedAtMs: metrics.startedAtMs,
      endedAtMs: Date.now(),
      turns,
      exchanges: exchangesIncludingLive().map((exchange) => ({
        question: exchange.question,
        answer: exchange.answer,
      })),
      brief: relevantInterviewBriefSlice(briefRef.current, transcript, transcript),
    };
  }, [exchangesIncludingLive]);

  const armCredentialRefresh = useCallback((expiresInSeconds: number) => {
    if (credentialTimerRef.current) clearTimeout(credentialTimerRef.current);
    const refreshAfterSeconds = Math.max(5, expiresInSeconds - 15);
    credentialTimerRef.current = setTimeout(() => {
      rotateCredentialRef.current?.();
    }, refreshAfterSeconds * 1_000);
  }, []);

  const rotateCredential = useCallback(() => {
    const identity = identityRef.current;
    if (!identity || credentialRefreshInFlightRef.current) return;
    credentialRefreshInFlightRef.current = true;
    void mintInterviewCredential()
      .then((credential) => invoke("update_interview_hacker_credential", {
        sessionId: identity.sessionId,
        epoch: identity.epoch,
        accessToken: credential.accessToken,
        openaiAccessToken: credential.openaiAccessToken,
      }).then(() => credential))
      .then((credential) => {
        credentialRefreshInFlightRef.current = false;
        if (
          identityRef.current?.sessionId !== identity.sessionId
          || identityRef.current.epoch !== identity.epoch
        ) return;
        credentialRetryRef.current = 0;
        credentialBlockedRef.current = false;
        if (metricsRef.current) metricsRef.current.credentialRotations += 1;
        trackEvent("interview_companion_credential_rotation", { outcome: "success" });
        armCredentialRefresh(credential.expiresInSeconds);
      })
      .catch((error) => {
        credentialRefreshInFlightRef.current = false;
        if (
          identityRef.current?.sessionId !== identity.sessionId
          || identityRef.current.epoch !== identity.epoch
        ) return;
        credentialRetryRef.current += 1;
        if (metricsRef.current) metricsRef.current.errors += 1;
        trackEvent("interview_companion_credential_rotation", {
          outcome: "failure",
          retry: credentialRetryRef.current,
        });
        logError("Interview Companion: credential rotation", error);
        if (credentialRetryRef.current <= MAX_CREDENTIAL_RETRIES) {
          if (credentialTimerRef.current) clearTimeout(credentialTimerRef.current);
          credentialTimerRef.current = setTimeout(() => {
            rotateCredentialRef.current?.();
          }, (2 ** (credentialRetryRef.current - 1)) * 1_000);
        } else {
          credentialBlockedRef.current = true;
          setMessage("Transcription credentials could not be refreshed. Use Retry transcription, or restart Interview Companion.");
          setErrorDetail("Error code: credential_refresh_failed. Automatic credential retries were exhausted.");
        }
      });
  }, [armCredentialRefresh]);
  rotateCredentialRef.current = rotateCredential;

  const openPreflight = useCallback(() => {
    if (!signedIn) return;
    preflightAttemptRef.current += 1;
    reflectionRequestRef.current?.abort();
    reflectionRequestRef.current = null;
    setReflectionSnapshot(null);
    setReflection(null);
    setCallName(null);
    setCallApp(null);
    setCallBlocker(null);
    // Start is available immediately: which call app (if any) is running is
    // opportunistic labelling for the "Call" widget below, never a
    // precondition. A candidate practicing solo, or on a call Aura's detector
    // does not recognise, loses nothing by starting without it.
    setPhase("preflight");
    setMessage(null);
    setErrorDetail(null);
  }, [signedIn]);

  // Runs in the background purely to label the "Call" widget and to surface
  // the macOS Accessibility grant if that is what is keeping the label blank -
  // it never blocks or delays Start, which is already available the moment
  // openPreflight runs above.
  useEffect(() => {
    if (!signedIn || phase !== "preflight") return;
    const attempt = preflightAttemptRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      invoke<SupportedCallPayload>("interview_supported_call")
        .then((result) => {
          if (cancelled || preflightAttemptRef.current !== attempt) return;
          if (result.supported) {
            setCallName(callLabel(result.app));
            setCallApp(result.app);
            setCallBlocker(null);
            return;
          }
          setCallBlocker(result.blocker ?? null);
          timer = setTimeout(check, CALL_DETECTION_RETRY_MS);
        })
        .catch((error) => {
          if (cancelled || preflightAttemptRef.current !== attempt) return;
          logError("Interview Companion: call detection", error);
          timer = setTimeout(check, CALL_DETECTION_RETRY_MS);
        });
    };

    check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, signedIn]);

  // The user-initiated moment where raising the macOS dialog is correct. The
  // polling check above deliberately never prompts, so this is the only path
  // that can. The running check clears the blocker on its own once the grant
  // lands, so there is nothing to set here.
  const requestCallAccess = useCallback(() => {
    setBlockerAsked(true);
    invoke<boolean>("interview_request_accessibility")
      .then((granted) =>
        trackEvent("desktop_permission_result", {
          permission: "accessibility",
          granted,
          surface: "interview_companion",
        }),
      )
      .catch((error) => logError("Interview Companion: accessibility request", error));
  }, []);

  // Closes the card from any phase that is not holding a live capture. Without
  // this the preflight was a dead end: it renders only "Start", the Stop button
  // is scoped to the capturing phases, and OverlayRoot suppresses chat and
  // swallows Escape while the card is up, so opening it from the tray and then
  // leaving the call left nothing on screen that could dismiss it.
  const setAnswerMode = useCallback((mode: AnswerMode) => {
    if (answerModeRef.current === mode) return;
    answerModeRef.current = mode;
    setAnswerModeState(mode);
    applyAnswerModeRef.current?.(mode);
    trackEvent("interview_companion_answer_mode", { mode });
  }, []);

  const dismiss = useCallback(() => {
    preflightAttemptRef.current += 1;
    startAttemptRef.current += 1;
    answerModeRef.current = "auto";
    setAnswerModeState("auto");
    reflectionRequestRef.current?.abort();
    reflectionRequestRef.current = null;
    savingReflectionRef.current = false;
    savingReflectionSequenceRef.current += 1;
    setSavingReflection(false);
    setReflectionSnapshot(null);
    setReflection(null);
    setCallName(null);
    setCallApp(null);
    setCallBlocker(null);
    setBlockerAsked(false);
    setMessage(null);
    setErrorDetail(null);
    setPhase("idle");
  }, []);

  const start = useCallback(() => {
    if (phase !== "preflight") return;
    const attempt = ++startAttemptRef.current;
    acceptNativeEventsRef.current = true;
    // The round picked here is the session's, frozen now so nothing can move it
    // mid-interview.
    assemblyMsRef.current = assemblyMsFor(roundKind);
    answerShapeRef.current = answerShapeFor(roundKind);
    plannedMinutesRef.current = plannedMinutes;
    // Assembled locally from claims the user already confirmed, so it is on
    // screen before a word is spoken and cannot invent experience. No network
    // call, no question detection.
    setPitch(buildSelfPitch(briefRef.current));
    setPitchExpanded(true);
    setPhase("starting");
    setMessage(null);
    setErrorDetail(null);
    let startInvoked = false;
    mintInterviewCredential()
      .then((credential) => {
        if (startAttemptRef.current !== attempt) return null;
        startInvoked = true;
        return new Promise<StatusPayload>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new TimeoutError(`start timed out after ${START_TIMEOUT_MS}ms`)),
            START_TIMEOUT_MS,
          );
          invoke<StatusPayload>("start_interview_hacker", {
            accessToken: credential.accessToken,
            openaiAccessToken: credential.openaiAccessToken,
            // Frozen for the session: Deepgram takes keyterms as query parameters
            // when the socket opens and cannot be re-biased mid-stream.
            keyterms: interviewKeyterms({
              brief: briefRef.current,
              resumeText: resumeTextRef.current,
              company: prepInputRef.current?.company,
              role: prepInputRef.current?.role,
              jobDescription: prepInputRef.current?.jobDescription,
            }),
          }).then(
            (status) => {
              clearTimeout(deadline);
              resolve(status);
            },
            (error: unknown) => {
              clearTimeout(deadline);
              reject(error);
            },
          );
        }).then((status) => ({ status, credential }));
      })
      .then((started) => {
        if (!started) return;
        const { status, credential } = started;
        if (startAttemptRef.current !== attempt) {
          void invoke("stop_interview_hacker");
          return;
        }
        if (!status.sessionId || status.epoch === null) {
          throw new Error("Interview Companion returned no session identity.");
        }
        identityRef.current = { sessionId: status.sessionId, epoch: status.epoch };
        setRecoverable(true);
        metricsRef.current = {
          startedAtMs: Date.now(),
          accepted: 0,
          rejected: 0,
          errors: 0,
          reconnects: 0,
          deviceSwitches: 0,
          credentialRotations: 0,
        };
        trackEvent("interview_companion_session_started", {
          credential_ttl_s: credential.expiresInSeconds,
        });
        armCredentialRefresh(credential.expiresInSeconds);
        setCallName(callLabel(status.app));
        setCallApp(status.app);
        setPhase(status.phase === "paused" ? "paused" : "listening");
      })
      .catch((error) => {
        if (startAttemptRef.current !== attempt) return;
        acceptNativeEventsRef.current = false;
        logError("Interview Companion: start", error);
        setPhase("error");
        const timedOutInStart = error instanceof TimeoutError && startInvoked;
        if (timedOutInStart) {
          // The command may still be running. Stop bumps the cancel generation,
          // so a start still in flight returns "cancelled", and a session it
          // already created is torn down rather than left listening unseen.
          startAttemptRef.current += 1;
          void invoke("stop_interview_hacker").catch((stopError) =>
            logError("Interview Companion: stop after start timeout", stopError),
          );
        }
        // Tauri rejects a Rust `Result<T, String>` command with the raw string,
        // not an Error instance, so `error instanceof Error` alone drops every
        // reason start_interview_hacker actually returns.
        const raw =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Interview Companion could not start.";
        const message = timedOutInStart
          ? "Interview Companion took too long to start. Check your connection and try again."
          : error instanceof TimeoutError
            ? "Aura's transcription service took too long to respond. Check your connection and try again."
            : error instanceof AuthRequiredError
              ? "Your sign-in expired. Sign in again, then retry."
              : error instanceof TypeError
                ? "Aura could not reach its transcription service. Check your connection and try again."
                : raw;
        setMessage(message);
        setErrorDetail(`Start error: ${raw}`);
      });
  }, [armCredentialRefresh, phase, plannedMinutes, roundKind]);

  const pause = useCallback(() => {
    invoke("pause_interview_hacker").catch((error) => {
      logError("Interview Companion: pause", error);
      setMessage("Aura could not pause transcription.");
      setErrorDetail(`Pause error: ${errorText(error)}`);
    });
  }, []);

  // Also the card's "Retry transcription". When the worker is parked on a
  // rejected token, resuming as-is would reconnect with that same token and
  // fail the same way, so a fresh one is minted and applied first.
  const resume = useCallback(() => {
    const identity = credentialBlockedRef.current ? identityRef.current : null;
    const blocked = identity !== null;
    if (blocked) setMessage("Refreshing transcription credentials...");
    const recover = identity
      ? mintInterviewCredential().then((credential) =>
        invoke("update_interview_hacker_credential", {
          sessionId: identity.sessionId,
          epoch: identity.epoch,
          accessToken: credential.accessToken,
          openaiAccessToken: credential.openaiAccessToken,
        }).then(() => {
          credentialRetryRef.current = 0;
          credentialBlockedRef.current = false;
          armCredentialRefresh(credential.expiresInSeconds);
        }))
      : Promise.resolve();
    recover
      .then(() => invoke("resume_interview_hacker"))
      .catch((error) => {
        logError("Interview Companion: resume", error);
        setMessage(blocked
          ? "Aura could not refresh the transcription credential. Check your connection and retry."
          : "Aura could not resume transcription.");
        setErrorDetail(`Resume error: ${errorText(error)}`);
      });
  }, [armCredentialRefresh]);

  // The session as the store takes it. Everything is already in memory, so
  // building this costs nothing on the live answer path.
  const buildSessionRecord = useCallback((endedAtMs: number): { uid: string; record: InterviewSessionRecord } | null => {
    const uid = user?.uid;
    const identity = identityRef.current;
    const metrics = metricsRef.current;
    if (!uid || !identity || !metrics) return null;
    const turns = reflectionTurnsRef.current;
    const exchanges = exchangesIncludingLive();
    if (turns.length === 0 && exchanges.length === 0) return null;
    const brief = briefRef.current;
    const record: InterviewSessionRecord = {
      session_id: identity.sessionId,
      started_at_ms: metrics.startedAtMs,
      ended_at_ms: endedAtMs,
      round_kind: roundKindRef.current,
      company: brief?.company?.text ?? null,
      role: brief?.role?.text ?? null,
      brief_id: brief?.briefId ?? null,
      turns: turns.map((turn, index) => ({
        seq: index,
        source: turn.source,
        at_ms: turn.finalWordAtMs ?? turn.endMs ?? turn.startMs,
        text: turn.text,
      })),
      exchanges: exchanges.map((exchange, index) => ({
        seq: index,
        question: exchange.question,
        answer: exchange.answer,
        unverified: exchange.unverified,
      })),
    };
    return { uid, record };
  }, [user?.uid, exchangesIncludingLive]);

  // Writes the finished session to the local encrypted store on Stop. The
  // periodic checkpoint below has usually written most of it already; this is
  // what closes the row.
  const persistCurrentSession = useCallback(() => {
    const built = buildSessionRecord(Date.now());
    if (!built) return;
    void saveInterviewSession(built.uid, built.record).catch((error) =>
      logError("Interview Companion: save session", error),
    );
  }, [buildSessionRecord]);

  // Upserts the running session so a crash keeps everything up to the last
  // tick. Skipped when nothing changed since the previous checkpoint.
  const checkpointCurrentSession = useCallback(() => {
    const built = buildSessionRecord(0);
    if (!built) return;
    const { record } = built;
    const fingerprint = `${record.turns.length}:${record.exchanges.length}:${
      record.exchanges.reduce((total, exchange) => total + exchange.question.length + exchange.answer.length, 0)
    }`;
    if (fingerprint === lastCheckpointRef.current) return;
    lastCheckpointRef.current = fingerprint;
    void checkpointInterviewSession(built.uid, record).catch((error) => {
      lastCheckpointRef.current = "";
      logError("Interview Companion: checkpoint session", error);
    });
  }, [buildSessionRecord]);
  checkpointRef.current = checkpointCurrentSession;

  // One stable interval for the whole signed-in lifetime; it no-ops without a
  // session. Keying it on the callback instead would restart the timer on
  // every state change and starve the checkpoint during a busy interview.
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(() => checkpointRef.current?.(), CHECKPOINT_EVERY_MS);
    return () => clearInterval(timer);
  }, [signedIn]);

  const stop = useCallback(() => {
    startAttemptRef.current += 1;
    const current = identityRef.current;
    const snapshot = reflectionSnapshotForCurrentSession();
    persistCurrentSession();
    if (current) lastStoppedEpochRef.current = Math.max(lastStoppedEpochRef.current, current.epoch);
    recordSessionEnd("user");
    clearSession();
    setReflectionSnapshot(snapshot);
    setReflection(null);
    setPhase(snapshot ? "ended" : "idle");
    invoke("stop_interview_hacker").catch((error) =>
      logError("Interview Companion: stop", error),
    );
  }, [clearSession, persistCurrentSession, recordSessionEnd, reflectionSnapshotForCurrentSession]);

  useEffect(() => {
    if (signedIn) return;
    recordSessionEnd("signed_out");
    clearSession();
    setReflectionSnapshot(null);
    setReflection(null);
    setBrief(null);
    setPhase("idle");
  }, [clearSession, recordSessionEnd, signedIn]);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    loadInterviewBrief()
      .then((loaded) => {
        if (active) setBrief(loaded);
      })
      .catch((error) => logError("Interview Companion: load brief", error));
    listenForInterviewBrief((loaded) => {
      if (active) setBrief(loaded);
    })
      .then((stopListening) => { unlisten = stopListening; })
      .catch((error) => logError("Interview Companion: brief listener", error));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [signedIn]);

  // The resume the preflight can attach when no brief exists. Read from the
  // process-wide Rust slot first; if that is empty, fall back to the resume the
  // user already imported in the dashboard's Interview page.
  //
  // Read-only on the workspace, deliberately: that store is saved whole, so an
  // overlay write would race the dashboard and could wipe prepared interviews.
  useEffect(() => {
    if (!signedIn) {
      setResumeText(null);
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    loadInterviewResume()
      .then(async (stored) => {
        if (!active) return;
        if (stored) setResumeText(stored);
        if (!user?.uid) return;
        // Read on every path, not only the no-resume one: company, role, and the
        // job description feed keyterms even when the resume came from Rust.
        const workspace = await loadInterviewWorkspace(user.uid);
        if (!active || !workspace) return;
        activeInterviewIdRef.current = workspace.activeInterviewId;
        const current = workspace.interviews.find(
          (record) => record.interviewId === workspace.currentInterviewId,
        );
        if (current) {
          prepInputRef.current = {
            company: current.input.company,
            role: current.input.role,
            jobDescription: current.input.jobDescription,
          };
        }
        if (stored) return;
        const fromWorkspace = current?.input.resume.trim();
        if (fromWorkspace) setResumeText(fromWorkspace);
      })
      .catch((error) => logError("Interview Companion: load resume", error));
    listenForInterviewResume((stored) => {
      if (active) setResumeText(stored);
    })
      .then((stopListening) => { unlisten = stopListening; })
      .catch((error) => logError("Interview Companion: resume listener", error));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [signedIn, user?.uid]);

  const attachResume = useCallback((file: File) => {
    setAttachingResume(true);
    setResumeError(null);
    void extractResumeText(file)
      .then((text) => {
        const trimmed = text.slice(0, RESUME_MAX_CHARS);
        return storeInterviewResume(trimmed).then(() => {
          setResumeText(trimmed);
          trackEvent("interview_companion_resume_attached", {
            words: resumeStats(trimmed).words,
          });
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ResumeExtractionError) {
          setResumeError(
            error.code === "unsupported"
              ? "PDF, DOCX, TXT or MD only"
              : error.code === "empty"
                ? "No text found in that file"
                : "Could not read that file",
          );
          return;
        }
        logError("Interview Companion: attach resume", error);
        setResumeError("Could not read that file");
      })
      .finally(() => setAttachingResume(false));
  }, []);

  // Opened fresh every time rather than reusing the mount-time workspace load
  // above: that load only seeds keyterms once, and a prep built in the
  // dashboard minutes before a surprise meeting would otherwise be invisible
  // here. loadInterviewWorkspace is a local cache read, not network I/O, so
  // refetching on every open costs nothing.
  const openBriefMenu = useCallback(() => {
    setBriefMenuOpen(true);
    setBriefMenuError(null);
    if (!user?.uid) return;
    setBriefMenuBusy(true);
    loadInterviewWorkspace(user.uid)
      .then((workspace) => {
        if (!workspace) {
          setPreparedInterviews([]);
          return;
        }
        activeInterviewIdRef.current = workspace.activeInterviewId;
        // Any built brief is switchable, not only ones already marked
        // reviewed: switchToInterview stamps reviewedAtMs itself on
        // selection, the same effect "Use reviewed brief" has in the
        // dashboard. Requiring reviewedAtMs here left "Review needed" history
        // entries invisible to this list even though the dashboard's own
        // Interview history panel shows them.
        setPreparedInterviews(
          workspace.interviews.filter(
            (interview) =>
              interview.draftBrief != null
              && interview.interviewId !== workspace.activeInterviewId,
          ),
        );
      })
      .catch((error: unknown) => {
        logError("Interview Companion: load prepared interviews", error);
        setBriefMenuError("Could not load your prepared interviews.");
      })
      .finally(() => setBriefMenuBusy(false));
  }, [user?.uid]);

  const closeBriefMenu = useCallback(() => {
    setBriefMenuOpen(false);
    setBriefMenuError(null);
  }, []);

  // Mirrors the dashboard's useBrief(): a saved brief is already built, so
  // activating it is just re-stamping and pushing it to the same Rust slot -
  // no rebuild, no LLM call, near-instant.
  const switchToInterview = useCallback((interviewId: string) => {
    const interview = preparedInterviews.find((item) => item.interviewId === interviewId);
    if (!interview?.draftBrief) return;
    setBriefMenuBusy(true);
    setBriefMenuError(null);
    const reviewed: InterviewBrief = {
      ...interview.draftBrief,
      reviewedAtMs: Date.now(),
      lastRoundKind: interview.lastRoundKind ?? DEFAULT_ROUND_KIND,
      plannedMinutes: interview.plannedMinutes ?? DEFAULT_PLANNED_MINUTES,
    };
    storeInterviewBrief(reviewed)
      .then(() => {
        activeInterviewIdRef.current = interviewId;
        trackEvent("interview_companion_brief_switched", {});
        setBriefMenuOpen(false);
      })
      .catch((error: unknown) => {
        logError("Interview Companion: switch brief", error);
        setBriefMenuError("Could not switch to that interview.");
      })
      .finally(() => setBriefMenuBusy(false));
  }, [preparedInterviews]);

  // Clears both the brief and resume slots server-side (clear_preparation
  // clears the resume first), so a stale, wrong-company brief never leaks its
  // claims into answers for an unplanned meeting. The existing brief/resume
  // listeners pick up the resulting events and reset local state on their own.
  const startFresh = useCallback(() => {
    setBriefMenuBusy(true);
    setBriefMenuError(null);
    clearInterviewBrief()
      .then(() => {
        activeInterviewIdRef.current = null;
        trackEvent("interview_companion_brief_reset", {});
        setBriefMenuOpen(false);
      })
      .catch((error: unknown) => {
        logError("Interview Companion: reset brief", error);
        setBriefMenuError("Could not clear the current brief.");
      })
      .finally(() => setBriefMenuBusy(false));
  }, []);

  // Seed the preflight pickers from the brief envelope, which is the only
  // channel that reaches the overlay: the dashboard's workspace record never
  // does. Only while no capture is live - the round picked at Start is
  // authoritative for that session, so a brief republished mid-interview must
  // not silently re-point a round that is already running.
  useEffect(() => {
    if (isInterviewCaptureActive(phase)) return;
    setRoundKind(brief?.lastRoundKind ?? DEFAULT_ROUND_KIND);
    setPlannedMinutes(brief?.plannedMinutes ?? DEFAULT_PLANNED_MINUTES);
  }, [brief, phase]);

  // Pacing caption. Local clock only: no elapsed time is sent anywhere, and no
  // interviewer speech is inspected to decide where the round is.
  useEffect(() => {
    if (!isInterviewCaptureActive(phase)) return;
    const tick = () => {
      const startedAtMs = metricsRef.current?.startedAtMs;
      if (startedAtMs === undefined) return;
      setCaption(pacingCaption(Date.now() - startedAtMs, plannedMinutesRef.current));
    };
    tick();
    const timer = setInterval(tick, PACING_TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

  const evaluate = useCallback((
    turn: InterviewTranscriptTurn,
    recentTurns: InterviewTranscriptTurn[],
    action: InterviewAnswerAction,
    screenSight: InterviewScreenSightFrame | null = null,
    queuedAtMs: number = Date.now(),
  ) => {
    flushAnswerSync();
    const previousAnswer = answerRef.current;
    if (
      action !== "automatic"
      && action !== "suggest"
      && action !== "screen_sight"
      && !previousAnswer.trim()
    ) return;
    const sequence = ++requestSequenceRef.current;
    const controller = new AbortController();
    evaluationsRef.current.add(controller);
    let activated = false;
    let firstDeltaTracked = false;
    // Local to this evaluation; only the activated one is promoted to
    // turnTimingRef, so concurrent evaluations cannot smear each other's stamps.
    const timing: TurnTiming = {
      turnId: turn.turnId,
      action,
      finalWordAtMs: typeof turn.finalWordAtMs === "number" ? turn.finalWordAtMs : null,
      queuedAtMs,
      requestAtMs: Date.now(),
      decisionAtMs: null,
      firstDeltaAtMs: null,
      frozenAtMs: null,
      visibleAtMs: null,
      frozenHoldMs: 0,
      model: null,
      reported: false,
    };

    const activate = () => {
      if (sequence < acceptedSequenceRef.current) {
        controller.abort();
        return false;
      }
      acceptedSequenceRef.current = sequence;
      evaluationsRef.current.forEach((pending) => {
        if (pending !== controller) pending.abort();
      });
      generationRef.current?.abort();
      generationRef.current = controller;
      // Archive the exchange this answer belonged to before its text is cleared
      // below. A DIFFERENT turn means a new question, so the old pair becomes
      // history. The SAME turn means Shorter / Another example / More technical,
      // which refine the answer in place and must never stack up as duplicates.
      // Must run before reading answerRef.current below: a delta can be
      // buffered (scheduleAnswerDelta) but not yet committed to state, and the
      // archive/reset that follows must never silently drop that last chunk.
      flushAnswerSync();
      const previousTurn = activeAnswerTurnRef.current;
      const previousAnswer = answerRef.current;
      const previousUnverified = activeUnverifiedRef.current;
      if (previousTurn && previousTurn.turnId !== turn.turnId && previousAnswer.trim()) {
        setHistory((current) => [
          ...current,
          {
            id: previousTurn.turnId,
            question: previousTurn.text,
            answer: previousAnswer,
            unverified: previousUnverified,
          },
        ].slice(-MAX_HISTORY_EXCHANGES));
      }
      if (previousTurn && previousTurn.turnId !== turn.turnId) setScreenNote(null);
      activeAnswerTurnRef.current = turn;
      activeAnswerActionRef.current = action;
      activeUnverifiedRef.current =
        briefRef.current === null || briefRef.current.reviewedAtMs === null;
      // The answered question is set HERE, not from the raw transcript, so a
      // turn the gate rejects can never re-label the answer already on screen.
      setQuestion(turn.text);
      setInterimQuestion("");
      setQuestionPending(false);
      activated = true;
      turnTimingRef.current = timing;
      setDrafting(true);
      if (candidateSpeakingRef.current) {
        frozenDeltasRef.current = "";
        replaceAfterSpeechRef.current = true;
      } else {
        resetAnswer();
      }
      setMessage(null);
      return true;
    };

    if (action !== "automatic") activate();
    // Question-independent, so it is byte-identical across the session and the
    // backend can hold it in a prompt cache instead of re-prefilling it. Also
    // fixes the old demotion: a reviewed brief no longer ranks to an empty slice
    // for an off-axis question and silently drops into unverified mode.
    const slice = stableInterviewBriefSlice(briefRef.current);
    void streamInterviewAnswer({
      turn,
      recentTurns,
      brief: slice,
      // Always sent now. It rides the cached prefix, so a cache read costs a
      // fraction of a prefill - the per-turn re-upload the old conditional
      // avoided is no longer the cost it was guarding against.
      resume: resumeTextRef.current ?? "",
      answerShape: answerShapeRef.current,
      action,
      currentAnswer: previousAnswer,
      screenSight,
      screenNotes: screenNotesRef.current,
      signal: controller.signal,
      onFrame: (frame) => {
        if (controller.signal.aborted) return;
        if (frame.type === "decision") {
          timing.decisionAtMs = Date.now();
          timing.model = frame.model;
          if (action === "automatic") {
            if (metricsRef.current) {
              if (frame.accepted) metricsRef.current.accepted += 1;
              else metricsRef.current.rejected += 1;
              // Collapse on the SECOND accepted answer, not the first. The
              // first accepted question is most likely "tell me about
              // yourself", and folding the card on it hides the pitch while
              // the candidate is mid-sentence reading it.
              //
              // Exactly equal, not >=, so this fires once at the transition. On
              // >= every later answer would re-collapse a card the candidate
              // had deliberately reopened to re-read.
              if (metricsRef.current.accepted === PITCH_COLLAPSE_AFTER_ACCEPTED) {
                setPitchExpanded(false);
              }
            }
            trackEvent("interview_companion_question_decision", {
              accepted: frame.accepted,
              action,
              gate_ms: frame.gateMs,
              target: frame.target,
              intent: frame.intent,
              remote_speaker_present: Boolean(turn.remoteSpeakerId),
              speaker_overlap: Boolean(turn.speakerOverlap),
            });
          }
          if (frame.accepted) {
            if (!activated) activate();
          } else {
            const activeTurn = activeAnswerTurnRef.current;
            const sameSpeaker = (activeTurn?.remoteSpeakerId ?? null)
              === (turn.remoteSpeakerId ?? null);
            const invalidatesEarlier = frame.target === "crosstalk"
              || frame.target === "media_playback"
              || frame.target === "another_interviewer"
              || (frame.target === "self" && sameSpeaker);
            if (
              invalidatesEarlier
              && activeAnswerActionRef.current === "automatic"
              && sequence >= acceptedSequenceRef.current
            ) {
              acceptedSequenceRef.current = sequence;
              generationRef.current?.abort();
              generationRef.current = null;
              activeAnswerTurnRef.current = null;
              activeAnswerActionRef.current = null;
              setDrafting(false);
              if (candidateSpeakingRef.current) {
                frozenDeltasRef.current = "";
                replaceAfterSpeechRef.current = true;
              } else {
                resetAnswer();
              }
            }
            setMessage(null);
          }
        } else if (frame.type === "screen_note") {
          if (!activated || generationRef.current !== controller) return;
          screenNotesRef.current = [...screenNotesRef.current, frame.note].slice(-3);
          setScreenNote(frame.note);
        } else if (frame.type === "answer_delta") {
          if (!activated || generationRef.current !== controller) return;
          if (!firstDeltaTracked) {
            firstDeltaTracked = true;
            timing.firstDeltaAtMs = Date.now();
            const timingAvailable = typeof turn.finalWordAtMs === "number";
            trackEvent("interview_companion_first_answer_text", {
              action,
              timing_available: timingAvailable,
              ...(timingAvailable
                ? { latency_ms: Math.max(0, Date.now() - (turn.finalWordAtMs as number)) }
                : {}),
            });
          }
          // Only an automatic answer waits behind the candidate's own voice. A
          // clicked one (Answer now, Shorter, Screen Sight) is an explicit ask
          // and lands while they read.
          if (candidateSpeakingRef.current && action === "automatic") {
            if (timing.frozenAtMs === null) timing.frozenAtMs = Date.now();
            frozenDeltasRef.current += frame.delta;
          } else {
            if (timing.visibleAtMs === null) {
              timing.visibleAtMs = Date.now();
              reportTurnLatency(timing);
              setDrafting(false);
            }
            scheduleAnswerDelta(frame.delta);
          }
        } else if (frame.type === "answer_done") {
          if (!activated || generationRef.current !== controller) return;
          setDrafting(false);
          trackEvent("interview_companion_answer_completed", {
            action,
            generated: frame.generated,
            answer_ms: frame.answerMs,
          });
          setMessage(frame.generated ? null : "No answer needed for that turn.");
        } else if (frame.type === "error") {
          if (metricsRef.current) metricsRef.current.errors += 1;
          trackEvent("interview_companion_error", { code: frame.code, stage: "answer" });
          if (generationRef.current === controller) setDrafting(false);
          if (activated || generationRef.current === null) setMessage(frame.message);
        }
      },
    }).catch((error) => {
      // Discard rather than fold in: this generation failed, so whatever it
      // had buffered for the next animation frame is exactly the text about
      // to be reverted/abandoned below, and must not reappear if it fires
      // after this handler runs.
      if (answerFlushFrameRef.current !== null) {
        cancelAnimationFrame(answerFlushFrameRef.current);
        answerFlushFrameRef.current = null;
      }
      pendingAnswerDeltaRef.current = "";
      if (controller.signal.aborted) return;
      if (metricsRef.current) metricsRef.current.errors += 1;
      trackEvent("interview_companion_error", { code: "stream_failed", stage: "answer" });
      if (activated && action !== "automatic" && previousAnswer && !candidateSpeakingRef.current) {
        answerRef.current = previousAnswer;
        setAnswer(previousAnswer);
      }
      if (activated) {
        replaceAfterSpeechRef.current = false;
        frozenDeltasRef.current = "";
        setDrafting(false);
      }
      logError("Interview Companion: answer stream", error);
      if (activated || generationRef.current === null) {
        setMessage("Aura could not draft an answer for that turn.");
      }
    }).finally(() => {
      evaluationsRef.current.delete(controller);
      if (generationRef.current === controller) generationRef.current = null;
    });
  }, [reportTurnLatency]);

  const runManualAction = useCallback((
    action: Exclude<InterviewAnswerAction, "automatic" | "screen_sight">,
  ) => {
    const turn = lastRemoteTurnRef.current;
    if (!turn) return;
    const recentTurns = recentRef.current.filter((item) => item.turnId !== turn.turnId);
    evaluate(turn, recentTurns, action);
  }, [evaluate]);

  const screenSight = useCallback(() => {
    const turn = lastRemoteTurnRef.current;
    const identity = identityRef.current;
    if (!turn || !identity || phase !== "listening" || screenCaptureInFlightRef.current) return;
    const sequence = ++screenCaptureSequenceRef.current;
    screenCaptureInFlightRef.current = true;
    setCapturingScreen(true);
    setMessage("Looking at this screen once...");
    invoke("capture_interview_screen_with_geometry")
      .then((raw) => parseCapturedFrame(asArrayBuffer(raw)))
      .then(async (frame) => {
        if (
          sequence !== screenCaptureSequenceRef.current
          || identityRef.current?.sessionId !== identity.sessionId
          || identityRef.current.epoch !== identity.epoch
        ) return null;
        return {
          mimeType: "image/jpeg" as const,
          data: await toBase64(frame.bytes),
          widthPx: frame.geometry.jpegWidthPx,
          heightPx: frame.geometry.jpegHeightPx,
          capturedAtMs: Date.now(),
        };
      })
      .then((frame) => {
        if (!frame || sequence !== screenCaptureSequenceRef.current) return;
        trackEvent("interview_companion_screen_sight", {
          outcome: "captured",
          image_bytes: Math.round(frame.data.length * 0.75),
        });
        evaluate(
          turn,
          recentRef.current.filter((item) => item.turnId !== turn.turnId),
          "screen_sight",
          frame,
        );
      })
      .catch((error) => {
        if (sequence !== screenCaptureSequenceRef.current) return;
        logError("Interview Companion: one-shot Screen Sight", error);
        trackEvent("interview_companion_screen_sight", { outcome: "failed" });
        setMessage("Aura could not capture this screen. Keep it visible and try again.");
      })
      .finally(() => {
        if (sequence !== screenCaptureSequenceRef.current) return;
        screenCaptureInFlightRef.current = false;
        setCapturingScreen(false);
      });
  }, [evaluate, phase]);

  const reflect = useCallback(() => {
    if (!reflectionSnapshot || phase === "reflecting" || reflectionRequestRef.current) return;
    const controller = new AbortController();
    reflectionRequestRef.current = controller;
    setPhase("reflecting");
    setMessage("Reflecting on the interview...");
    void createInterviewReflection({ ...reflectionSnapshot, signal: controller.signal })
      .then((result) => {
        setReflection(result);
        setMessage("Saved with this session. Download it any time from the Interview page.");
        setPhase("reflection");
        trackEvent("interview_companion_reflection", { outcome: "generated" });
        // Kept beside the transcript it was derived from, in the same encrypted
        // store and under the same retention. Dismiss used to destroy this.
        const uid = user?.uid;
        if (uid) {
          void saveInterviewReflection(uid, reflectionSnapshot.sessionId, result)
            .catch((error) =>
              logError("Interview Companion: save reflection to store", error));
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        logError("Interview Companion: reflection", error);
        setMessage("Aura could not build the reflection. You can try again while this card is open.");
        setPhase("ended");
        trackEvent("interview_companion_reflection", { outcome: "failed" });
      })
      .finally(() => {
        if (reflectionRequestRef.current === controller) reflectionRequestRef.current = null;
      });
  }, [phase, reflectionSnapshot, user?.uid]);

  const saveReflection = useCallback(() => {
    if (!reflection || savingReflectionRef.current) return;
    const sequence = ++savingReflectionSequenceRef.current;
    savingReflectionRef.current = true;
    setSavingReflection(true);
    setMessage("Writing a copy to Downloads...");
    void invoke<{ path: string }>("save_interview_reflection", {
      markdown: reflectionMarkdown(reflection),
    })
      .then((result) => {
        if (sequence !== savingReflectionSequenceRef.current) return;
        setMessage(`Saved to ${result.path}`);
        trackEvent("interview_companion_reflection", { outcome: "saved" });
      })
      .catch((error) => {
        if (sequence !== savingReflectionSequenceRef.current) return;
        logError("Interview Companion: save reflection", error);
        setMessage("Aura could not write the file. The reflection is still saved with this session.");
      })
      .finally(() => {
        if (sequence !== savingReflectionSequenceRef.current) return;
        savingReflectionRef.current = false;
        setSavingReflection(false);
      });
  }, [reflection]);

  const dismissReflection = useCallback(() => {
    reflectionRequestRef.current?.abort();
    reflectionRequestRef.current = null;
    savingReflectionRef.current = false;
    savingReflectionSequenceRef.current += 1;
    setSavingReflection(false);
    setReflectionSnapshot(null);
    setReflection(null);
    setMessage(null);
    setPhase("idle");
  }, []);

  useEffect(() => {
    // If unmount wins the race against listen() resolving, the resolved
    // unlisten must still run or the native listener leaks.
    let disposed = false;
    let unlistenStatus: (() => void) | undefined;
    let unlistenTranscript: (() => void) | undefined;

    const flushRemoteTurn = (action: InterviewAnswerAction = "automatic") => {
      const pending = assemblyRef.current;
      if (!pending) return;
      if (pending.timer !== null) clearTimeout(pending.timer);
      assemblyRef.current = null;
      setQuestionPending(false);
      const recentTurns = recentRef.current;
      recentRef.current = [...recentTurns, pending.turn].slice(-12);
      rememberReflectionTurn(pending.turn);
      lastRemoteTurnRef.current = pending.turn;
      setCanSuggest(true);
      evaluate(pending.turn, recentTurns, action, null, pending.queuedAtMs);
    };
    flushNowRef.current = flushRemoteTurn;

    // A final that ends mid-sentence is probably a question the silence
    // endpointing split, so it waits longer for its continuation than one that
    // arrived with terminal punctuation.
    const flushDelayFor = (text: string) =>
      /[.?!]["')\]]?$/.test(text.trim())
        ? assemblyMsRef.current
        : Math.max(assemblyMsRef.current, INCOMPLETE_HOLD_MS);

    // Manual mode: one paragraph, any speaker, no timer. It leaves only when
    // the user sends it, so the next automatic-mode rule (a different speaker
    // flushes the previous question) does not apply.
    const collectManualTurn = (turn: InterviewTranscriptTurn) => {
      const pending = assemblyRef.current;
      if (pending?.timer) clearTimeout(pending.timer);
      const merged = pending ? mergeRemoteTurns(pending.turn, turn) : turn;
      const text = trimParagraphFront(merged.text, MANUAL_PARAGRAPH_MAX_CHARS);
      assemblyRef.current = {
        turn: { ...merged, text },
        timer: null,
        queuedAtMs: pending?.queuedAtMs ?? Date.now(),
      };
      setQuestionPending(true);
      setInterimQuestion(text);
    };

    applyAnswerModeRef.current = (mode: AnswerMode) => {
      const pending = assemblyRef.current;
      if (!pending) return;
      if (pending.timer !== null) clearTimeout(pending.timer);
      if (mode === "manual") {
        pending.timer = null;
        setInterimQuestion(pending.turn.text);
        return;
      }
      pending.timer = setTimeout(flushRemoteTurn, flushDelayFor(pending.turn.text));
    };

    const queueRemoteTurn = (turn: InterviewTranscriptTurn) => {
      if (answerModeRef.current === "manual") {
        collectManualTurn(turn);
        return;
      }
      const pending = assemblyRef.current;
      if (pending) {
        const sameSpeaker = (pending.turn.remoteSpeakerId ?? null)
          === (turn.remoteSpeakerId ?? null);
        if (sameSpeaker) {
          if (pending.timer !== null) clearTimeout(pending.timer);
          const merged = mergeRemoteTurns(pending.turn, turn);
          assemblyRef.current = {
            turn: merged,
            timer: setTimeout(flushRemoteTurn, flushDelayFor(merged.text)),
            queuedAtMs: pending.queuedAtMs,
          };
          return;
        }
        flushRemoteTurn();
      }
      setQuestionPending(true);
      assemblyRef.current = {
        turn,
        timer: setTimeout(flushRemoteTurn, flushDelayFor(turn.text)),
        queuedAtMs: Date.now(),
      };
    };

    const isEchoOrRepeat = (turn: InterviewTranscriptTurn) => {
      const now = Date.now();
      recentAudioRef.current = recentAudioRef.current.filter(
        (item) => now - item.atMs <= ECHO_WINDOW_MS,
      );
      const duplicate = recentAudioRef.current.some((item) =>
        isNearDuplicate(item.text, turn.text),
      );
      if (!duplicate) {
        recentAudioRef.current.push({ source: turn.source, text: turn.text, atMs: now });
      }
      return duplicate;
    };

    listen<StatusPayload>(INTERVIEW_HACKER_STATUS, (event) => {
      const status = event.payload;
      if (status.phase === "stopped") {
        if (status.epoch !== null && status.epoch <= lastStoppedEpochRef.current) return;
        const current = identityRef.current;
        if (
          current
          && status.sessionId
          && (current.sessionId !== status.sessionId || current.epoch !== status.epoch)
        ) return;
        if (status.epoch !== null) {
          lastStoppedEpochRef.current = Math.max(lastStoppedEpochRef.current, status.epoch);
        }
        const reason = status.reason ?? "stopped";
        recordSessionEnd(reason);
        clearSession();
        if (reason === "session_limit") {
          setPhase("error");
          setMessage("Interview Companion stopped after the two-hour session limit. Start it again to continue.");
        } else if (reason === "worker_panic") {
          setPhase("error");
          setMessage("Transcription stopped unexpectedly. Start Interview Companion again.");
          setErrorDetail("Error code: worker_panic. The transcription worker crashed and was cleaned up.");
        } else {
          setPhase("idle");
        }
        return;
      }
      if (!acceptNativeEventsRef.current) return;
      if (!status.sessionId || status.epoch === null) return;
      if (status.epoch <= lastStoppedEpochRef.current) return;
      const current = identityRef.current;
      if (current && (current.sessionId !== status.sessionId || current.epoch !== status.epoch)) {
        return;
      }
      identityRef.current = { sessionId: status.sessionId, epoch: status.epoch };
      setRecoverable(true);
      setCallName(callLabel(status.app));
      setCallApp(status.app);
      setPhase(status.phase);
      if (status.reason === "credential_expired") {
        credentialBlockedRef.current = true;
        setMessage("Refreshing transcription credentials...");
        setErrorDetail("Error code: credential_expired. Aura is refreshing the transcription credential automatically.");
        rotateCredentialRef.current?.();
      } else if (status.reason === "session_limit_warning") {
        setMessage("Interview Companion stops automatically in 5 minutes (two-hour session limit).");
        setErrorDetail(null);
      } else if (status.reason === "device_switch" || status.reason?.endsWith("_device_switch")) {
        if (metricsRef.current) metricsRef.current.deviceSwitches += 1;
        trackEvent("interview_companion_recovery", { kind: "device_switch" });
        setMessage(`${status.reason?.startsWith("candidate_") ? "Microphone" : "Call audio device"} changed. Aura is reconnecting transcription.`);
        setErrorDetail(`Error code: ${status.reason}. Automatic reconnection is in progress.`);
      } else if (status.reason === "device_unavailable" || status.reason?.endsWith("_device_unavailable")) {
        if (metricsRef.current) metricsRef.current.errors += 1;
        trackEvent("interview_companion_error", { code: status.reason ?? "device_unavailable", stage: "capture" });
        setMessage(`Aura cannot access the ${status.reason?.startsWith("candidate_") ? "microphone" : "call audio device"}. Check it in ${osName()}; Aura will retry safely.`);
        setErrorDetail(`Error code: ${status.reason ?? "device_unavailable"}. ${status.phase === "error" ? "Automatic retries were exhausted." : "Automatic retry is in progress."}`);
      } else if (status.reason === "reconnected" || status.reason === "device_recovered") {
        if (metricsRef.current) metricsRef.current.reconnects += 1;
        trackEvent("interview_companion_recovery", { kind: status.reason });
        setMessage(null);
        setErrorDetail(null);
      } else if (status.reason === "fallback_openai") {
        if (metricsRef.current) metricsRef.current.reconnects += 1;
        trackEvent("interview_companion_recovery", { kind: "fallback_openai" });
        setMessage(status.phase === "listening"
          ? "Deepgram was unavailable. Transcription is continuing with OpenAI."
          : "Deepgram was unavailable. Aura is switching transcription to OpenAI.");
        setErrorDetail("Error code: fallback_openai. Candidate and call audio remain source-separated.");
      } else {
        if (status.phase === "degraded" || status.phase === "error") {
          if (metricsRef.current) metricsRef.current.errors += 1;
          trackEvent("interview_companion_error", {
            code: status.reason ?? "transcription_interrupted",
            stage: "transcription",
          });
        }
        setMessage(
          status.phase === "degraded"
            ? "Transcription was interrupted. Aura is retrying automatically."
            : status.phase === "error"
              ? "Transcription stopped after 10 automatic retries."
              : null,
        );
        setErrorDetail(
          status.phase === "degraded" || status.phase === "error"
            ? `Error code: ${status.reason ?? "transcription_interrupted"}. ${status.phase === "error" ? "Automatic retries were exhausted." : "Automatic retry is in progress."}`
            : null,
        );
      }
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenStatus = unlisten;
      })
      .catch((error) => logError("Interview Companion: status listener", error));

    listen<InterviewTranscriptTurn>(INTERVIEW_HACKER_TRANSCRIPT, (event) => {
      const turn = event.payload;
      const identity = identityRef.current;
      if (
        !identity
        || turn.sessionId !== identity.sessionId
        || turn.epoch !== identity.epoch
      ) return;

      if (turn.source === "candidate") {
        if (!turn.isFinal) {
          if (!candidateSpeakingRef.current) frozenDeltasRef.current = "";
          candidateSpeakingRef.current = true;
          setCandidateSpeaking(true);
          return;
        }
        candidateSpeakingRef.current = false;
        setCandidateSpeaking(false);
        // A pre-speech delta can still be buffered (scheduleAnswerDelta) when
        // speech starts; fold it in before splicing on the frozen (held-during-
        // speech) text, or the two chunks land out of chronological order.
        flushAnswerSync();
        const frozen = frozenDeltasRef.current;
        if (replaceAfterSpeechRef.current) {
          answerRef.current = frozen;
          setAnswer(frozen);
        } else if (frozen) {
          answerRef.current += frozen;
          setAnswer((current) => current + frozen);
        }
        if (frozen) {
          // The answer only became visible now; the hold behind candidate
          // speech is its own stage in the latency report.
          const timing = turnTimingRef.current;
          if (timing && timing.visibleAtMs === null) {
            timing.visibleAtMs = Date.now();
            if (timing.frozenAtMs !== null) {
              timing.frozenHoldMs = timing.visibleAtMs - timing.frozenAtMs;
            }
            reportTurnLatency(timing);
            setDrafting(false);
          }
        }
        frozenDeltasRef.current = "";
        replaceAfterSpeechRef.current = false;
        if (isEchoOrRepeat(turn)) return;
        recentRef.current = [...recentRef.current, turn].slice(-12);
        rememberReflectionTurn(turn);
        return;
      }

      if (!turn.isFinal) {
        if (turn.text.trim()) {
          lastRemoteInterimRef.current = turn;
          setQuestionPending(true);
          const pending = assemblyRef.current;
          if (answerModeRef.current === "manual") {
            // Show what Answer now would send: the collected paragraph plus
            // the words still arriving.
            setInterimQuestion(
              pending ? `${pending.turn.text} ${turn.text}`.trim() : turn.text,
            );
            return;
          }
          setInterimQuestion(turn.text);
          // The speaker is demonstrably still talking, so a pending flush from
          // their earlier fragment waits for the final this interim precedes.
          if (
            pending
            && (pending.turn.remoteSpeakerId ?? null) === (turn.remoteSpeakerId ?? null)
          ) {
            if (pending.timer !== null) clearTimeout(pending.timer);
            pending.timer = setTimeout(flushRemoteTurn, INTERIM_EXTEND_MS);
          }
        }
        return;
      }
      if (!turn.text.trim() || isEchoOrRepeat(turn)) return;
      if (answerModeRef.current !== "manual") setInterimQuestion(turn.text);
      queueRemoteTurn(turn);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenTranscript = unlisten;
      })
      .catch((error) => logError("Interview Companion: transcript listener", error));

    return () => {
      disposed = true;
      if (assemblyRef.current?.timer) clearTimeout(assemblyRef.current.timer);
      assemblyRef.current = null;
      applyAnswerModeRef.current = null;
      unlistenStatus?.();
      unlistenTranscript?.();
    };
  }, [clearSession, evaluate, recordSessionEnd, rememberReflectionTurn, reportTurnLatency]);

  /** User-initiated "answer this now": flushes a held question immediately, or,
   * when only interim speech exists, answers from the freshest interim text,
   * or, with nothing new at all, answers the last interviewer turn again.
   * Runs as "suggest" because a question the user explicitly sent must not be
   * second-guessed by the gate. */
  const sendNow = useCallback(() => {
    if (!identityRef.current) return;
    if (assemblyRef.current) {
      flushNowRef.current?.("suggest");
      return;
    }
    const interim = lastRemoteInterimRef.current;
    if (!interim || !interim.text.trim()) {
      runManualAction("suggest");
      return;
    }
    lastRemoteInterimRef.current = null;
    const synthetic: InterviewTranscriptTurn = { ...interim, isFinal: true };
    // Seed the echo window so the provider's own final for this speech dedups
    // unless it carries materially more words than what was sent.
    recentAudioRef.current.push({
      source: "remote",
      text: synthetic.text,
      atMs: Date.now(),
    });
    const recentTurns = recentRef.current.filter((item) => item.turnId !== synthetic.turnId);
    recentRef.current = [...recentTurns, synthetic].slice(-12);
    rememberReflectionTurn(synthetic);
    lastRemoteTurnRef.current = synthetic;
    setCanSuggest(true);
    setQuestionPending(false);
    evaluate(synthetic, recentTurns, "suggest");
  }, [evaluate, rememberReflectionTurn, runManualAction]);

  return {
    phase,
    callName,
    callApp,
    callBlocker,
    blockerAsked,
    requestCallAccess,
    history,
    question,
    answer,
    interimQuestion,
    briefReady: brief !== null && brief.reviewedAtMs !== null,
    resumeWords: resumeText ? resumeStats(resumeText).words : null,
    attachingResume,
    resumeError,
    attachResume,
    preparedInterviews,
    briefMenuOpen,
    briefMenuBusy,
    briefMenuError,
    openBriefMenu,
    closeBriefMenu,
    switchToInterview,
    startFresh,
    canSuggest,
    recoverable,
    candidateSpeaking,
    drafting,
    questionPending,
    sendNow,
    capturingScreen,
    screenNote,
    savingReflection,
    reflection,
    message,
    errorDetail,
    roundKind,
    plannedMinutes,
    setRoundKind,
    setPlannedMinutes,
    pitch,
    pitchExpanded,
    togglePitch: () => setPitchExpanded((current) => !current),
    pacingCaption: caption,
    openPreflight,
    dismiss,
    start,
    pause,
    resume,
    stop,
    shorter: () => runManualAction("shorter"),
    screenSight,
    answerMode,
    setAnswerMode,
    reflect,
    saveReflection,
    dismissReflection,
  };
}
