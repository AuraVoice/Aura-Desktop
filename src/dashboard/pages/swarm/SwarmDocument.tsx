import { useCallback, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Download, FileText, FolderOpen, Lock, PenLine } from "lucide-react";
import { DetailModal } from "../../components/DetailModal";
import { useOutsideClick } from "../../components/useOutsideClick";
import { saveDocumentDraft, type DocumentFormat } from "../../../lib/swarmDocumentFile";
import { openSavedFile, savedFileName, savedFolderName } from "../../../lib/savedFiles";

/** A document a manager wrote (a prep guide, a revised resume, a cover letter), shown the
 * way an artifact is: one card with its name, a save button and Open. Open reads it as a
 * real page, headings and lists rendered, where it can also be edited before saving. It is
 * saved only on this computer, never sent anywhere, so there is no approval step. */

const SAVE_FORMATS: DocumentFormat[] = ["docx", "pdf", "txt"];
const FORMAT_DETAIL: Record<DocumentFormat, string> = {
  docx: "Word document",
  pdf: "PDF",
  txt: "Plain text",
};

// Module scope, as in SwarmMarkdown: a fresh array each render rebuilds the processor.
const REMARK_PLUGINS = [remarkGfm];
const ALLOWED = [
  "p", "ul", "ol", "li", "strong", "em", "code", "pre", "blockquote", "a", "br", "del", "hr",
  "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td",
];

/** "Vivint-Audio-Panel-Prep-Guide" reads as a file stem; a person would write it with spaces. */
function displayTitle(raw: string): string {
  const title = raw.trim() || "Aura document";
  return /\s/.test(title) ? title : title.replace(/[-_]+/g, " ").trim();
}

/** The save choices, as an icon button with a small menu: the format the manager suggested first. */
function SaveMenu({
  formats,
  busy,
  disabled,
  onSave,
  className = "",
}: {
  formats: DocumentFormat[];
  busy: DocumentFormat | "";
  disabled: boolean;
  onSave: (format: DocumentFormat) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useOutsideClick(menuRef, () => setOpen(false), open, triggerRef);
  return (
    <div className={`db-doc-save ${className}`.trim()} ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="db-doc-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={busy ? "Saving" : "Save as"}
        title={busy ? "Saving" : "Save as"}
        disabled={disabled || busy !== ""}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <span className="db-doc-spinner" aria-hidden="true" /> : <Download aria-hidden="true" />}
      </button>
      {open && (
        <div className="db-doc-menu" role="menu" aria-label="Save as">
          {formats.map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              className="db-doc-menu-row"
              onClick={() => {
                setOpen(false);
                onSave(format);
              }}
            >
              <span>{FORMAT_DETAIL[format]}</span>
              <span className="db-doc-menu-ext">.{format}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentArtifact({ draft, onOpenLink }: { draft: Record<string, unknown>; onOpenLink: (url: string) => void }) {
  const rawTitle = typeof draft.title === "string" ? draft.title : "";
  const suggested = typeof draft.format === "string" && (SAVE_FORMATS as string[]).includes(draft.format) ? (draft.format as DocumentFormat) : "docx";
  const formats = [suggested, ...SAVE_FORMATS.filter((f) => f !== suggested)];
  const title = displayTitle(rawTitle);
  const [text, setText] = useState(typeof draft.body === "string" ? draft.body : "");
  const [viewing, setViewing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<DocumentFormat | "">("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  const save = async (format: DocumentFormat) => {
    setBusy(format);
    setError("");
    try {
      // A cancelled Save As keeps whatever was saved before, and says nothing.
      const path = await saveDocumentDraft(title, text, format);
      if (path) setSaved(path);
    } catch (err) {
      setError(typeof err === "string" ? err : "Aura couldn't save that file. Try again in a moment.");
    } finally {
      setBusy("");
    }
  };

  const reveal = () =>
    void openSavedFile(saved, true).catch(() => setError(`Aura couldn't show it. Find it in ${savedFolderName(saved)}.`));

  const components: Components = {
    a: ({ href, children }) =>
      href && /^https?:/i.test(href) ? (
        <button type="button" className="db-doc-link" title={href} onClick={() => onOpenLink(href)}>
          {children}
        </button>
      ) : (
        <>{children}</>
      ),
  };

  // Stable on purpose: DetailModal re-runs its focus effect whenever onClose changes, and a
  // fresh function each render pulled focus off the editor after the first keystroke.
  const close = useCallback(() => {
    setViewing(false);
    setEditing(false);
  }, []);

  return (
    <>
      <div className="db-swarm-artifact">
        <button type="button" className="db-swarm-artifact-main" onClick={() => setViewing(true)} aria-label={`Open ${title}`}>
          <span className="db-swarm-artifact-tile" aria-hidden="true">
            <FileText />
          </span>
          <span className="db-swarm-artifact-text">
            <strong>{title}</strong>
            <span className="db-swarm-artifact-meta">
              {saved ? (
                <>
                  <Check aria-hidden="true" /> Saved as {savedFileName(saved)}
                </>
              ) : (
                <>
                  Document <span aria-hidden="true">·</span> <Lock aria-hidden="true" /> Only on this computer
                </>
              )}
            </span>
          </span>
        </button>
        <div className="db-swarm-artifact-actions">
          {saved && (
            <button type="button" className="db-doc-icon-btn" onClick={reveal} aria-label="Show in folder" title="Show in folder">
              <FolderOpen aria-hidden="true" />
            </button>
          )}
          <SaveMenu formats={formats} busy={busy} disabled={!text.trim()} onSave={(f) => void save(f)} />
          <button type="button" className="db-doc-open" onClick={() => setViewing(true)}>
            Open
          </button>
        </div>
      </div>
      {error && <p className="db-swarm-artifact-error" role="alert">{error}</p>}

      <DetailModal
        open={viewing}
        title={title}
        onClose={close}
        panelClassName="db-doc-viewer"
        headerAction={
          <>
            <button
              type="button"
              className={`db-doc-icon-btn${editing ? " is-on" : ""}`}
              aria-pressed={editing}
              aria-label={editing ? "Done editing" : "Edit"}
              title={editing ? "Done editing" : "Edit"}
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? <Check aria-hidden="true" /> : <PenLine aria-hidden="true" />}
            </button>
            <SaveMenu formats={formats} busy={busy} disabled={!text.trim()} onSave={(f) => void save(f)} className="is-end" />
          </>
        }
      >
        {editing ? (
          <textarea
            className="db-doc-edit"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={`Edit ${title}`}
            spellCheck
            autoFocus
          />
        ) : (
          <article className="db-doc-page">
            <Markdown remarkPlugins={REMARK_PLUGINS} skipHtml allowedElements={ALLOWED} unwrapDisallowed components={components}>
              {text}
            </Markdown>
          </article>
        )}
        {(saved || error) && (
          <p className={`db-doc-foot${error ? " is-error" : ""}`}>
            {error || (
              <>
                Saved as {savedFileName(saved)}.{" "}
                <button type="button" className="db-doc-link" onClick={reveal}>Show in folder</button>
              </>
            )}
          </p>
        )}
      </DetailModal>
    </>
  );
}
