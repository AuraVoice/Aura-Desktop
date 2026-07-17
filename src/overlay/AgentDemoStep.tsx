import { agentDemo as copy } from "../lib/copy";
import type { VoiceBarState } from "./useVoiceBar";
import "./AgentDemoStep.css";

interface AgentDemoStepProps {
  /** The hoisted voice instance from OverlayRoot - never a second useVoiceBar(),
   * which would open a second LiveKit room. */
  voice: VoiceBarState;
  /** Ends the demo and hands off to the dashboard. Called on finish or skip. */
  onFinish: () => void;
}

const LIVE_STATUSES = new Set(["listening", "processing", "speaking"]);

/** Post-sign-in step: a real voice session so the user experiences Buddy once
 * before landing. Reuses the same start/stop the notch uses, but keeps the
 * onboarding surface up (no summon_bar) and shows the live caption inline.
 * The dashboard handoff never depends on a successful call - any error still
 * offers Skip. */
export function AgentDemoStep({ voice, onFinish }: AgentDemoStepProps) {
  const isLive = LIVE_STATUSES.has(voice.status);
  const isError = voice.status === "error";
  const isConnecting = voice.desiredActive && !isLive && !isError;

  async function finish() {
    if (voice.desiredActive) {
      // endSession swallows/logs its own failures; never let a teardown error
      // trap the user in onboarding.
      await voice.endSession().catch(() => {});
    }
    onFinish();
  }

  const statusText = isError
    ? voice.errorMessage ?? copy.errorHint
    : isLive
      ? voice.assistantCaption || copy.live
      : isConnecting
        ? copy.connecting
        : copy.body;

  return (
    <div className="onboarding-step">
      <h2 className="onboarding-heading">{copy.heading}</h2>
      <p className="agent-demo-status" aria-live="polite">
        {statusText}
      </p>
      {!isLive && !isConnecting && (
        <button
          type="button"
          className="onboarding-primary-button"
          onClick={() => void voice.startSession()}
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
