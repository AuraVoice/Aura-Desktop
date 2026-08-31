import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  ClipboardPaste,
  Download,
  FileText,
  History,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import {
  candidateBriefClaims,
  preparationSources,
  withCandidateVerification,
  type CompanyResearchCategory,
  type CompanyResearchResult,
  type InterviewAnswerLength,
  type InterviewBrief,
  type InterviewBriefClaim,
  type InterviewBriefSource,
  type InterviewPreparationInput,
} from "../../lib/interviewBrief";
import {
  DEFAULT_PLANNED_MINUTES,
  DEFAULT_ROUND_KIND,
  PLANNED_MINUTES_OPTIONS,
  ROUND_KIND_OPTIONS,
} from "../../lib/interviewPolicy";
import {
  buildInterviewBrief,
  streamInterviewCompanyResearch,
  type CompanyResearchProgress,
} from "../../lib/interviewHackerApi";
import { DetailModal } from "../components/DetailModal";
import { SegmentedChoice } from "../components/SegmentedChoice";
import { SiteIcon } from "../components/SiteIcon";
import {
  RESUME_ACCEPT,
  RESUME_MAX_CHARS,
  ResumeExtractionError,
  extractResumeText,
  resumeStats,
} from "../../lib/resumeText";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { clearInterviewBrief, loadInterviewBrief, storeInterviewBrief } from "../../lib/interviewBriefMemory";
import {
  loadInterviewWorkspace,
  saveInterviewWorkspace,
  type InterviewWorkspace,
  type InterviewWorkspaceRecord,
} from "../../lib/interviewWorkspace";
import {
  listInterviewSessions,
  loadInterviewSession,
  deleteInterviewSession,
  clearInterviewSessions,
  type InterviewSessionSummary,
  type InterviewSessionDetail,
  type StoredReflection,
} from "../../lib/interviewSessions";
import { logError } from "../../lib/log";
import { shortDateTime } from "../format";
import { useAuth } from "../../state/AuthProvider";
import "./InterviewPage.css";

const EMPTY_INPUT: InterviewPreparationInput = {
  company: "",
  companyUrl: "",
  role: "",
  resume: "",
  jobDescription: "",
  candidateFacts: "",
  starStories: "",
  metrics: "",
  gaps: "",
  doNotClaim: "",
  answerLength: "balanced",
};

type InterviewPageTab = "current" | "preparation" | "sessions";
type InterviewTabTransition = "idle" | "exiting" | "entering";

const UPDATED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function createInterviewRecord(): InterviewWorkspaceRecord {
  const now = Date.now();
  return {
    interviewId: `interview-${crypto.randomUUID()}`,
    createdAtMs: now,
    updatedAtMs: now,
    input: { ...EMPTY_INPUT },
    research: null,
    draftBrief: null,
  };
}

function createInterviewWorkspace(): InterviewWorkspace {
  const interview = createInterviewRecord();
  return {
    interviews: [interview],
    currentInterviewId: interview.interviewId,
    activeInterviewId: null,
    activeBrief: null,
  };
}

function hasInterviewContent(interview: InterviewWorkspaceRecord): boolean {
  const { answerLength: _answerLength, ...textInput } = interview.input;
  return Object.values(textInput).some((value) => value.trim().length > 0)
    || interview.research !== null
    || interview.draftBrief !== null;
}

function interviewStatus(interview: InterviewWorkspaceRecord, activeInterviewId: string | null): string {
  if (interview.interviewId === activeInterviewId) return "Active";
  if (interview.draftBrief?.reviewedAtMs != null) return "Reviewed";
  if (interview.draftBrief) return "Review needed";
  if (interview.research) return "Research complete";
  return "Draft";
}

const CATEGORY_LABELS: Record<CompanyResearchCategory, string> = {
  background: "Background",
  products_and_business: "Products and business",
  funding_and_financials: "Funding and financials",
  company_size: "Company size",
  leadership_and_team: "Leadership and team",
  recent_updates: "Recent posts and updates",
  vision_and_strategy: "Long-term vision",
  technology_and_ai: "Technology and AI",
  role_relevance: "Why this role matters",
};

/** The four fields company research actually consumes. Used to decide whether
 * a finished dossier still matches what the user is looking at. */
function targetSignature(input: InterviewPreparationInput): string {
  return [
    input.company.trim(),
    input.companyUrl.trim(),
    input.role.trim(),
    input.jobDescription.trim(),
  ].join("\u0000");
}

const ANSWER_LENGTH_OPTIONS: Array<{ value: InterviewAnswerLength; label: string; hint: string }> = [
  // Hints mirror the backend's own length instructions so the control never
  // promises something the answer generator will not do.
  { value: "brief", label: "Brief", hint: "1 to 2 sentences" },
  { value: "balanced", label: "Balanced", hint: "2 to 4 sentences" },
  { value: "detailed", label: "Detailed", hint: "4 to 6 sentences" },
];

/** The three-phase rail across the top of the builder. Phase 1 previously had
 * no label at all while phase 2 did, so there was no sense of where you were. */
function InterviewSteps({
  company,
  hasResearch,
  hasResume,
  claimCount,
  hasBrief,
}: {
  company: string;
  hasResearch: boolean;
  hasResume: boolean;
  claimCount: number;
  hasBrief: boolean;
}) {
  const steps = [
    {
      label: "Target",
      detail: company.trim() || "Add a company",
      state: hasResearch ? "done" : "active",
    },
    {
      label: "Evidence",
      detail: hasResume ? "Resume added" : "Optional context",
      state: !hasResearch ? "pending" : hasBrief ? "done" : "active",
    },
    {
      label: "Review",
      detail: hasBrief ? `${claimCount} ${claimCount === 1 ? "claim" : "claims"}` : "Confirm claims",
      state: hasBrief ? "active" : "pending",
    },
  ];
  return (
    <ol className="db-interview-steps">
      {steps.map((step, index) => (
        <li key={step.label} className={`is-${step.state}`}>
          <span className="db-interview-step-index" aria-hidden>{index + 1}</span>
          <span className="db-interview-step-copy">
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Field({
  label,
  optional = true,
  value,
  onChange,
  placeholder,
  multiline = false,
}: {
  label: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
}) {
  return (
    <label className="db-interview-field">
      <span>{label}{optional && <small>Optional</small>}</span>
      {multiline ? (
        <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      )}
    </label>
  );
}

/** Host without the www prefix, e.g. "rivian.com". Falls back to the raw value
 * so a malformed URL still renders something a person can recognise. */
function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url;
  }
}

function SourceChip({ url, title }: { url: string; title?: string }) {
  const host = sourceHost(url);
  return (
    <button
      type="button"
      className="db-interview-source-chip"
      title={title ? `${title} - ${url}` : url}
      onClick={() => void openUrl(url).catch((err) => logError("InterviewPage: open source", err))}
    >
      <SiteIcon host={host} size={18} />
      <span className="db-interview-source-host">{host}</span>
      <ArrowUpRight size={13} aria-hidden />
    </button>
  );
}

function SourceButtons({
  sourceIds,
  sourceById,
}: {
  sourceIds: string[];
  sourceById: Map<string, { title: string; url: string }>;
}) {
  const sources = sourceIds.flatMap((sourceId) => {
    const source = sourceById.get(sourceId);
    return source ? [source] : [];
  });
  if (sources.length === 0) return null;
  return (
    <span className="db-interview-source-buttons">
      {sources.map((source, index) => (
        <SourceChip key={`${source.url}:${index}`} url={source.url} title={source.title} />
      ))}
    </span>
  );
}

function CompanyDossier({ research }: { research: CompanyResearchResult }) {
  const sourceById = useMemo(
    () => new Map(research.sources.map((source) => [
      source.sourceId,
      { title: source.title, url: source.url },
    ])),
    [research.sources],
  );
  const grouped = useMemo(() => {
    const groups = new Map<CompanyResearchCategory, typeof research.facts>();
    for (const fact of research.facts) {
      groups.set(fact.category, [...(groups.get(fact.category) ?? []), fact]);
    }
    return [...groups.entries()];
  }, [research.facts]);

  return (
    <section className="db-interview-dossier">
      <div className="db-interview-section-head">
        <div>
          <span className="db-interview-eyebrow">Company dossier</span>
          <h2>{research.company}</h2>
          <p>{research.sources.length} public sources support {research.facts.length} usable facts.</p>
        </div>
        <span className="db-interview-ready">Research complete</span>
      </div>

      <div className="db-interview-summary">
        <p>{research.executiveSummary}</p>
      </div>

      <div className="db-interview-dossier-grid">
        {grouped.map(([category, facts]) => (
          <section key={category} className="db-interview-dossier-section">
            <h3>{CATEGORY_LABELS[category]}</h3>
            {facts.map((fact) => (
              <article key={fact.factId}>
                <div className="db-interview-fact-meta">
                  <span className={`is-${fact.status}`}>{fact.status}</span>
                  {fact.asOf && <time>{fact.asOf}</time>}
                </div>
                <p>{fact.statement}</p>
                <SourceButtons sourceIds={fact.sourceIds} sourceById={sourceById} />
              </article>
            ))}
          </section>
        ))}
      </div>

      {research.likelyInterviewerQuestions.length > 0 && (
        <section className="db-interview-predictions">
          <div>
            <span className="db-interview-eyebrow">Practice</span>
            <h3>Questions they may ask</h3>
            <p>These are interviewer questions predicted from the role and company evidence.</p>
          </div>
          <ol>
            {research.likelyInterviewerQuestions.map((question) => (
              <li key={question.questionId}>
                <strong>{question.question}</strong>
                <span>{question.whyLikely}</span>
                <SourceButtons sourceIds={question.sourceIds} sourceById={sourceById} />
              </li>
            ))}
          </ol>
        </section>
      )}

      {research.unknowns.length > 0 && (
        <section className="db-interview-unknowns">
          <h3>What Aura could not establish</h3>
          {research.unknowns.map((unknown) => <p key={unknown}>{unknown}</p>)}
        </section>
      )}
    </section>
  );
}

type ResearchSearchRow = {
  callId: string;
  query: string;
  urls: string[];
  kind: "search" | "read";
  done: boolean;
};

function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Live account of the research call.
 *
 * Every row here is created by a real server-sent event. Nothing advances on a
 * timer except the elapsed clock, so a row that says a query was searched means
 * the model actually searched it. When the backend has no streaming route the
 * event list stays empty and this falls back to an honest indeterminate state
 * rather than inventing steps.
 */
function ResearchProgressPanel({
  company,
  startedAtMs,
  events,
  onCancel,
}: {
  company: string;
  startedAtMs: number;
  events: CompanyResearchProgress[];
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { rows, writing, sourceCount } = useMemo(() => {
    const byCall = new Map<string, ResearchSearchRow>();
    const order: string[] = [];
    let isWriting = false;
    const seenUrls = new Set<string>();

    for (const event of events) {
      if (event.stage === "writing") {
        isWriting = true;
        continue;
      }
      if (event.stage === "started") continue;
      const key = event.callId || `call-${order.length}`;
      const existing = byCall.get(key);
      if (!existing) order.push(key);
      const merged: ResearchSearchRow = {
        callId: key,
        query: event.query || existing?.query || "",
        urls: event.urls.length ? event.urls : existing?.urls ?? [],
        kind: event.stage === "reading" ? "read" : existing?.kind ?? "search",
        done: event.stage !== "search_started" || (existing?.done ?? false),
      };
      byCall.set(key, merged);
      for (const url of merged.urls) seenUrls.add(url);
    }

    return {
      rows: order.flatMap((key) => {
        const row = byCall.get(key);
        return row ? [row] : [];
      }),
      writing: isWriting,
      sourceCount: seenUrls.size,
    };
  }, [events]);

  const streaming = events.length > 0;

  return (
    <section className="db-interview-progress" aria-live="polite">
      <header className="db-interview-progress-head">
        <span className="db-interview-progress-title">
          <Loader2 size={15} className="db-interview-spin" aria-hidden />
          Researching {company.trim() || "the company"}
        </span>
        <span className="db-interview-progress-right">
          <time className="db-interview-progress-clock">{elapsedLabel(now - startedAtMs)}</time>
          <button type="button" className="db-interview-progress-cancel" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </header>

      {streaming ? (
        <ol className="db-interview-progress-steps">
          <li className="is-done">
            <span className="db-interview-progress-dot" aria-hidden />
            <span className="db-interview-progress-text">Contacting the research model</span>
          </li>
          {rows.map((row) => (
            <li key={row.callId} className={row.done ? "is-done" : "is-active"}>
              <span className="db-interview-progress-dot" aria-hidden />
              <span className="db-interview-progress-text">
                <span className="db-interview-progress-verb">
                  {row.kind === "read" ? "Read" : row.done ? "Searched" : "Searching"}
                </span>
                {row.query ? (
                  <span className="db-interview-progress-query">{row.query}</span>
                ) : (
                  <span className="db-interview-progress-query is-pending">the web</span>
                )}
              </span>
              {row.urls.length > 0 && (
                <span className="db-interview-progress-sources">
                  {row.urls.map((url) => <SourceChip key={url} url={url} />)}
                </span>
              )}
            </li>
          ))}
          <li className={writing ? "is-active" : "is-pending"}>
            <span className="db-interview-progress-dot" aria-hidden />
            <span className="db-interview-progress-text">Writing the dossier</span>
          </li>
        </ol>
      ) : (
        <p className="db-interview-progress-note">
          <Search size={14} aria-hidden />
          Searching public sources. This usually takes 30 to 60 seconds.
        </p>
      )}

      {sourceCount > 0 && (
        <footer className="db-interview-progress-foot">
          {sourceCount} {sourceCount === 1 ? "source" : "sources"} consulted so far
        </footer>
      )}
    </section>
  );
}

type ResumeTab = "upload" | "paste";

/**
 * Resume intake, as a modal rather than an inline strip.
 *
 * Extracted text is always shown in an editable box before it is accepted. That
 * is what makes the character cap survivable: a long CV becomes "trim this"
 * instead of an outright rejection, and the user can see exactly what Aura will
 * be grounded on.
 */
function ResumeImportDialog({
  open,
  initialValue,
  onClose,
  onSave,
}: {
  open: boolean;
  initialValue: string;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const [tab, setTab] = useState<ResumeTab>("upload");
  const [text, setText] = useState(initialValue);
  const [sourceLabel, setSourceLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setText(initialValue);
    setSourceLabel(initialValue ? "Saved resume" : "");
    setNotice("");
    setDragging(false);
    setTab(initialValue ? "paste" : "upload");
  }, [open, initialValue]);

  const takeFile = async (file: File) => {
    setBusy(true);
    setNotice("");
    try {
      const extracted = await extractResumeText(file);
      setText(extracted);
      setSourceLabel(file.name);
      setTab("paste");
    } catch (err) {
      if (err instanceof ResumeExtractionError) {
        setNotice(err.message);
      } else {
        logError("InterviewPage: extract resume", err);
        setNotice("Aura could not read that resume file.");
      }
    } finally {
      setBusy(false);
    }
  };

  const takeClipboard = async () => {
    setBusy(true);
    setNotice("");
    try {
      // Tauri's clipboard plugin, not navigator.clipboard: the WebView API
      // triggers a Chromium permission prompt on tauri.localhost, while this
      // resolves in Rust against the capability grant with no dialog.
      const clipboard = (await readClipboardText()) ?? "";
      if (!clipboard.trim()) {
        setNotice("The clipboard has no text to import.");
        return;
      }
      setText(clipboard.trim());
      setSourceLabel("Clipboard");
      setTab("paste");
    } catch (err) {
      logError("InterviewPage: import resume clipboard", err);
      setNotice("Aura could not read the clipboard. Choose a file or paste the text instead.");
    } finally {
      setBusy(false);
    }
  };

  const stats = resumeStats(text);
  const overLimit = stats.characters > RESUME_MAX_CHARS;

  return (
    <DetailModal
      open={open}
      title="Add your resume"
      onClose={onClose}
      panelClassName="db-interview-glass-panel"
    >
      <div className="db-resume-dialog">
        <div className="db-resume-tabs" role="tablist" aria-label="Resume source">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "upload"}
            className={tab === "upload" ? "is-active" : ""}
            onClick={() => setTab("upload")}
          >
            Upload file
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "paste"}
            className={tab === "paste" ? "is-active" : ""}
            onClick={() => setTab("paste")}
          >
            Paste text
          </button>
        </div>

        {tab === "upload" ? (
          <>
            <div
              className={`db-resume-drop${dragging ? " is-dragging" : ""}${busy ? " is-busy" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files?.[0];
                if (file) void takeFile(file);
              }}
            >
              {busy ? (
                <Loader2 size={22} className="db-interview-spin" aria-hidden />
              ) : (
                <Upload size={22} aria-hidden />
              )}
              <strong>{busy ? "Reading your resume" : "Drop your resume here"}</strong>
              <button
                type="button"
                className="db-resume-choose"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                or choose a file
              </button>
              <span>PDF, Word (.docx), or plain text</span>
              <input
                ref={fileRef}
                type="file"
                accept={RESUME_ACCEPT}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void takeFile(file);
                  event.target.value = "";
                }}
              />
            </div>
            <button
              type="button"
              className="db-resume-clipboard"
              disabled={busy}
              onClick={() => void takeClipboard()}
            >
              <ClipboardPaste size={15} aria-hidden />
              Paste from clipboard
            </button>
          </>
        ) : (
          <label className="db-resume-editor">
            <span>
              Resume text
              {sourceLabel && <small>from {sourceLabel}</small>}
            </span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste your resume here"
              spellCheck={false}
            />
          </label>
        )}

        {notice && <p className="db-resume-notice">{notice}</p>}

        <footer className="db-resume-foot">
          <span className={`db-resume-count${overLimit ? " is-over" : ""}`}>
            {text.trim()
              ? `${stats.words.toLocaleString()} words, ${stats.characters.toLocaleString()} characters`
              : "Nothing added yet"}
            {overLimit && `, trim to ${RESUME_MAX_CHARS.toLocaleString()}`}
          </span>
          <span className="db-resume-actions">
            {initialValue && (
              <button
                type="button"
                className="db-resume-remove"
                onClick={() => {
                  onSave("");
                  onClose();
                }}
              >
                Remove
              </button>
            )}
            <button type="button" className="db-resume-cancel" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="db-resume-save"
              disabled={busy || overLimit || !text.trim()}
              onClick={() => {
                onSave(text.trim());
                onClose();
              }}
            >
              Use resume
            </button>
          </span>
        </footer>
      </div>
    </DetailModal>
  );
}

function ResumeImport({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const stats = resumeStats(value);
  return (
    <div className={`db-interview-resume${value ? " has-resume" : ""}`}>
      <span className="db-interview-resume-icon" aria-hidden>
        <FileText size={20} />
      </span>
      <strong>{value ? "Resume ready" : "Add your resume"}</strong>
      <span className="db-interview-resume-sub">
        {value
          ? `${stats.words.toLocaleString()} words Aura can ground answers on`
          : "PDF, Word, or plain text. Optional, but answers get much sharper with it."}
      </span>
      <button type="button" className="db-interview-resume-cta" onClick={() => setOpen(true)}>
        {value ? "Review resume" : "Add resume"}
      </button>
      <ResumeImportDialog
        open={open}
        initialValue={value}
        onClose={() => setOpen(false)}
        onSave={onChange}
      />
    </div>
  );
}

function ClaimSources({
  claim,
  sources,
}: {
  claim: InterviewBriefClaim;
  sources: Map<string, InterviewBriefSource>;
}) {
  const supporting = claim.sourceIds.flatMap((sourceId) => {
    const source = sources.get(sourceId);
    return source ? [source] : [];
  });
  return (
    <span className="db-interview-sources">
      {supporting.map((source, sourceIndex) => source.urls.length > 0 ? (
        source.urls.slice(0, 2).map((url, urlIndex) => (
          <SourceChip key={`${url}:${urlIndex}`} url={url} title={source.label} />
        ))
      ) : (
        <strong key={`${source.sourceId}:${sourceIndex}`}>{source.label}</strong>
      ))}
    </span>
  );
}

function ClaimRow({
  claim,
  sources,
  onVerification,
  prefix,
  reviewable = false,
}: {
  claim: InterviewBriefClaim;
  sources: Map<string, InterviewBriefSource>;
  onVerification?: (claimId: string, verified: boolean) => void;
  prefix?: string;
  reviewable?: boolean;
}) {
  const verified = claim.verificationState === "verified";
  return (
    <div className={`db-interview-claim is-${claim.scope}`}>
      <div>
        {prefix && <span className="db-interview-claim-prefix">{prefix}</span>}
        <p>{claim.text}</p>
        <ClaimSources claim={claim} sources={sources} />
      </div>
      {reviewable ? (
        <button
          type="button"
          className={verified ? "is-verified" : ""}
          onClick={() => onVerification?.(claim.claimId, !verified)}
        >
          {verified ? "Confirmed" : "Confirm"}
        </button>
      ) : (
        <span className="db-interview-claim-status">{claim.scope === "constraint" ? "Boundary" : "Source-backed"}</span>
      )}
    </div>
  );
}

function ClaimSection({
  title,
  copy,
  claims,
  sources,
  onVerification,
  reviewable = false,
}: {
  title: string;
  copy?: string;
  claims: InterviewBriefClaim[];
  sources: Map<string, InterviewBriefSource>;
  onVerification?: (claimId: string, verified: boolean) => void;
  reviewable?: boolean;
}) {
  if (claims.length === 0) return null;
  return (
    <section className="db-interview-review-section">
      <h3>{title}</h3>
      {copy && <p className="db-interview-section-copy">{copy}</p>}
      <div className="db-interview-claims">
        {claims.map((claim) => (
          <ClaimRow
            key={claim.claimId}
            claim={claim}
            sources={sources}
            onVerification={onVerification}
            reviewable={reviewable}
          />
        ))}
      </div>
    </section>
  );
}

function BriefReview({
  brief,
  activeBriefId,
  saving,
  onChange,
  onUse,
}: {
  brief: InterviewBrief;
  activeBriefId: string | null;
  saving: boolean;
  onChange: (brief: InterviewBrief) => void;
  onUse: () => void;
}) {
  const sources = useMemo(
    () => new Map(brief.sources.map((source) => [source.sourceId, source])),
    [brief.sources],
  );
  const onVerification = (claimId: string, verified: boolean) =>
    onChange(withCandidateVerification(brief, claimId, verified ? "verified" : "unverified"));
  const candidateClaims = candidateBriefClaims(brief);
  const verifiedCount = candidateClaims.filter((claim) => claim.verificationState === "verified").length;
  const isActive = activeBriefId === brief.briefId && brief.reviewedAtMs !== null;

  return (
    <section className="db-interview-review">
      <div className="db-interview-review-head">
        <div>
          <span className="db-interview-eyebrow">Final review</span>
          <h2>{brief.role?.text || "Interview"} at {brief.company?.text || "the company"}</h2>
          <p>Company context is source-backed. Only candidate claims you confirm can support claims about your experience.</p>
        </div>
        <div className="db-interview-review-count">
          <strong>{verifiedCount}</strong>
          <span>of {candidateClaims.length} candidate claims confirmed</span>
        </div>
      </div>

      <ClaimSection title="Target context" claims={[brief.company, brief.role].filter((claim): claim is InterviewBriefClaim => claim !== null)} sources={sources} />
      <ClaimSection title="Company research" claims={brief.targetFacts} sources={sources} />
      <ClaimSection title="Job requirements" claims={brief.jdRequirements} sources={sources} />
      <ClaimSection title="Questions they may ask" copy="Practice prompts only. Aura will not suggest these as questions for you to ask the panel." claims={brief.likelyInterviewerQuestions} sources={sources} />
      <ClaimSection title="Your facts" claims={brief.candidateFacts} sources={sources} onVerification={onVerification} reviewable />
      <ClaimSection title="Your projects" claims={brief.projects} sources={sources} onVerification={onVerification} reviewable />

      {brief.starStories.length > 0 && (
        <section className="db-interview-review-section">
          <h3>Your STAR stories</h3>
          <div className="db-interview-stories">
            {brief.starStories.map((story) => (
              <article key={story.storyId}>
                <h4>{story.title}</h4>
                <ClaimRow claim={story.situation} prefix="Situation" sources={sources} onVerification={onVerification} reviewable />
                <ClaimRow claim={story.task} prefix="Task" sources={sources} onVerification={onVerification} reviewable />
                <ClaimRow claim={story.action} prefix="Action" sources={sources} onVerification={onVerification} reviewable />
                <ClaimRow claim={story.result} prefix="Result" sources={sources} onVerification={onVerification} reviewable />
              </article>
            ))}
          </div>
        </section>
      )}

      <ClaimSection title="Your metrics" claims={brief.metrics} sources={sources} onVerification={onVerification} reviewable />
      <ClaimSection title="Gaps" claims={brief.gaps} sources={sources} />
      <ClaimSection title="Never claim" claims={brief.doNotClaim} sources={sources} />

      <div className="db-interview-review-footer">
        <span>
          {activeBriefId && !isActive
            ? "Your previous reviewed brief remains in use until you apply this one."
            : "Ready for Interview Companion."}
        </span>
        <button type="button" disabled={saving || isActive} onClick={onUse}>
          {isActive ? "Brief in use" : saving ? "Saving" : "Use reviewed brief"}
        </button>
      </div>
    </section>
  );
}

function InterviewHistoryPanel({
  interviews,
  activeInterviewId,
  pendingDeleteId,
  deletingInterviewId,
  onOpen,
  onNew,
  onRequestDelete,
  onCancelDelete,
  onDelete,
}: {
  interviews: InterviewWorkspaceRecord[];
  activeInterviewId: string | null;
  pendingDeleteId: string | null;
  deletingInterviewId: string | null;
  onOpen: (interviewId: string) => void;
  onNew: () => void;
  onRequestDelete: (interviewId: string) => void;
  onCancelDelete: () => void;
  onDelete: (interviewId: string) => void;
}) {
  return (
    <section id="interview-history-panel" className="db-interview-history" role="tabpanel" aria-labelledby="interview-history-tab">
      <div className="db-interview-section-head">
        <div>
          <span className="db-interview-eyebrow">Saved preparation</span>
          <h2>Interview history</h2>
          <p>Open any company to continue preparing or make its reviewed brief active in Aura.</p>
        </div>
      </div>

      {interviews.length === 0 ? (
        <div className="db-interview-history-empty">
          <History size={22} aria-hidden />
          <div>
            <strong>No saved interviews yet</strong>
            <span>Your company research and preparation will appear here.</span>
          </div>
          <button type="button" onClick={onNew}>
            <Plus size={15} aria-hidden />
            Start an interview
          </button>
        </div>
      ) : (
        <div className="db-interview-history-grid">
          {interviews.map((interview) => {
            const isActive = interview.interviewId === activeInterviewId;
            const isConfirmingDelete = pendingDeleteId === interview.interviewId;
            const isDeleting = deletingInterviewId === interview.interviewId;
            return (
              <article key={interview.interviewId} className={`db-interview-history-card${isActive ? " is-active" : ""}`}>
                <div className="db-interview-history-card-top">
                  <span className="db-interview-company-icon"><Building2 size={17} aria-hidden /></span>
                  <span className={`db-interview-history-status${isActive ? " is-active" : ""}`}>
                    {isActive && <CheckCircle2 size={12} aria-hidden />}
                    {interviewStatus(interview, activeInterviewId)}
                  </span>
                </div>
                <div className="db-interview-history-copy">
                  <h3>{interview.input.company.trim() || "Untitled interview"}</h3>
                  <p>{interview.input.role.trim() || "Target role not added"}</p>
                </div>
                <div className="db-interview-history-meta">
                  <span>Updated {UPDATED_AT_FORMATTER.format(interview.updatedAtMs)}</span>
                  {interview.research && <span>{interview.research.sources.length} sources</span>}
                </div>

                {isConfirmingDelete ? (
                  <div className="db-interview-delete-confirm" role="alert">
                    <p>{isActive ? "Delete this interview and remove its brief from Aura?" : "Delete this interview and its saved preparation?"}</p>
                    <div>
                      <button type="button" onClick={onCancelDelete} disabled={isDeleting}>Cancel</button>
                      <button type="button" className="is-danger" onClick={() => onDelete(interview.interviewId)} disabled={isDeleting}>
                        <Trash2 size={13} aria-hidden />
                        {isDeleting ? "Deleting" : "Delete"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="db-interview-history-actions">
                    <button type="button" className="db-interview-open-button" onClick={() => onOpen(interview.interviewId)}>
                      Open interview
                      <ArrowRight size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="db-interview-delete-button"
                      aria-label={`Delete ${interview.input.company.trim() || "untitled interview"}`}
                      title="Delete interview"
                      onClick={() => onRequestDelete(interview.interviewId)}
                    >
                      <Trash2 size={15} aria-hidden />
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

const ROUND_LABEL: Record<string, string> = Object.fromEntries(
  ROUND_KIND_OPTIONS.map((option) => [option.value, option.label]),
);

function sessionDurationMinutes(session: InterviewSessionSummary): number {
  return Math.max(0, Math.round((session.endedAtMs - session.startedAtMs) / 60_000));
}

/** Past interview rounds, read from the local encrypted store. Unlike the
 * Preparation tab (saved briefs), these are the actual transcripts and answers
 * from sessions the user ran. Local-only: the backend never held them. */
function ReflectionList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h5>{title}</h5>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </>
  );
}

/** Same markdown the overlay writes, so a reflection downloaded here and one
 *  downloaded from the card are byte-identical. */
function reflectionMarkdown(reflection: StoredReflection): string {
  const section = (title: string, items: string[]) =>
    items.length > 0
      ? `\n## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}\n`
      : "";
  return `# Interview reflection\n\n${reflection.summary}\n`
    + section("Strengths", reflection.strengths)
    + section("Improve next time", reflection.improvements)
    + section("Follow-up actions", reflection.followUpActions);
}

function downloadReflection(reflection: StoredReflection): void {
  void invoke<{ path: string }>("save_interview_reflection", {
    markdown: reflectionMarkdown(reflection),
  }).catch((error) => logError("InterviewPage: download reflection", error));
}

function InterviewSessionsPanel({ uid }: { uid: string | null }) {
  const [sessions, setSessions] = useState<InterviewSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<InterviewSessionDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    if (!uid) {
      setSessions([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    listInterviewSessions(uid)
      .then((rows) => {
        if (active) setSessions(rows);
      })
      .catch((error) => logError("InterviewPage: list sessions", error))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [uid]);

  const openDetail = (sessionId: string) => {
    if (!uid) return;
    setDetailOpen(true);
    setDetail(null);
    loadInterviewSession(uid, sessionId)
      .then((loaded) => setDetail(loaded))
      .catch((error) => logError("InterviewPage: load session", error));
  };

  const removeSession = (sessionId: string) => {
    if (!uid) return;
    setPendingDeleteId(null);
    setSessions((current) => current.filter((row) => row.sessionId !== sessionId));
    deleteInterviewSession(uid, sessionId).catch((error) =>
      logError("InterviewPage: delete session", error),
    );
  };

  const clearAll = () => {
    if (!uid) return;
    setConfirmingClear(false);
    setSessions([]);
    clearInterviewSessions(uid).catch((error) =>
      logError("InterviewPage: clear sessions", error),
    );
  };

  const detailTitle = detail
    ? `${detail.company?.trim() || "Interview"}${detail.role ? ` · ${detail.role}` : ""}`
    : "Interview session";

  return (
    <section
      id="interview-sessions-panel"
      className="db-interview-history"
      role="tabpanel"
      aria-labelledby="interview-sessions-tab"
    >
      <div className="db-interview-section-head">
        <div>
          <span className="db-interview-eyebrow">Past rounds</span>
          <h2>Interview sessions</h2>
          <p>The transcript and answers from each session you ran, kept on this device. Last 25 sessions or 90 days.</p>
        </div>
        {sessions.length > 0 && (
          confirmingClear ? (
            <div className="db-interview-delete-confirm" role="alert">
              <p>Delete every stored session on this device?</p>
              <div>
                <button type="button" onClick={() => setConfirmingClear(false)}>Cancel</button>
                <button type="button" className="is-danger" onClick={clearAll}>
                  <Trash2 size={13} aria-hidden />
                  Delete all
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="db-interview-delete-button" onClick={() => setConfirmingClear(true)}>
              <Trash2 size={15} aria-hidden />
              Delete all
            </button>
          )
        )}
      </div>

      {loading ? (
        <div className="db-interview-history-empty">
          <Loader2 size={22} className="db-interview-spin" aria-hidden />
          <div><strong>Loading sessions...</strong></div>
        </div>
      ) : sessions.length === 0 ? (
        <div className="db-interview-history-empty">
          <History size={22} aria-hidden />
          <div>
            <strong>No sessions yet</strong>
            <span>Run Interview Companion and stop it, and the round will appear here.</span>
          </div>
        </div>
      ) : (
        <div className="db-interview-history-grid">
          {sessions.map((session) => {
            const isConfirmingDelete = pendingDeleteId === session.sessionId;
            return (
              <article key={session.sessionId} className="db-interview-history-card">
                <div className="db-interview-history-card-top">
                  <span className="db-interview-company-icon"><Building2 size={17} aria-hidden /></span>
                  <span className="db-interview-history-status">
                    {ROUND_LABEL[session.roundKind] ?? session.roundKind}
                  </span>
                </div>
                <div className="db-interview-history-copy">
                  <h3>{session.company?.trim() || "Interview"}</h3>
                  <p>{session.role?.trim() || "Role not recorded"}</p>
                </div>
                <div className="db-interview-history-meta">
                  <span>{shortDateTime(new Date(session.startedAtMs).toISOString())}</span>
                  <span>{session.exchangeCount} answers</span>
                  <span>{sessionDurationMinutes(session)} min</span>
                  {session.hasReflection && <span>Reflection</span>}
                </div>

                {isConfirmingDelete ? (
                  <div className="db-interview-delete-confirm" role="alert">
                    <p>Delete this session's transcript from this device?</p>
                    <div>
                      <button type="button" onClick={() => setPendingDeleteId(null)}>Cancel</button>
                      <button type="button" className="is-danger" onClick={() => removeSession(session.sessionId)}>
                        <Trash2 size={13} aria-hidden />
                        Delete
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="db-interview-history-actions">
                    <button type="button" className="db-interview-open-button" onClick={() => openDetail(session.sessionId)}>
                      Open transcript
                      <ArrowRight size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="db-interview-delete-button"
                      aria-label="Delete session"
                      title="Delete session"
                      onClick={() => setPendingDeleteId(session.sessionId)}
                    >
                      <Trash2 size={15} aria-hidden />
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <DetailModal open={detailOpen} title={detailTitle} onClose={() => setDetailOpen(false)}>
        {!detail ? (
          <div className="db-interview-session-detail-loading">
            <Loader2 size={20} className="db-interview-spin" aria-hidden />
            Loading transcript...
          </div>
        ) : (
          <div className="db-interview-session-detail">
            {detail.reflection && (
              <div className="db-interview-session-block db-interview-reflection">
                <div className="db-interview-reflection-head">
                  <h4>Reflection</h4>
                  <button
                    type="button"
                    className="db-interview-reflection-download"
                    onClick={() => downloadReflection(detail.reflection!)}
                  >
                    <Download size={14} aria-hidden />
                    Download
                  </button>
                </div>
                <p>{detail.reflection.summary}</p>
                <ReflectionList title="Strengths" items={detail.reflection.strengths} />
                <ReflectionList title="Improve next time" items={detail.reflection.improvements} />
                <ReflectionList title="Follow-up actions" items={detail.reflection.followUpActions} />
              </div>
            )}
            {detail.exchanges.length > 0 && (
              <div className="db-interview-session-block">
                <h4>Questions and answers</h4>
                {detail.exchanges.map((exchange) => (
                  <div key={`ex-${exchange.seq}`} className="db-interview-session-qa">
                    <p className="db-interview-session-q">{exchange.question}</p>
                    <p className="db-interview-session-a">
                      {exchange.unverified && (
                        <span className="db-interview-session-unverified">Not from brief</span>
                      )}
                      {exchange.answer}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {detail.turns.length > 0 && (
              <div className="db-interview-session-block">
                <h4>Full transcript</h4>
                {detail.turns.map((turn) => (
                  <p
                    key={`turn-${turn.seq}`}
                    className={`db-interview-session-turn is-${turn.source}`}
                  >
                    <span>{turn.source === "candidate" ? "You" : "Interviewer"}</span>
                    {turn.text}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </section>
  );
}

export function InterviewPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [workspace, setWorkspace] = useState<InterviewWorkspace>(createInterviewWorkspace);
  const [tab, setTab] = useState<InterviewPageTab>("current");
  const [renderedTab, setRenderedTab] = useState<InterviewPageTab>("current");
  const [tabTransition, setTabTransition] = useState<InterviewTabTransition>("idle");
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [researchingIds, setResearchingIds] = useState<Set<string>>(() => new Set());
  const [buildingIds, setBuildingIds] = useState<Set<string>>(() => new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(() => new Set());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingInterviewId, setDeletingInterviewId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [researchEvents, setResearchEvents] = useState<CompanyResearchProgress[]>([]);
  const [researchStartedAtMs, setResearchStartedAtMs] = useState(0);
  const [researchPanelDue, setResearchPanelDue] = useState(false);
  const researchAbortRef = useRef<AbortController | null>(null);
  const researchPanelTimer = useRef<number | null>(null);
  const persistenceRevision = useRef(0);
  const tabTransitionTimer = useRef<number | null>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const currentInterview = workspace.interviews.find(
    (interview) => interview.interviewId === workspace.currentInterviewId,
  ) ?? null;
  const history = useMemo(
    () => workspace.interviews
      .filter(hasInterviewContent)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs),
    [workspace.interviews],
  );
  const input = currentInterview?.input ?? EMPTY_INPUT;
  const research = currentInterview?.research ?? null;
  const brief = currentInterview?.draftBrief ?? null;
  const activeBriefId = workspace.activeBrief?.briefId ?? null;
  const researching = currentInterview ? researchingIds.has(currentInterview.interviewId) : false;
  const building = currentInterview ? buildingIds.has(currentInterview.interviewId) : false;
  const saving = currentInterview ? savingIds.has(currentInterview.interviewId) : false;

  useEffect(() => {
    let active = true;
    persistenceRevision.current += 1;
    setPersistenceReady(false);
    setWorkspace(createInterviewWorkspace());
    setTab("current");
    setRenderedTab("current");
    setTabTransition("idle");
    setResearchingIds(new Set());
    setBuildingIds(new Set());
    setSavingIds(new Set());
    setPendingDeleteId(null);
    setDeletingInterviewId(null);
    if (!uid) return () => { active = false; };
    void (async () => {
      const storedWorkspace = await loadInterviewWorkspace(uid);
      const memoryBrief = await loadInterviewBrief().catch((err) => {
        logError("InterviewPage: load active brief", err);
        return null;
      });
      if (!active) return;
      let restoredWorkspace = storedWorkspace ?? createInterviewWorkspace();
      if (restoredWorkspace.interviews.length === 0) {
        restoredWorkspace = createInterviewWorkspace();
      }
      if (memoryBrief) {
        const storedActiveInterview = restoredWorkspace.activeBrief?.briefId === memoryBrief.briefId
          ? restoredWorkspace.interviews.find(
            (interview) => interview.interviewId === restoredWorkspace.activeInterviewId,
          )
          : null;
        const matchingInterview = storedActiveInterview ?? restoredWorkspace.interviews.find(
          (interview) => interview.draftBrief?.briefId === memoryBrief.briefId,
        );
        if (matchingInterview) {
          restoredWorkspace = {
            ...restoredWorkspace,
            activeInterviewId: matchingInterview.interviewId,
            activeBrief: memoryBrief,
          };
        } else {
          await clearInterviewBrief();
          restoredWorkspace = {
            ...restoredWorkspace,
            activeInterviewId: null,
            activeBrief: null,
          };
        }
      } else if (restoredWorkspace.activeBrief?.reviewedAtMs != null) {
        await storeInterviewBrief(restoredWorkspace.activeBrief);
      }
      if (!active) return;
      const restoredActiveInterviewId = restoredWorkspace.activeInterviewId;
      const restoredHasHistory = restoredWorkspace.interviews.some(hasInterviewContent);
      if (restoredActiveInterviewId) {
        restoredWorkspace = {
          ...restoredWorkspace,
          currentInterviewId: restoredActiveInterviewId,
        };
      }
      setWorkspace(restoredWorkspace);
      const restoredTab = restoredActiveInterviewId ? "current" : restoredHasHistory ? "preparation" : "current";
      setTab(restoredTab);
      setRenderedTab(restoredTab);
      setPersistenceReady(true);
    })().catch((err) => {
      logError("InterviewPage: load local workspace", err);
      if (!active) return;
      setPersistenceReady(true);
      setError("Aura could not restore your saved preparation.");
    });
    return () => {
      active = false;
      persistenceRevision.current += 1;
    };
  }, [uid]);

  useEffect(() => {
    if (!uid || !persistenceReady) return;
    const revision = ++persistenceRevision.current;
    const timer = window.setTimeout(() => {
      void saveInterviewWorkspace(uid, workspace).then((saved) => {
        if (!saved && persistenceRevision.current === revision) {
          setError("Aura could not save your preparation on this device.");
        }
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [persistenceReady, uid, workspace]);

  useEffect(() => () => {
    if (tabTransitionTimer.current !== null) window.clearTimeout(tabTransitionTimer.current);
    researchAbortRef.current?.abort();
    if (researchPanelTimer.current !== null) window.clearTimeout(researchPanelTimer.current);
  }, []);

  const setBusy = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    interviewId: string,
    busy: boolean,
  ) => setter((current) => {
    const next = new Set(current);
    if (busy) next.add(interviewId);
    else next.delete(interviewId);
    return next;
  });

  const updateInterview = (
    interviewId: string,
    updateRecord: (interview: InterviewWorkspaceRecord) => InterviewWorkspaceRecord,
  ) => setWorkspace((current) => ({
    ...current,
    interviews: current.interviews.map((interview) => {
      if (interview.interviewId !== interviewId) return interview;
      const updated = updateRecord(interview);
      return updated === interview ? interview : { ...updated, updatedAtMs: Date.now() };
    }),
  }));

  const update = (key: keyof InterviewPreparationInput, value: string) => {
    if (!currentInterview) return;
    updateInterview(currentInterview.interviewId, (interview) => ({
      ...interview,
      input: { ...interview.input, [key]: value },
      draftBrief: null,
    }));
  };
  // Round and planned length are session pacing, not evidence. Unlike `update`
  // they must NOT clear draftBrief: changing the round does not invalidate a
  // brief the user already reviewed and confirmed claim by claim.
  const updateProfile = (
    patch: Partial<Pick<InterviewWorkspaceRecord, "lastRoundKind" | "plannedMinutes">>,
  ) => {
    if (!currentInterview) return;
    updateInterview(currentInterview.interviewId, (interview) => ({ ...interview, ...patch }));
  };
  const updateTarget = (key: "company" | "companyUrl" | "role" | "jobDescription", value: string) => {
    if (!currentInterview) return;
    updateInterview(currentInterview.interviewId, (interview) => ({
      ...interview,
      input: { ...interview.input, [key]: value },
      research: null,
      draftBrief: null,
    }));
  };
  const canResearch = Boolean(currentInterview) && input.company.trim().length > 0 && !researching;
  const canBuild = Boolean(currentInterview && research) && !building;

  function switchTab(nextTab: InterviewPageTab) {
    if (nextTab === tab && tabTransition === "idle") return;
    if (tabTransitionTimer.current !== null) window.clearTimeout(tabTransitionTimer.current);
    setTab(nextTab);
    const reduceMotion = document.querySelector(".db-app")?.classList.contains("db-reduce-motion")
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setRenderedTab(nextTab);
      setTabTransition("idle");
      return;
    }
    setTabTransition("exiting");
    tabTransitionTimer.current = window.setTimeout(() => {
      setRenderedTab(nextTab);
      setTabTransition("entering");
      tabTransitionTimer.current = window.setTimeout(() => {
        setTabTransition("idle");
        tabTransitionTimer.current = null;
      }, 24);
    }, 170);
  }

  function createNewInterview() {
    if (currentInterview && !hasInterviewContent(currentInterview)) {
      switchTab("current");
      return;
    }
    const interview = createInterviewRecord();
    setWorkspace((current) => ({
      ...current,
      interviews: [interview, ...current.interviews],
      currentInterviewId: interview.interviewId,
    }));
    setPendingDeleteId(null);
    setError("");
    switchTab("current");
  }

  function openInterview(interviewId: string) {
    setWorkspace((current) => ({ ...current, currentInterviewId: interviewId }));
    setPendingDeleteId(null);
    setError("");
    switchTab("current");
  }

  async function deleteInterview(interviewId: string) {
    const deletingActiveInterview = workspaceRef.current.activeInterviewId === interviewId;
    setDeletingInterviewId(interviewId);
    setError("");
    try {
      if (deletingActiveInterview) await clearInterviewBrief();
      setWorkspace((current) => {
        const remaining = current.interviews.filter((interview) => interview.interviewId !== interviewId);
        const interviews = remaining.length > 0 ? remaining : [createInterviewRecord()];
        const currentInterviewId = current.currentInterviewId === interviewId
          ? [...interviews].sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0].interviewId
          : current.currentInterviewId;
        return {
          ...current,
          interviews,
          currentInterviewId,
          activeInterviewId: deletingActiveInterview ? null : current.activeInterviewId,
          activeBrief: deletingActiveInterview ? null : current.activeBrief,
        };
      });
      setPendingDeleteId(null);
    } catch (err) {
      logError("InterviewPage: delete interview", err);
      setError("Aura could not delete that interview.");
    } finally {
      setDeletingInterviewId(null);
    }
  }

  async function runResearch() {
    if (!canResearch || !currentInterview) return;
    const interviewId = currentInterview.interviewId;
    const target = currentInterview.input;
    if (target.companyUrl.trim()) {
      try {
        const companyUrl = new URL(target.companyUrl.trim());
        if (companyUrl.protocol !== "http:" && companyUrl.protocol !== "https:") {
          throw new Error("Unsupported company website protocol");
        }
      } catch {
        setError("Enter the full company website, including https://, or leave it blank.");
        return;
      }
    }
    const controller = new AbortController();
    researchAbortRef.current?.abort();
    researchAbortRef.current = controller;
    const signature = targetSignature(target);
    setBusy(setResearchingIds, interviewId, true);
    setResearchEvents([]);
    setResearchStartedAtMs(Date.now());
    // A cached dossier comes back in well under a second. Holding the panel
    // back until either a real event lands or this timer fires keeps that case
    // from flashing a progress UI the user cannot read.
    setResearchPanelDue(false);
    if (researchPanelTimer.current !== null) window.clearTimeout(researchPanelTimer.current);
    researchPanelTimer.current = window.setTimeout(() => setResearchPanelDue(true), 700);
    setError("");
    try {
      const result = await streamInterviewCompanyResearch({
        company: target.company,
        companyUrl: target.companyUrl,
        role: target.role,
        jobDescription: target.jobDescription,
        signal: controller.signal,
        onProgress: (progress) => setResearchEvents((current) => [...current, progress]),
      });
      // Compare only the fields research actually used. The previous object
      // identity check threw away a finished dossier whenever any unrelated
      // field, candidate notes included, was edited while it ran.
      updateInterview(interviewId, (interview) => targetSignature(interview.input) === signature
        ? { ...interview, research: result, draftBrief: null }
        : interview);
    } catch (err) {
      if (controller.signal.aborted) return;
      logError("InterviewPage: company research", err);
      setError("Aura could not complete the company research. Your inputs are still here, so you can try again.");
    } finally {
      if (researchAbortRef.current === controller) researchAbortRef.current = null;
      if (researchPanelTimer.current !== null) window.clearTimeout(researchPanelTimer.current);
      researchPanelTimer.current = null;
      setResearchPanelDue(false);
      setBusy(setResearchingIds, interviewId, false);
      setResearchEvents([]);
    }
  }

  function cancelResearch() {
    researchAbortRef.current?.abort();
    researchAbortRef.current = null;
    if (currentInterview) setBusy(setResearchingIds, currentInterview.interviewId, false);
    setResearchEvents([]);
  }

  async function build() {
    if (!canBuild || !currentInterview || !research) return;
    const interviewId = currentInterview.interviewId;
    const preparationInput = currentInterview.input;
    const companyResearch = research;
    setBusy(setBuildingIds, interviewId, true);
    setError("");
    try {
      const builtBrief = await buildInterviewBrief(
        preparationSources(preparationInput, companyResearch),
        preparationInput.answerLength,
      );
      updateInterview(interviewId, (interview) => interview.input === preparationInput && interview.research === companyResearch
        ? { ...interview, draftBrief: builtBrief }
        : interview);
    } catch (err) {
      logError("InterviewPage: build brief", err);
      setError("Aura could not build the interview brief. Your preparation is still here, so you can try again.");
    } finally {
      setBusy(setBuildingIds, interviewId, false);
    }
  }

  async function useBrief() {
    if (!brief || !currentInterview) return;
    const interviewId = currentInterview.interviewId;
    // Ride the profile along on the brief envelope. The overlay never sees the
    // workspace record, and the Rust brief slot stores the brief as an opaque
    // JSON value, so this is the one channel that already reaches it. Neither
    // field is evidence and neither reaches the backend: the answer request is
    // built by relevantInterviewBriefSlice(), which enumerates slice fields
    // explicitly, and the slice model is extra="forbid" server side.
    const reviewed: InterviewBrief = {
      ...brief,
      reviewedAtMs: Date.now(),
      lastRoundKind: currentInterview.lastRoundKind ?? DEFAULT_ROUND_KIND,
      plannedMinutes: currentInterview.plannedMinutes ?? DEFAULT_PLANNED_MINUTES,
    };
    setBusy(setSavingIds, interviewId, true);
    setError("");
    try {
      await storeInterviewBrief(reviewed);
      setWorkspace((current) => ({
        ...current,
        interviews: current.interviews.map((interview) => interview.interviewId === interviewId
          ? { ...interview, draftBrief: reviewed, updatedAtMs: Date.now() }
          : interview),
        activeInterviewId: interviewId,
        activeBrief: reviewed,
      }));
    } catch (err) {
      logError("InterviewPage: store brief", err);
      setError("Aura could not keep this brief in memory.");
    } finally {
      setBusy(setSavingIds, interviewId, false);
    }
  }

  return (
    <div className="db-page db-page-wide db-interview-page">
      <header className="db-interview-page-head">
        <div className="db-interview-intro">
          <h1>Walk in knowing the company and your own evidence.</h1>
          <p>Aura researches the target once, shows you every source, then keeps company context separate from claims about your experience.</p>
        </div>
        {currentInterview && hasInterviewContent(currentInterview) && (
          <button type="button" className="db-interview-new-button" onClick={createNewInterview}>
            <Plus size={16} strokeWidth={2.2} aria-hidden />
            New interview
          </button>
        )}
      </header>

      <div className="db-interview-tabs" role="tablist" aria-label="Interview workspace" data-active={tab}>
        <button
          type="button"
          id="interview-current-tab"
          role="tab"
          aria-controls="interview-current-panel"
          aria-selected={tab === "current"}
          className={tab === "current" ? "is-active" : ""}
          onClick={() => switchTab("current")}
        >
          <BriefcaseBusiness size={15} aria-hidden />
          Current interview
        </button>
        <button
          type="button"
          id="interview-preparation-tab"
          role="tab"
          aria-controls="interview-history-panel"
          aria-selected={tab === "preparation"}
          className={tab === "preparation" ? "is-active" : ""}
          onClick={() => switchTab("preparation")}
        >
          <FileText size={15} aria-hidden />
          Preparation
          <span>{history.length}</span>
        </button>
        <button
          type="button"
          id="interview-sessions-tab"
          role="tab"
          aria-controls="interview-sessions-panel"
          aria-selected={tab === "sessions"}
          className={tab === "sessions" ? "is-active" : ""}
          onClick={() => switchTab("sessions")}
        >
          <History size={15} aria-hidden />
          Sessions
        </button>
      </div>

      <div className={`db-interview-tab-stage is-${tabTransition}`}>
      {error && <div className="db-interview-error">{error}</div>}

      {renderedTab === "sessions" ? (
        <InterviewSessionsPanel uid={uid} />
      ) : renderedTab === "preparation" ? (
        <InterviewHistoryPanel
          interviews={history}
          activeInterviewId={workspace.activeInterviewId}
          pendingDeleteId={pendingDeleteId}
          deletingInterviewId={deletingInterviewId}
          onOpen={openInterview}
          onNew={createNewInterview}
          onRequestDelete={setPendingDeleteId}
          onCancelDelete={() => setPendingDeleteId(null)}
          onDelete={(interviewId) => void deleteInterview(interviewId)}
        />
      ) : currentInterview ? (
        <div id="interview-current-panel" className="db-interview-current-panel" role="tabpanel" aria-labelledby="interview-current-tab">
      <InterviewSteps
        company={input.company}
        hasResearch={Boolean(research)}
        hasResume={Boolean(input.resume.trim())}
        claimCount={brief ? candidateBriefClaims(brief).length : 0}
        hasBrief={Boolean(brief)}
      />

      <section className="db-interview-builder">
        <div className="db-interview-section-head db-interview-target-head">
          <div>
            <h2>Tell Aura where you are interviewing</h2>
            <p>Only the company is required. A website helps Aura resolve companies with similar names.</p>
          </div>
        </div>
        <div className="db-interview-grid db-interview-grid-two">
          <Field optional={false} label="Company" value={input.company} onChange={(value) => updateTarget("company", value)} placeholder="NRG Energy" />
          <Field label="Company website" value={input.companyUrl} onChange={(value) => updateTarget("companyUrl", value)} placeholder="https://www.nrg.com" />
        </div>
        <div className="db-interview-grid db-interview-grid-two">
          <Field label="Target role" value={input.role} onChange={(value) => updateTarget("role", value)} placeholder="Sr AI Platform Engineer" />
          <Field label="Job description" value={input.jobDescription} onChange={(value) => updateTarget("jobDescription", value)} placeholder="Paste the posting if you have it" multiline />
        </div>
        {researching && (researchEvents.length > 0 || researchPanelDue) ? (
          <ResearchProgressPanel
            company={input.company}
            startedAtMs={researchStartedAtMs}
            events={researchEvents}
            onCancel={cancelResearch}
          />
        ) : (
          <div className="db-interview-builder-footer">
            <button
              type="button"
              disabled={!canResearch || researching}
              onClick={() => void runResearch()}
            >
              {researching ? (
                <Loader2 size={15} className="db-interview-spin" aria-hidden />
              ) : (
                <Search size={15} aria-hidden />
              )}
              {researching
                ? "Researching company"
                : research
                  ? "Research again"
                  : "Research company"}
            </button>
          </div>
        )}
      </section>

      {research && <CompanyDossier research={research} />}

      {research && (
        <section className="db-interview-builder db-interview-candidate-builder">
          <div className="db-interview-section-head">
            <div>
              <span className="db-interview-step-label">Step 2</span>
              <h2>Add the evidence Aura may use about you</h2>
              <p>Everything here is optional. Aura will ask you to confirm candidate claims before using them.</p>
            </div>
          </div>

          <ResumeImport value={input.resume} onChange={(value) => update("resume", value)} />

          <details className="db-interview-optional" open>
            <summary>Candidate highlights and metrics <span>Optional</span></summary>
            <div className="db-interview-grid db-interview-grid-two">
              <Field label="Candidate highlights" value={input.candidateFacts} onChange={(value) => update("candidateFacts", value)} placeholder="One fact about your experience per line" multiline />
              <Field label="Measurable results" value={input.metrics} onChange={(value) => update("metrics", value)} placeholder="One metric per line" multiline />
            </div>
          </details>

          <details className="db-interview-optional">
            <summary>Stories and truth boundaries <span>Optional</span></summary>
            <div className="db-interview-grid db-interview-grid-three">
              <Field label="STAR stories" value={input.starStories} onChange={(value) => update("starStories", value)} placeholder="Situation, task, action and result. Separate stories with a blank line." multiline />
              <Field label="Known gaps" value={input.gaps} onChange={(value) => update("gaps", value)} placeholder="Skills or experience you do not have" multiline />
              <Field label="Never claim" value={input.doNotClaim} onChange={(value) => update("doNotClaim", value)} placeholder="Claims Aura must never make" multiline />
            </div>
          </details>

          <div className="db-interview-final-row">
            <div className="db-interview-field db-interview-length">
              <span>Preferred answer length</span>
              <SegmentedChoice
                options={ANSWER_LENGTH_OPTIONS}
                value={input.answerLength}
                onChange={(value) => update("answerLength", value)}
                ariaLabel="Preferred answer length"
              />
            </div>
            <div className="db-interview-field db-interview-length">
              <span>Usual round</span>
              <SegmentedChoice
                options={ROUND_KIND_OPTIONS}
                value={currentInterview.lastRoundKind ?? DEFAULT_ROUND_KIND}
                onChange={(value) => updateProfile({ lastRoundKind: value })}
                ariaLabel="Usual round"
              />
            </div>
            <div className="db-interview-field db-interview-length">
              <span>Planned length</span>
              <SegmentedChoice
                options={PLANNED_MINUTES_OPTIONS.map((option) => ({
                  ...option,
                  value: String(option.value),
                }))}
                value={String(currentInterview.plannedMinutes ?? DEFAULT_PLANNED_MINUTES)}
                onChange={(value) => updateProfile({
                  plannedMinutes: Number(value) as typeof DEFAULT_PLANNED_MINUTES,
                })}
                ariaLabel="Planned length"
              />
            </div>
            <div className="db-interview-builder-footer">
              <button type="button" disabled={!canBuild} onClick={() => void build()}>
                {building ? "Building brief" : brief ? "Rebuild brief" : "Build interview brief"}
              </button>
            </div>
          </div>
        </section>
      )}

      {brief && (
        <BriefReview
          brief={brief}
          activeBriefId={activeBriefId}
          saving={saving}
          onChange={(next) => updateInterview(currentInterview.interviewId, (interview) => ({
            ...interview,
            draftBrief: { ...next, reviewedAtMs: null },
          }))}
          onUse={() => void useBrief()}
        />
      )}
        </div>
      ) : null}
      </div>
    </div>
  );
}
