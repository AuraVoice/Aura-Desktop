/** Direct port of voice_error_copy.dart - verbatim, shared by every surface that shows a dropped-call error. */

export const micCaptureFailedCode = "mic_capture_failed";

const CODE_MESSAGES: Record<string, string> = {
  agent_join_timeout: "Buddy's taking too long to pick up. Give it another tap?",
  agent_silent: "Buddy's connected but gone quiet on me. Tap to try again?",
  agent_disconnected_early: "Call dropped before Buddy could say anything. Let's try again?",
  provider_unavailable:
    "Buddy's voice is having a moment on our end. Hang tight and try again shortly.",
  agent_state_failed: "Buddy hit a snag mid-call. Mind tapping to start over?",
  session_runtime_failed: "Buddy hit a snag mid-call. Mind tapping to start over?",
  tts_pipeline_failed: "Buddy hit a snag mid-call. Mind tapping to start over?",
  mic_permission_denied: "I need mic access to hear you. Flip it on in Settings and tap again.",
  [micCaptureFailedCode]:
    "Couldn't access your mic. Check it's plugged in and allowed in Settings, then try again.",
};

const DEFAULT_MESSAGE = "Something went sideways with the call. Tap to try again?";

export function voiceErrorMessageForCode(args: {
  code?: string | null;
  fallbackMessage?: string | null;
}): string {
  const { code, fallbackMessage } = args;
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  return fallbackMessage && fallbackMessage.length > 0 ? fallbackMessage : DEFAULT_MESSAGE;
}
