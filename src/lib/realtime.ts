import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { authFetch } from "./api";
import { logError, logInfo } from "./log";

// One conversational turn gathered by the Realtime leg, seeded into the LiveKit
// worker's ChatContext at handover (see bridgeCoordinator.ts + the backend's
// bridge_handover.py wire protocol).
export interface BridgeTurn {
  role: "user" | "assistant";
  text: string;
}

// The bridge only needs these four things from the live Realtime leg; the WebRTC
// plumbing stays private to this module.
export interface RealtimeLeg {
  /** Ordered user/assistant turns gathered so far. */
  transcript(): BridgeTurn[];
  /** True once the assistant has actually produced spoken output. */
  hasSpoken(): boolean;
  /** True when neither side is mid-utterance, so a handover won't clip audio. */
  atSafeBoundary(): boolean;
  /** Tear down the peer connection + data channel. Never stops the shared mic. */
  close(): void;
}

export type RealtimeActivity =
  | "listening"
  | "user_talking"
  | "thinking"
  | "buddy_talking";

export interface StartRealtimeLegOptions {
  micTrack: MediaStreamTrack;
  audioEl: HTMLAudioElement;
  signal: AbortSignal;
  mode?: "standard" | "guide" | "onboarding";
  onActivity?: (activity: RealtimeActivity) => void;
  onRemoteAudioTrack?: (track: MediaStreamTrack | null) => void;
}

// OpenAI's Realtime WebRTC entry point. The ephemeral secret (ek_...) authorizes
// this single SDP exchange; the real key never reaches the client.
const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

interface RealtimeSessionSecret {
  client_secret: string;
  model: string;
  voice: string;
  expires_at: number;
}

/**
 * Opens an OpenAI Realtime speech-to-speech leg over WebRTC. Resolves once the
 * data channel is open (events flowing), or rejects/aborts fast so useVoiceBar's
 * 2.5s race can fall back to the cold LiveKit path. The shared mic is added to the
 * peer connection here and re-published onto LiveKit at handover, so it is never
 * stopped by close().
 */
// TEMP (diagnostic): incrementing id so a single hotkey press that accidentally
// spawns more than one leg is obvious in the logs. Remove with the timing logs.
let realtimeLegSeq = 0;

export async function startRealtimeLeg(opts: StartRealtimeLegOptions): Promise<RealtimeLeg> {
  const { micTrack, audioEl, signal, mode = "standard", onActivity, onRemoteAudioTrack } = opts;

  // TEMP (diagnostic): TTFT clock + per-invocation id.
  const legId = ++realtimeLegSeq;
  const t0 = performance.now();
  const since = () => `${Math.round(performance.now() - t0)}ms`;
  logInfo("realtime: leg start", `legId=${legId}`);

  // 1. Mint an ephemeral secret server-side (OPENAI_API_KEY stays on the backend).
  const modeParam = mode === "standard" ? "" : `?mode=${mode}`;
  logInfo("realtime: mint requested", `POST /realtime/session${modeParam}`);
  const res = await authFetch(`/realtime/session${modeParam}`, { method: "POST", signal });
  logInfo("realtime: mint response", `legId=${legId} status=${res.status} mintMs=${since()}`);
  if (!res.ok) {
    // 503 = bridge disabled or mint failed; caller falls back to the cold path.
    throw new Error(`realtime session mint failed (${res.status})`);
  }
  const session = (await res.json()) as Partial<RealtimeSessionSecret>;
  if (!session.client_secret || !session.model) {
    throw new Error("realtime session response missing client_secret/model");
  }

  const pc = new RTCPeerConnection();
  let closed = false;
  const onAbort = () => close();

  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    try {
      pc.close();
    } catch (err) {
      logError("realtime: pc.close", err);
    }
    // Deliberately never micTrack.stop() here: after handover LiveKit owns it.
    try {
      audioEl.srcObject = null;
    } catch {
      /* ignore */
    }
    onRemoteAudioTrack?.(null);
  };

  const turns: BridgeTurn[] = [];
  let assistantSpoke = false;
  let userSpeaking = false;
  let assistantResponding = false;
  let firstAudioLogged = false; // TEMP (diagnostic): stamp true TTFT once.

  pc.ontrack = (event) => {
    audioEl.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    onRemoteAudioTrack?.(event.track);
    void audioEl.play().catch((err) => logError("realtime: audioEl.play", err));
  };

  pc.addTrack(micTrack);

  // Surface the WebRTC handshake so a stalled connect (ICE/DTLS never completing,
  // the classic silent hang) is visible instead of just timing out upstream.
  pc.onconnectionstatechange = () => logInfo("realtime: pc state", pc.connectionState);
  pc.oniceconnectionstatechange = () => logInfo("realtime: ice state", pc.iceConnectionState);

  const dc = pc.createDataChannel("oai-events");
  dc.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as { type?: string; transcript?: string };
      switch (msg.type) {
        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript?.trim()) turns.push({ role: "user", text: msg.transcript.trim() });
          break;
        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done":
          if (msg.transcript?.trim()) {
            turns.push({ role: "assistant", text: msg.transcript.trim() });
            assistantSpoke = true;
          }
          break;
        case "input_audio_buffer.speech_started":
          userSpeaking = true;
          onActivity?.("user_talking");
          break;
        case "input_audio_buffer.speech_stopped":
          userSpeaking = false;
          onActivity?.("thinking");
          break;
        case "response.created":
          assistantResponding = true;
          onActivity?.("thinking");
          break;
        // TEMP (diagnostic): first audio chunk from the model = true TTFT.
        case "response.audio.delta":
        case "response.output_audio.delta":
          onActivity?.("buddy_talking");
          if (!firstAudioLogged) {
            firstAudioLogged = true;
            logInfo("realtime: TTFT", `legId=${legId} firstAudioMs=${since()}`);
          }
          break;
        case "response.done":
          assistantResponding = false;
          onActivity?.("listening");
          break;
        default:
          break;
      }
    } catch (err) {
      logError("realtime: dc.onmessage", err);
    }
  };

  // 2. SDP offer -> OpenAI -> answer. Per the official WebRTC guide the model is
  // baked into the ephemeral token (server-side), so it is NOT a query param here.
  // tauriFetch (native HTTP) avoids webview CORS on the cross-origin OpenAI call.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  logInfo("realtime: posting SDP offer", `${OPENAI_REALTIME_CALLS_URL} at=${since()}`);
  const sdpResponse = await tauriFetch(OPENAI_REALTIME_CALLS_URL, {
    method: "POST",
    body: offer.sdp ?? "",
    headers: {
      Authorization: `Bearer ${session.client_secret}`,
      "Content-Type": "application/sdp",
    },
    signal,
  });
  logInfo("realtime: SDP answer", `legId=${legId} status=${sdpResponse.status} sdpMs=${since()}`);
  if (!sdpResponse.ok) {
    close();
    throw new Error(`realtime SDP exchange failed (${sdpResponse.status})`);
  }
  const answerSdp = await sdpResponse.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  logInfo("realtime: remote description set", "waiting for data channel open");

  // 3. Ready once the data channel opens.
  await new Promise<void>((resolve, reject) => {
    if (dc.readyState === "open") {
      resolve();
      return;
    }
    const cleanup = () => {
      dc.removeEventListener("open", onOpen);
      dc.removeEventListener("error", onError);
      pc.removeEventListener("connectionstatechange", onConnFail);
      signal.removeEventListener("abort", onStartAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      close();
      reject(new Error("realtime data channel error"));
    };
    const onConnFail = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        close();
        reject(new Error(`realtime peer connection ${pc.connectionState}`));
      }
    };
    const onStartAbort = () => {
      cleanup();
      close();
      reject(new Error("realtime start aborted"));
    };
    dc.addEventListener("open", onOpen);
    dc.addEventListener("error", onError);
    pc.addEventListener("connectionstatechange", onConnFail);
    signal.addEventListener("abort", onStartAbort);
  });

  signal.addEventListener("abort", onAbort);
  onActivity?.("listening");
  logInfo(
    "realtime: leg connected",
    `legId=${legId} model=${session.model} voice=${session.voice ?? ""} connectMs=${since()}`,
  );

  return {
    transcript: () => turns.slice(),
    hasSpoken: () => assistantSpoke,
    atSafeBoundary: () => !userSpeaking && !assistantResponding,
    close,
  };
}
