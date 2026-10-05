import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { GlassSurface } from "../GlassSurface";
import { BarIconButton } from "../BarIconButton";
import { CloseIcon, DocumentIcon } from "../icons";
import { setOverlayDialogFriendly } from "../overlayDialog";
import { DOCUMENT_ACCEPT, extractDocument } from "../../lib/documentText";
import { extractResumeText, RESUME_ACCEPT, resumeStats } from "../../lib/resumeText";
import { loadInterviewResume } from "../../lib/interviewResumeMemory";
import { logError } from "../../lib/log";
import {
  CONTEXT_FIELD_MAX_CHARS,
  overLimitPart,
  type ContextPart,
  type InterviewContextParts,
} from "./interviewContext";
import type { InterviewContextState } from "./useInterviewContext";
import "./InterviewContextCard.css";

export const INITIAL_INTERVIEW_CONTEXT_SLOT_HEIGHT = 420;
// Three sections and a few file chips fit without scrolling; past this the card
// scrolls inside itself instead of growing the window off the screen.
const MAX_INTERVIEW_CONTEXT_SLOT_HEIGHT = 560;

/** One attached file's text. Never the file itself: that stays on this machine. */
interface AttachedText {
  id: number;
  part: ContextPart;
  name: string;
  text: string;
}

const PART_LABEL: Record<ContextPart, string> = {
  jobDescription: "Job description",
  resume: "Resume",
  notes: "Notes",
};

function words(text: string): number {
  return resumeStats(text).words;
}

/**
 * The Interview Mode context card, rendered by OverlayRoot below the bar.
 *
 * One job: collect whatever the user wants the mock interview built from (a job
 * description, their resume, notes) and hand it to the hook. Files are read
 * into text right here, on this machine; the card never stores, previews back,
 * or uploads a file, and everything is dropped the moment it is sent.
 *
 * `confirmDisplayed` fires from a layout effect, after this has actually
 * rendered and only while the card is visible. That is the difference between
 * telling the worker "the card is on their screen" and telling it "a packet
 * arrived", and the worker speaks a line to the user off the back of it.
 */
export function InterviewContextCard({
  card,
  onHeightChange,
  visible = false,
}: {
  card: InterviewContextState;
  onHeightChange?: (height: number) => void;
  visible?: boolean;
}) {
  const { phase, errorReason, submit, dismiss } = card;
  const confirmDisplayed = card.confirmDisplayed;
  const innerRef = useRef<HTMLDivElement>(null);
  const jobRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickingFor = useRef<ContextPart>("jobDescription");
  const nextId = useRef(1);

  const [jobDescription, setJobDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<AttachedText[]>([]);
  // The Companion's saved resume, offered as a removable chip. Read once per
  // card; the user can take it off or replace it with a file.
  const [savedResume, setSavedResume] = useState<string | null>(null);
  const [useSavedResume, setUseSavedResume] = useState(true);
  const [reading, setReading] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ContextPart | null>(null);

  const editable = phase === "open" || phase === "error";

  // The text is the voice session's, not this component's: drop it the moment
  // it is no longer being filled in.
  useEffect(() => {
    if (phase !== "idle" && phase !== "sent") return;
    setJobDescription("");
    setNotes("");
    setFiles([]);
    setFileError(null);
    setUseSavedResume(true);
  }, [phase]);

  useEffect(() => {
    if (phase !== "open") return;
    let active = true;
    loadInterviewResume()
      .then((stored) => {
        if (active) setSavedResume(stored);
      })
      .catch((err) => logError("InterviewContextCard: saved resume", err));
    return () => {
      active = false;
    };
  }, [phase]);

  const resumeFile = files.find((file) => file.part === "resume") ?? null;
  const resumeText = resumeFile?.text ?? (useSavedResume && savedResume ? savedResume : "");

  const compose = useCallback((part: "jobDescription" | "notes", typed: string) => {
    return [typed.trim(), ...files.filter((file) => file.part === part).map((file) => file.text)]
      .filter(Boolean)
      .join("\n\n");
  }, [files]);

  const parts: InterviewContextParts = {
    jobDescription: compose("jobDescription", jobDescription),
    resume: resumeText,
    notes: compose("notes", notes),
  };
  const overLimit = overLimitPart(parts);
  const hasAnything = Boolean(parts.jobDescription || parts.resume || parts.notes);
  const canSend = editable && hasAnything && !overLimit && reading === 0;

  const measureHeight = useCallback(() => {
    const inner = innerRef.current;
    if (!inner || !onHeightChange) return;
    // scrollHeight, not the box: once capped, the box is the slot's height and
    // measuring it would only ever report the cap back.
    onHeightChange(Math.min(inner.scrollHeight, MAX_INTERVIEW_CONTEXT_SLOT_HEIGHT));
  }, [onHeightChange]);

  useLayoutEffect(() => {
    measureHeight();
    if (visible && phase === "open") confirmDisplayed();
  });

  // A card the user has to click into first is a card they will paste past. The
  // worker has just told them out loud that it is there.
  useEffect(() => {
    if (phase === "open") jobRef.current?.focus();
  }, [phase]);

  const readFiles = useCallback(async (part: ContextPart, picked: File[]) => {
    if (picked.length === 0) return;
    setFileError(null);
    setReading((count) => count + picked.length);
    for (const file of picked) {
      try {
        const text = part === "resume"
          ? await extractResumeText(file)
          : (await extractDocument(file)).pages.join("\n\n").trim();
        const attached: AttachedText = { id: nextId.current++, part, name: file.name, text };
        // One resume at a time: a new one replaces the last, it is not appended.
        setFiles((current) => [
          ...current.filter((item) => part !== "resume" || item.part !== "resume"),
          attached,
        ]);
      } catch (err) {
        setFileError(err instanceof Error ? err.message : `Aura couldn't read ${file.name}.`);
      } finally {
        setReading((count) => count - 1);
      }
      if (part === "resume") break;
    }
  }, []);

  // The native picker is an ordinary window; the overlay has to stop being
  // topmost for it to be reachable (see overlayDialog.ts).
  const openPicker = useCallback((part: ContextPart) => {
    const input = fileInputRef.current;
    if (!input) return;
    pickingFor.current = part;
    input.accept = part === "resume" ? RESUME_ACCEPT : DOCUMENT_ACCEPT;
    input.multiple = part !== "resume";
    setOverlayDialogFriendly(true);
    input.click();
  }, []);

  // A cancelled picker fires no change event, so the overlay would otherwise
  // stay non-topmost behind whatever the user clicks next.
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const restore = () => setOverlayDialogFriendly(false);
    input.addEventListener("cancel", restore);
    return () => input.removeEventListener("cancel", restore);
  }, []);

  const onPicked = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    // Cleared immediately so re-picking the same file fires onChange again.
    event.target.value = "";
    setOverlayDialogFriendly(false);
    void readFiles(pickingFor.current, picked);
  }, [readFiles]);

  const dropHandlers = (part: ContextPart) => ({
    onDragOver: (event: DragEvent) => {
      if (!editable || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDropTarget(part);
    },
    onDragLeave: () => setDropTarget((current) => (current === part ? null : current)),
    onDrop: (event: DragEvent) => {
      if (!editable) return;
      event.preventDefault();
      setDropTarget(null);
      void readFiles(part, Array.from(event.dataTransfer.files));
    },
  });

  const removeFile = (id: number) => setFiles((current) => current.filter((file) => file.id !== id));

  const send = () => {
    if (canSend) submit(parts);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter alone inserts a newline: a pasted posting is multi-line, and
    // stealing Enter would send it half-typed.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };

  const chips = (part: ContextPart) =>
    files
      .filter((file) => file.part === part)
      .map((file) => (
        <span key={file.id} className="interview-context-chip">
          <DocumentIcon />
          <span className="interview-context-chip-name">{file.name}</span>
          <span className="interview-context-chip-meta">{words(file.text)} words</span>
          <button
            type="button"
            className="interview-context-chip-remove"
            aria-label={`Remove ${file.name}`}
            onClick={() => removeFile(file.id)}
            disabled={!editable}
          >
            <CloseIcon />
          </button>
        </span>
      ));

  const hint = errorReason
    ? "That didn't send. Try again, or just tell me about the role."
    : fileError
      ? fileError
      : overLimit
        ? `${PART_LABEL[overLimit]} is longer than I can take (${CONTEXT_FIELD_MAX_CHARS[overLimit].toLocaleString()} characters). Trim it to the main part.`
        : reading > 0
          ? "Reading your file..."
          : phase === "sending"
            ? "Sending..."
            : "Nothing is saved. It stays in this call.";
  const hintIsError = Boolean(errorReason || fileError || overLimit);

  return (
    <GlassSurface className="interview-context-card" draggable={false}>
      <div className="interview-context-inner" ref={innerRef}>
        <div className="interview-context-header">
          <span className="interview-context-title">What should the interview use?</span>
          <BarIconButton title="Close" onClick={dismiss} disabled={phase === "sending"}>
            <CloseIcon />
          </BarIconButton>
        </div>

        <input ref={fileInputRef} type="file" hidden onChange={onPicked} />

        <section
          className={`interview-context-section${dropTarget === "jobDescription" ? " is-drop" : ""}`}
          {...dropHandlers("jobDescription")}
        >
          <div className="interview-context-label-row">
            <span className="interview-context-label">Job description</span>
            <button
              type="button"
              className="interview-context-add"
              onClick={() => openPicker("jobDescription")}
              disabled={!editable}
            >
              Add file
            </button>
          </div>
          <textarea
            ref={jobRef}
            className="interview-context-input"
            value={jobDescription}
            onChange={(event) => setJobDescription(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Paste the posting, or drop a PDF or Word file here."
            spellCheck={false}
            disabled={!editable}
          />
          {chips("jobDescription")}
        </section>

        <section
          className={`interview-context-section${dropTarget === "resume" ? " is-drop" : ""}`}
          {...dropHandlers("resume")}
        >
          <div className="interview-context-label-row">
            <span className="interview-context-label">Resume</span>
            <button
              type="button"
              className="interview-context-add"
              onClick={() => openPicker("resume")}
              disabled={!editable}
            >
              {resumeText ? "Replace" : "Add resume"}
            </button>
          </div>
          {resumeFile ? (
            chips("resume")
          ) : useSavedResume && savedResume ? (
            <span className="interview-context-chip">
              <DocumentIcon />
              <span className="interview-context-chip-name">Your saved resume</span>
              <span className="interview-context-chip-meta">{words(savedResume)} words</span>
              <button
                type="button"
                className="interview-context-chip-remove"
                aria-label="Don't use the saved resume"
                onClick={() => setUseSavedResume(false)}
                disabled={!editable}
              >
                <CloseIcon />
              </button>
            </span>
          ) : (
            <span className="interview-context-empty">
              Drop a PDF or Word resume here so I can ask about your own projects.
            </span>
          )}
        </section>

        <section
          className={`interview-context-section${dropTarget === "notes" ? " is-drop" : ""}`}
          {...dropHandlers("notes")}
        >
          <div className="interview-context-label-row">
            <span className="interview-context-label">Notes</span>
            <button
              type="button"
              className="interview-context-add"
              onClick={() => openPicker("notes")}
              disabled={!editable}
            >
              Add file
            </button>
          </div>
          <textarea
            className="interview-context-input interview-context-input-short"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Recruiter email, topics to drill, feedback from an earlier round."
            spellCheck={false}
            disabled={!editable}
          />
          {chips("notes")}
        </section>

        <div className="interview-context-footer">
          <span className={`interview-context-hint${hintIsError ? " interview-context-hint-error" : ""}`}>
            {hint}
          </span>
          <button
            type="button"
            className="interview-context-send"
            onClick={send}
            disabled={!canSend}
          >
            {phase === "sending" ? "Sending" : "Use this"}
          </button>
        </div>
      </div>
    </GlassSurface>
  );
}
