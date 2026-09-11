import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isMac } from "./platformKeys";
import { micCaptureFailedCode } from "./voiceErrorCopy";

export const microphoneConstraints: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export class MicrophoneAccessError extends Error {
  readonly code: "mic_permission_denied" | typeof micCaptureFailedCode;

  constructor(code: "mic_permission_denied" | typeof micCaptureFailedCode, _cause?: unknown) {
    super(code);
    this.name = "MicrophoneAccessError";
    this.code = code;
  }
}

function errorName(error: unknown): string {
  if (typeof error !== "object" || error === null || !("name" in error)) return "";
  return String(error.name);
}

export function microphoneErrorCode(
  error: unknown,
): "mic_permission_denied" | typeof micCaptureFailedCode {
  if (error instanceof MicrophoneAccessError) return error.code;
  const name = errorName(error);
  return name === "NotAllowedError" || name === "SecurityError"
    ? "mic_permission_denied"
    : micCaptureFailedCode;
}

export async function requestMicrophoneStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneAccessError(micCaptureFailedCode);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      throw new MicrophoneAccessError(micCaptureFailedCode);
    }
    return stream;
  } catch (error) {
    if (error instanceof MicrophoneAccessError) throw error;
    throw new MicrophoneAccessError(microphoneErrorCode(error), error);
  }
}

export function resetMicrophonePermission(): Promise<void> {
  return invoke("reset_microphone_permission");
}

export function openMicrophoneSettings(): Promise<void> {
  return openUrl(
    isMac()
      ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
      : "ms-settings:privacy-microphone",
  );
}

export function microphoneSettingsLabel(): string {
  return isMac() ? "Open macOS settings" : "Open Windows settings";
}
