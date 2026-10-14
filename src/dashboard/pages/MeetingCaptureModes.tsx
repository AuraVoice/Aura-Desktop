import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { LoaderCircle, Upload, Users } from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import { CAPTURE_IN_PERSON_REQUESTED } from "../../lib/ipcEvents";
import { logError } from "../../lib/log";
import { meetingCaptureModeCopy as copy } from "../../lib/meetingCopy";
import { claimMeeting, MeetingCapError } from "../../lib/meetings";

interface ImportProbe {
  token: string;
  durationMs: number;
  segmentCount: number;
}

interface RuntimeStatus {
  ownsRuntime: boolean;
  installationId: string;
  runtimeInstanceId: string;
}

type ImportPhase = "idle" | "preparing" | "confirm" | "claiming" | "queued" | "error";

/** Any audio a phone, recorder or browser saves; Rust decides what it can read. */
const AUDIO_ACCEPT = "audio/*,.m4a,.mp3,.wav,.ogg,.oga,.flac,.webm,.mp4";
/** Same window as a tray capture's manual claim (useMeetingCapture). */
const MANUAL_WINDOW_MS = 2 * 60 * 60_000;

function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * The Meetings page's two ways to make a note without a call. The page owns
 * one instance and renders its two halves apart: the buttons live in the
 * toolbar, the status strip sits under it.
 *
 *   Record in person - asks the overlay (which owns capture) for a
 *   microphone-only recording, the same path as the tray item.
 *
 *   Upload recording - Rust decodes the file first (meeting_prepare_import),
 *   so an unreadable or too-long file is refused before anything is claimed;
 *   only Transcribe claims the meeting, and meeting_commit_import queues the
 *   audio for the same upload pump a live capture uses.
 */
export function useMeetingCaptureModes(onQueued: () => void) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<{ probe: ImportProbe; name: string } | null>(null);

  const discard = (probe: ImportProbe | undefined) => {
    if (probe) void invoke("meeting_discard_import", { token: probe.token }).catch(() => undefined);
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setPhase("preparing");
    setMessage("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const probe = await invoke<ImportProbe>("meeting_prepare_import", bytes, {
        headers: { "x-file-name": file.name },
      });
      setPending({ probe, name: file.name.replace(/\.[^.]+$/, "") || "Recording" });
      setPhase("confirm");
    } catch (err) {
      logError("MeetingCaptureModes: prepare import", err);
      const code = typeof err === "string" ? err : "";
      setMessage(copy.refusal[code] ?? copy.failed);
      setPhase("error");
    }
  };

  const transcribe = async () => {
    if (!pending) return;
    setPhase("claiming");
    try {
      const status = await invoke<RuntimeStatus>("meeting_runtime_status");
      if (!status.ownsRuntime) throw new Error("meeting runtime not owned by this process");
      const now = new Date();
      const eventId = `manual:${crypto.randomUUID()}`;
      const claim = await claimMeeting({
        eventId,
        title: pending.name,
        startTime: now.toISOString(),
        endTime: new Date(now.getTime() + MANUAL_WINDOW_MS).toISOString(),
        installationId: status.installationId,
        runtimeInstanceId: status.runtimeInstanceId,
        kind: "auto",
        source: "upload",
      });
      await invoke("meeting_commit_import", {
        token: pending.probe.token,
        meetingId: claim.meetingId,
        captureRunId: claim.captureRunId,
        captureFence: claim.captureFence,
        eventId,
      });
      trackEvent("meeting_uploaded", { minutes: Math.round(pending.probe.durationMs / 60_000) });
      setPending(null);
      setMessage(copy.queued);
      setPhase("queued");
      onQueued();
    } catch (err) {
      logError("MeetingCaptureModes: claim or commit import", err);
      discard(pending.probe);
      setPending(null);
      const code = typeof err === "string" ? err : "";
      setMessage(err instanceof MeetingCapError ? copy.capReached : copy.refusal[code] ?? copy.failed);
      setPhase("error");
    }
  };

  const cancel = () => {
    discard(pending?.probe);
    setPending(null);
    setPhase("idle");
  };

  return { inputRef, phase, message, pending, choose, transcribe, cancel };
}

type CaptureModes = ReturnType<typeof useMeetingCaptureModes>;

export function MeetingCaptureButtons({ modes }: { modes: CaptureModes }) {
  const { inputRef, phase, choose } = modes;
  return (
    <div className="db-meeting-capture-modes">
      <button
        type="button"
        className="db-secondary-btn"
        onClick={() => {
          trackEvent("meeting_in_person_requested", {});
          void emitTo("main", CAPTURE_IN_PERSON_REQUESTED).catch((err) =>
            logError("MeetingCaptureModes: record in person", err),
          );
        }}
      >
        <Users size={15} />
        {copy.inPerson}
      </button>
      <button
        type="button"
        className="db-secondary-btn"
        disabled={phase === "preparing" || phase === "claiming"}
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={15} />
        {copy.upload}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={AUDIO_ACCEPT}
        hidden
        onChange={(event) => {
          void choose(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );
}

export function MeetingCaptureStatus({ modes }: { modes: CaptureModes }) {
  const { phase, message, pending, transcribe, cancel } = modes;
  if (phase === "preparing") {
    return (
      <p className="db-meeting-action-status" role="status">
        <LoaderCircle size={15} className="db-meeting-spin" />
        {copy.preparing}
      </p>
    );
  }
  if ((phase === "confirm" || phase === "claiming") && pending) {
    return (
      <div className="db-meeting-action-status" role="alert">
        <span>{copy.confirm(pending.name, durationLabel(pending.probe.durationMs))}</span>
        <button type="button" className="db-secondary-btn" disabled={phase === "claiming"} onClick={cancel}>
          {copy.cancel}
        </button>
        <button
          type="button"
          className="db-primary-btn"
          disabled={phase === "claiming"}
          onClick={() => void transcribe()}
        >
          {copy.transcribe}
        </button>
      </div>
    );
  }
  if ((phase === "queued" || phase === "error") && message) {
    return (
      <p className={`db-meeting-action-status${phase === "error" ? " is-error" : ""}`} role="status">
        {message}
      </p>
    );
  }
  return null;
}
