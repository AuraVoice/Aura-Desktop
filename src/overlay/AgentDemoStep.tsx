import { useEffect, useRef, useState } from "react";
import { agentDemo as copy } from "../lib/copy";
import { outputMuted } from "../lib/outputMode";
import { useAudioLevels } from "./useAudioLevels";
import type { VoiceBarState, VoiceSessionStatus } from "./useVoiceBar";
import "./AgentDemoStep.css";

interface AgentDemoStepProps {
  /** The onboarding host's one voice instance. Never create another here,
   * which would open a second LiveKit room. */
  voice: VoiceBarState;
  /** Ends the demo and hands off to the dashboard. Called on finish or skip. */
  onFinish: () => void;
}

const LIVE_STATUSES = new Set(["listening", "processing", "speaking"]);
const WARNING_AFTER_MS = 3 * 60 * 1_000;
const END_AFTER_MS = WARNING_AFTER_MS + 30 * 1_000;

/** Post-sign-in step: a real voice session so the user experiences Buddy once
 * before landing. Reuses the same start/stop the notch uses, but keeps the
 * onboarding surface up (no summon_bar) and shows the live caption inline.
 * The dashboard handoff never depends on a successful call - any error still
 * offers Skip. */
export function AgentDemoStep({ voice, onFinish }: AgentDemoStepProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cutoffStartedRef = useRef(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [graceSeconds, setGraceSeconds] = useState(30);
  const [inGracePeriod, setInGracePeriod] = useState(false);
  const [expired, setExpired] = useState(false);
  const isRealtimeLive = voice.realtimeActivity !== null;
  const isLive = isRealtimeLive || LIVE_STATUSES.has(voice.status);
  const isError = voice.status === "error";
  const isConnecting = voice.desiredActive && !isLive && !isError;

  const visualStatus: VoiceSessionStatus =
    voice.realtimeActivity === "thinking"
      ? "processing"
      : voice.realtimeActivity === "buddy_talking"
        ? "speaking"
        : voice.realtimeActivity
          ? "listening"
          : voice.status;
  useAudioLevels(
    voice.room,
    visualStatus,
    canvasRef,
    voice.realtimeVisualizerTrack,
  );

  useEffect(() => {
    if (startedAt === null) return;

    const warningAt = startedAt + WARNING_AFTER_MS;
    const endAt = startedAt + END_AFTER_MS;
    const updateClock = () => {
      const now = Date.now();
      if (now >= warningAt) {
        setInGracePeriod(true);
        setGraceSeconds(Math.max(0, Math.ceil((endAt - now) / 1_000)));
      }
      if (now < endAt || cutoffStartedRef.current) return;
      cutoffStartedRef.current = true;
      setStartedAt(null);
      void voice.endSession().finally(() => setExpired(true));
    };

    updateClock();
    const interval = setInterval(updateClock, 250);
    return () => clearInterval(interval);
  }, [startedAt, voice.endSession]);

  useEffect(() => {
    if (isError) setStartedAt(null);
  }, [isError]);

  async function start() {
    if (startedAt !== null || expired) return;
    cutoffStartedRef.current = false;
    setGraceSeconds(30);
    setInGracePeriod(false);
    setStartedAt(Date.now());
    if (outputMuted()) {
      await voice.startSession();
    } else {
      await voice.startBridgedSession();
    }
  }

  async function finish() {
    setStartedAt(null);
    setInGracePeriod(false);
    if (voice.desiredActive) {
      // endSession swallows/logs its own failures; never let a teardown error
      // trap the user in onboarding.
      await voice.endSession().catch(() => {});
    }
    onFinish();
  }

  const activityText = isError
    ? voice.errorMessage ?? copy.errorHint
    : voice.realtimeActivity === "user_talking"
      ? copy.userTalking
      : voice.realtimeActivity === "thinking" || voice.status === "processing"
        ? copy.thinking
        : voice.realtimeActivity === "buddy_talking" || voice.status === "speaking"
          ? copy.buddyTalking
          : isLive
            ? copy.listening
      : isConnecting
        ? copy.connecting
        : copy.body;

  if (expired) {
    return (
      <div className="onboarding-step agent-demo-step">
        <h2 className="onboarding-heading">{copy.heading}</h2>
        <p className="agent-demo-status" aria-live="polite">
          {copy.timeEnded}
        </p>
        <button type="button" className="onboarding-primary-button" onClick={onFinish}>
          {copy.continue}
        </button>
      </div>
    );
  }

  return (
    <div className="onboarding-step agent-demo-step">
      <h2 className="onboarding-heading">{copy.heading}</h2>
      <p className="agent-demo-status" aria-live="polite">
        {activityText}
      </p>
      {(isLive || isConnecting) && (
        <div className="agent-demo-voice">
          <canvas ref={canvasRef} className="agent-demo-waveform" aria-hidden="true" />
          {voice.assistantCaption && voice.status === "speaking" && (
            <p className="agent-demo-caption">{voice.assistantCaption}</p>
          )}
        </div>
      )}
      {startedAt !== null && inGracePeriod && (
        <div className="agent-demo-warning">
          <span role="status" aria-live="polite">{copy.timeWarning} 30 seconds.</span>
          <strong aria-hidden="true">0:{String(graceSeconds).padStart(2, "0")}</strong>
        </div>
      )}
      {!isLive && !isConnecting && (
        <button
          type="button"
          className="onboarding-primary-button"
          onClick={() => void start()}
        >
          {copy.start}
        </button>
      )}
      {(isLive || isConnecting) && (
        <button type="button" className="onboarding-primary-button" onClick={() => void finish()}>
          {copy.finish}
        </button>
      )}
      <button type="button" className="onboarding-link-button" onClick={() => void finish()}>
        {copy.skip}
      </button>
    </div>
  );
}
