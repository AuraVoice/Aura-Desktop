import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clipboard,
  Globe2,
  LoaderCircle,
  MoreHorizontal,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  answerResearch,
  cancelResearch,
  deleteResearch,
  getResearchActivity,
  getResearchRun,
  listResearchRuns,
  startResearch,
  type ResearchActivity,
  type ResearchActivitySource,
  type ResearchClaim,
  type ResearchEvidence,
  type ResearchRun,
} from "../../lib/researchApi";
import { logError } from "../../lib/log";
import { EmptyState } from "../components/EmptyState";
import { PageError } from "../components/PageError";
import { SiteIcon } from "../components/SiteIcon";
import { RefreshIndicator } from "../components/RefreshIndicator";
import { shortDateTime } from "../format";
import { useDashboardResource } from "../useDashboardResource";

const activeStates = new Set(["planning", "queued", "searching", "reading", "verifying", "synthesizing"]);
const terminalStates = new Set(["ready", "partial", "failed", "cancelled"]);
const stateLabels: Record<string, string> = {
  planning: "Planning",
  awaiting_clarification: "Needs your answer",
  queued: "Queued",
  searching: "Searching the web",
  reading: "Reading sources",
  verifying: "Checking claims",
  synthesizing: "Writing your brief",
  ready: "Ready",
  partial: "Ready with gaps",
  failed: "Could not finish",
  cancelled: "Cancelled",
};
const starterPrompts = [
  "Compare tools",
  "Investigate a company",
  "Research a market",
];
const starterCopy: Record<string, string> = {
  "Compare tools": "Compare the best tools for ",
  "Investigate a company": "Investigate ",
  "Research a market": "Research the current market for ",
};
const progressSteps = ["searching", "reading", "verifying", "synthesizing"];

type SelectedEvidence = ResearchEvidence & { claim: string };

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

function sourceDomain(source: ResearchActivitySource): string {
  return source.domain || domainFromUrl(source.finalUrl || source.url);
}

function SourceMark({ domain, small = false }: { domain: string; small?: boolean }) {
  const clean = domain.replace(/^www\./, "");
  return small
    ? <SiteIcon host={clean} size={26} radius="7px" letters={1} />
    : <SiteIcon host={clean} size={34} radius="9px" letters={1} />;
}

function isLegacyParked(run: ResearchRun): boolean {
  // awaiting_clarification is deliberately NOT legacy-parked: those runs have
  // a live pending question and render the answer card below instead of the
  // "restart this older request" dead end they used to fall into.
  return (
    run.state === "queued"
    && run.currentPlanVersion > 0
    && run.admittedPlanVersion === 0
    && !run.autoAdmitRequested
  );
}

function researchTitle(run: ResearchRun): string {
  const normalized = (run.plan.objective || run.request).replace(/\s+/g, " ").trim();
  const scopeBoundary = normalized.search(/\bresearch requirements?:/i);
  const title = scopeBoundary > 0 ? normalized.slice(0, scopeBoundary).trim() : normalized;
  if (title.length <= 110) return title;
  const clipped = title.slice(0, 110);
  const wordBoundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, wordBoundary > 72 ? wordBoundary : 110).trim()}...`;
}

function runStatus(run: ResearchRun) {
  if (isLegacyParked(run)) return <span className="db-research-status is-legacy">Not started</span>;
  return <StatusPill state={run.state} />;
}

function failureMessage(code: string): string {
  const messages: Record<string, string> = {
    research_requires_paid: "Background research requires an active paid plan.",
    research_cap_reached: "Today's research allowance has been used. Try again tomorrow.",
    cost_cap_reached: "The research spend limit stopped this run before a sourced brief was available.",
  };
  return messages[code] || (code ? code.replace(/_/g, " ") : "No usable evidence survived verification.");
}

function StatusPill({ state }: { state: string }) {
  return <span className={`db-research-status is-${state}`}>{stateLabels[state] ?? state}</span>;
}

function sourceStatus(source: ResearchActivitySource): { label: string; tone: string } {
  if (source.injectionSuspected) return { label: "Quarantined", tone: "warning" };
  if (source.state === "read") return { label: "Read", tone: "complete" };
  if (source.state === "unusable" || source.state === "failed") return { label: "Skipped", tone: "warning" };
  if (source.state === "cancelled") return { label: "Cancelled", tone: "muted" };
  return { label: "Queued", tone: "active" };
}

function ProgressRail({ state }: { state: string }) {
  const current = Math.max(0, progressSteps.indexOf(state));
  return (
    <ol className="db-research-stage-rail" aria-label="Research progress">
      {progressSteps.map((step, index) => {
        const complete = progressSteps.includes(state) && index < current;
        const active = step === state;
        return (
          <li key={step} className={complete ? "is-complete" : active ? "is-active" : ""}>
            <span>{complete ? <Check size={12} /> : active ? <LoaderCircle size={13} /> : index + 1}</span>
            {stateLabels[step]}
          </li>
        );
      })}
    </ol>
  );
}

function ResearchActivityView({ run, activity }: { run: ResearchRun; activity: ResearchActivity | null }) {
  const sources = activity?.sources ?? [];
  const grouped = useMemo(() => {
    const groups = new Map<string, ResearchActivitySource[]>();
    for (const source of sources) {
      const query = source.query || "Sources selected for this research";
      groups.set(query, [...(groups.get(query) ?? []), source]);
    }
    return [...groups.entries()];
  }, [sources]);
  const readCount = sources.filter((source) => source.state === "read").length;
  const candidateCount = sources.reduce((total, source) => total + source.candidateCount, 0);

  return (
    <div className="db-research-live-shell">
      <section className="db-research-live-main" aria-label="Live research activity">
        <div className="db-research-live-head">
          <div>
            <span className="db-research-live-kicker"><span /> Live activity</span>
            <h2>{stateLabels[run.state]}</h2>
          </div>
          <div className="db-research-live-counts" aria-label="Research counts">
            <span><strong>{sources.length || run.sourceCount}</strong> discovered</span>
            <span><strong>{readCount}</strong> read</span>
            <span><strong>{candidateCount || run.claimCount}</strong> claims</span>
          </div>
        </div>

        {grouped.length === 0 ? (
          <div className="db-research-activity-empty">
            <span className="db-research-orbit" aria-hidden><Search size={18} /></span>
            <div>
              <strong>{run.state === "queued" ? "Queued to begin searching" : run.state === "searching" ? "Finding the strongest starting points" : "Preparing the next research step"}</strong>
              <span>{run.state === "queued" ? "The plan is ready. Research will begin as soon as a worker is available." : "Queries and sources will appear here as soon as they are committed."}</span>
            </div>
          </div>
        ) : (
          <div className="db-research-query-list">
            {grouped.map(([query, querySources], queryIndex) => (
              <details className="db-research-query" key={query} open={queryIndex < 2}>
                <summary>
                  <span className="db-research-query-icon"><Search size={15} /></span>
                  <span><small>Search query</small><strong>{query}</strong></span>
                  <span className="db-research-query-total">{querySources.length} sources <ChevronDown size={15} /></span>
                </summary>
                <div className="db-research-query-sources">
                  {querySources.map((source) => {
                    const status = sourceStatus(source);
                    const domain = sourceDomain(source);
                    const target = source.finalUrl || source.url;
                    return (
                      <button
                        type="button"
                        key={source.sourceId || target}
                        className={`db-research-source-row is-${status.tone}`}
                        disabled={!target}
                        onClick={() => target && void openUrl(target).catch((err) => logError("ResearchPage: open live source", err))}
                      >
                        <SourceMark domain={domain} />
                        <span className="db-research-source-copy">
                          <strong>{source.title || domain}</strong>
                          <small>{domain} · {source.sourceClass.replace(/_/g, " ")}</small>
                        </span>
                        <span className="db-research-source-status"><span /> {status.label}</span>
                        <ArrowUpRight size={14} aria-hidden />
                      </button>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>

      <aside className="db-research-live-aside">
        <div className="db-research-aside-section">
          <span className="db-research-aside-label">Research plan</span>
          <ProgressRail state={run.state} />
          <div className="db-research-question-progress">
            {run.plan.subQuestions.slice(0, 5).map((item, index) => (
              <div key={String(item.sub_question_id ?? index)}>
                {run.state === "verifying" || run.state === "synthesizing" ? <CheckCircle2 size={15} /> : index === 0 ? <LoaderCircle size={15} /> : <Circle size={15} />}
                <span>{String(item.text ?? "")}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="db-research-aside-section db-research-evidence-meter">
          <span className="db-research-aside-label">Evidence</span>
          <strong>{readCount} usable source{readCount === 1 ? "" : "s"}</strong>
          <span>{candidateCount || run.claimCount} candidate claims found</span>
          <div><span style={{ width: `${Math.min(100, Math.max(8, sources.length ? (readCount / sources.length) * 100 : 8))}%` }} /></div>
        </div>
        <p className="db-research-background-note"><ShieldCheck size={15} /> Safe to close Aura. The run continues in the background.</p>
      </aside>
    </div>
  );
}

function LegacyParkedRun({ run, onRestart }: { run: ResearchRun; onRestart: (request: string) => void }) {
  return (
    <section className="db-research-legacy">
      <div>
        <span className="db-research-section-kicker">Not started</span>
        <h2>This older request never reached web research</h2>
        <p>No sources were searched and no research credit was used. Restart it to use the new automatic background flow.</p>
        <div className="db-research-plan-list">
          {run.plan.subQuestions.map((item, index) => (
            <div key={String(item.sub_question_id ?? index)}><span>{index + 1}</span><p>{String(item.text ?? "")}</p></div>
          ))}
        </div>
        {run.plan.assumptions.length > 0 && (
          <div className="db-research-assumptions">
            <strong>Assumptions</strong>
            {run.plan.assumptions.map((item) => <span key={item}>{item}</span>)}
          </div>
        )}
      </div>
      <button type="button" className="db-research-primary" onClick={() => onRestart(run.request)}><RotateCcw size={16} /> Restart research</button>
    </section>
  );
}

function PendingQuestionCard({ run, busy, onAnswer }: { run: ResearchRun; busy: boolean; onAnswer: (answerText: string) => void }) {
  const question = run.pendingQuestion;
  const text = String(question.text ?? "").trim();
  const choices = Array.isArray(question.choices) ? question.choices.filter(Boolean) : [];
  const defaults = Array.isArray(question.default_assumptions) ? question.default_assumptions.filter(Boolean) : [];
  const [customAnswer, setCustomAnswer] = useState("");
  if (!text) return null;
  return (
    <section className="db-research-legacy db-research-question">
      <div>
        <span className="db-research-section-kicker">Needs your answer</span>
        <h2>{text}</h2>
        <p>The research is paused until you answer. Pick an option, type your own, or let Buddy proceed on the stated assumptions.</p>
        {choices.length > 0 && (
          <div className="db-research-plan-list">
            {choices.map((choice, index) => (
              <div key={choice}>
                <span>{index + 1}</span>
                <button type="button" className="db-research-secondary" disabled={busy} onClick={() => onAnswer(choice)}>{choice}</button>
              </div>
            ))}
          </div>
        )}
        <div className="db-research-command">
          <input
            type="text"
            value={customAnswer}
            placeholder="Or type an answer"
            disabled={busy}
            onChange={(event) => setCustomAnswer(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && customAnswer.trim()) onAnswer(customAnswer.trim()); }}
          />
          <button type="button" className="db-research-primary" disabled={busy || !customAnswer.trim()} onClick={() => onAnswer(customAnswer.trim())}>Answer</button>
        </div>
        {defaults.length > 0 && (
          <div className="db-research-assumptions">
            <strong>Or proceed assuming</strong>
            {defaults.map((item) => <span key={item}>{item}</span>)}
            <button type="button" className="db-research-secondary" disabled={busy} onClick={() => onAnswer(defaults.join("; "))}>Use these assumptions</button>
          </div>
        )}
      </div>
    </section>
  );
}

function CitationButton({ number, evidence, claim, onSelect }: { number: number; evidence: ResearchEvidence; claim: string; onSelect: (value: SelectedEvidence) => void }) {
  return <button type="button" className="db-research-citation" onClick={() => onSelect({ ...evidence, claim })} aria-label={`Open source ${number}`}>{number}</button>;
}

function BriefView({ run, onNewRequest }: { run: ResearchRun; onNewRequest: (request: string) => void }) {
  const [selected, setSelected] = useState<SelectedEvidence | null>(null);
  const [copied, setCopied] = useState(false);
  const claimMap = useMemo(() => new Map(run.claims.map((claim) => [claim.claimId, claim])), [run.claims]);
  const sourceNumbers = useMemo(() => {
    const urls = new Map<string, number>();
    for (const claim of run.claims) for (const evidence of claim.evidence) if (evidence.url && !urls.has(evidence.url)) urls.set(evidence.url, urls.size + 1);
    return urls;
  }, [run.claims]);
  const sections = run.brief.sections ?? [];
  const copyBrief = async () => {
    const text = [run.brief.executive_summary, ...sections.flatMap((section) => [section.heading, ...(section.statements ?? []).map((statement) => statement.text)])].filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    } catch (err) {
      logError("ResearchPage: copy brief", err);
    }
  };
  const scrollToSection = (sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const sources = run.claims.flatMap((claim) => claim.evidence.map((evidence) => ({ ...evidence, claim: claim.text }))).filter((item, index, all) => item.url && all.findIndex((candidate) => candidate.url === item.url) === index);

  return (
    <div className="db-research-report-layout">
      <nav className="db-research-report-nav" aria-label="Brief sections">
        <span className="db-research-aside-label">In this brief</span>
        <button type="button" onClick={() => scrollToSection("research-summary")}>Summary</button>
        {sections.map((section, index) => <button type="button" key={`${index}:${section.heading}`} onClick={() => scrollToSection(`research-section-${index}`)}>{section.heading || `Finding ${index + 1}`}</button>)}
        {run.gaps.length > 0 && <button type="button" onClick={() => scrollToSection("research-gaps")}>Open questions</button>}
        <button type="button" onClick={() => scrollToSection("research-sources")}>Sources</button>
      </nav>

      <article className="db-research-report">
        <section id="research-summary" className="db-research-report-summary">
          <span className="db-research-section-kicker">Executive summary</span>
          <p>{run.brief.executive_summary}</p>
          <div className="db-research-report-meta"><span><Globe2 size={15} /> {sources.length} sources</span><span><ShieldCheck size={15} /> {run.claimCount} checked claims</span></div>
        </section>
        {sections.map((section, index) => (
          <section id={`research-section-${index}`} className="db-research-report-section" key={`${index}:${section.heading}`}>
            <h2>{section.heading}</h2>
            {section.statements?.map((statement, statementIndex) => {
              const claims = (statement.claim_ids ?? []).map((id) => claimMap.get(id)).filter((claim): claim is ResearchClaim => Boolean(claim));
              const evidence = claims.flatMap((claim) => claim.evidence.map((item) => ({ item, claim: claim.text })));
              return (
                <p key={statementIndex}>
                  {statement.text}
                  {evidence.map(({ item, claim }, evidenceIndex) => <CitationButton key={`${statementIndex}:${evidenceIndex}:${item.url}`} number={sourceNumbers.get(item.url) ?? 0} evidence={item} claim={claim} onSelect={setSelected} />)}
                </p>
              );
            })}
          </section>
        ))}
        {run.gaps.length > 0 && (
          <section id="research-gaps" className="db-research-report-gaps">
            <span className="db-research-section-kicker">What remains unclear</span>
            <h2>Open questions</h2>
            {run.gaps.map((gap, index) => (
              <div key={index}><CircleAlert size={17} /><span>{String(gap.detail || gap.reason || "This could not be established from available sources.")}</span><button type="button" onClick={() => onNewRequest(`Research this unresolved question: ${String(gap.detail || gap.reason || "")}`)}>Research this gap</button></div>
            ))}
          </section>
        )}
        {run.brief.disclaimers?.map((item) => <p className="db-research-disclaimer" key={item}>{item}</p>)}
        <section id="research-sources" className="db-research-report-sources">
          <h2>Sources</h2>
          {sources.map((item) => {
            const domain = domainFromUrl(item.url);
            return (
              <button type="button" key={item.url} onClick={() => setSelected(item)}>
                <SourceMark domain={domain} />
                <span><strong>{domain}</strong><small>{item.sourceClass.replace(/_/g, " ")}</small></span>
                <span>{sourceNumbers.get(item.url)}</span>
                <ChevronRight size={16} />
              </button>
            );
          })}
        </section>
      </article>

      <aside className="db-research-report-actions">
        <button type="button" onClick={() => void copyBrief()}>{copied ? <Check size={16} /> : <Clipboard size={16} />} {copied ? "Copied" : "Copy brief"}</button>
        <button type="button" onClick={() => onNewRequest(`Continue researching: ${run.request}`)}><RotateCcw size={16} /> Related research</button>
      </aside>

      {selected && (
        <div className="db-research-source-drawer" role="dialog" aria-modal="true" aria-label="Source details">
          <button type="button" className="db-research-drawer-scrim" onClick={() => setSelected(null)} aria-label="Close source details" />
          <aside>
            <div className="db-research-drawer-head"><div><SourceMark domain={domainFromUrl(selected.url)} /><span><strong>{domainFromUrl(selected.url)}</strong><small>{selected.sourceClass.replace(/_/g, " ")}</small></span></div><button type="button" onClick={() => setSelected(null)} aria-label="Close"><X size={18} /></button></div>
            <span className="db-research-aside-label">Supports this claim</span>
            <h3>{selected.claim}</h3>
            {selected.excerpt && <blockquote>{selected.excerpt}</blockquote>}
            <button type="button" className="db-research-primary" onClick={() => void openUrl(selected.url).catch((err) => logError("ResearchPage: open source", err))}>Open source <ArrowUpRight size={15} /></button>
          </aside>
        </div>
      )}
    </div>
  );
}

function ResearchDetail({ runId, onBack, onChanged, onNewRequest }: { runId: string; onBack: () => void; onChanged: () => void; onNewRequest: (request: string) => void }) {
  const resource = useDashboardResource(`research:${runId}`, (signal) => getResearchRun(runId, signal), { freshnessMs: 2_000 });
  const activity = useDashboardResource(`research-activity:${runId}`, (signal) => getResearchActivity(runId, signal), { freshnessMs: 1_500 });
  const run = resource.data;
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!run || !activeStates.has(run.state)) return;
    const tick = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        resource.reload();
        activity.reload();
      }
    };
    const interval = setInterval(tick, 2_500);
    return () => clearInterval(interval);
  }, [run?.state, resource.reload, activity.reload]);

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setOperationError("");
    try {
      await operation();
      resource.reload();
      activity.reload();
      onChanged();
    } catch (err) {
      setOperationError("Buddy could not update this research. Check your connection and try again.");
      logError("ResearchPage: operation", err);
    } finally {
      setBusy(false);
    }
  };

  if (resource.loading) return <div className="db-research-detail-skeleton" aria-label="Loading research"><span /><span /><span /></div>;
  if (!run) return <PageError authExpired={resource.authExpired} onRetry={resource.reload} />;
  const legacyParked = isLegacyParked(run);
  const title = researchTitle(run);

  return (
    <div className="db-page db-page-wide db-research-page">
      <div className="db-research-detail-bar">
        <button type="button" className="db-research-back" onClick={onBack}><ArrowLeft size={17} /> All research</button>
        <div className="db-research-detail-tools">
          <RefreshIndicator refreshing={resource.refreshing || activity.refreshing} stale={resource.stale} cachedAt={resource.cachedAt} onRetry={() => { resource.reload(); activity.reload(); }} />
          {(activeStates.has(run.state) || run.state === "awaiting_clarification") && !legacyParked && <button type="button" className="db-research-secondary" disabled={busy} onClick={() => void mutate(() => cancelResearch(run.runId))}><X size={15} /> Cancel</button>}
          <div className="db-research-more">
            <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="More research actions" aria-expanded={menuOpen}><MoreHorizontal size={18} /></button>
            {menuOpen && <div><button type="button" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}><Trash2 size={15} /> Delete research</button></div>}
          </div>
        </div>
      </div>

      <header className="db-research-run-head">
        <div>{runStatus(run)}<h1 title={title}>{title}</h1><p>Requested {shortDateTime(run.createdAt)}</p>{title !== run.request.trim() && <details className="db-research-original-request"><summary>Original request</summary><p>{run.request}</p></details>}</div>
        {terminalStates.has(run.state) && <div className="db-research-run-summary"><span><strong>{run.sourceCount}</strong> sources</span><span><strong>{run.claimCount}</strong> claims</span></div>}
      </header>

      {operationError && <div className="db-research-inline-error"><CircleAlert size={17} /><span>{operationError}</span><button type="button" onClick={() => setOperationError("")}>Dismiss</button></div>}
      {legacyParked && <LegacyParkedRun run={run} onRestart={onNewRequest} />}
      {run.state === "awaiting_clarification" && (
        <PendingQuestionCard run={run} busy={busy} onAnswer={(answerText) => void mutate(() => answerResearch(run.runId, String(run.pendingQuestion.question_id ?? ""), answerText))} />
      )}
      {activeStates.has(run.state) && !legacyParked && <ResearchActivityView run={run} activity={activity.data ?? null} />}
      {(run.state === "ready" || run.state === "partial") && <BriefView run={run} onNewRequest={onNewRequest} />}
      {run.state === "failed" && <section className="db-research-terminal is-failed"><CircleAlert size={22} /><div><span className="db-research-section-kicker">Research stopped</span><h2>Buddy could not produce a source-backed brief</h2><p>{failureMessage(run.failureCode)}</p><button type="button" className="db-research-primary" onClick={() => onNewRequest(run.request)}>Try a revised request</button></div></section>}
      {run.state === "cancelled" && <section className="db-research-terminal"><CircleAlert size={22} /><div><span className="db-research-section-kicker">Cancelled</span><h2>This research was stopped</h2><p>No further searching will be started for this run.</p><button type="button" className="db-research-primary" onClick={() => onNewRequest(run.request)}>Start again</button></div></section>}

      {confirmDelete && (
        <div className="db-research-confirm" role="dialog" aria-modal="true" aria-labelledby="research-delete-title">
          <button type="button" className="db-research-confirm-scrim" onClick={() => setConfirmDelete(false)} aria-label="Cancel deletion" />
          <div><Trash2 size={22} /><h2 id="research-delete-title">Delete this research?</h2><p>The brief, sources, and run history will be scheduled for deletion.</p><span><button type="button" className="db-research-secondary" onClick={() => setConfirmDelete(false)}>Keep it</button><button type="button" className="db-research-danger" disabled={busy} onClick={() => void mutate(async () => { await deleteResearch(run.runId); onBack(); })}>Delete research</button></span></div>
        </div>
      )}
    </div>
  );
}

function HistorySourceMarks({ run }: { run: ResearchRun }) {
  const domains = [...new Set(run.claims.flatMap((claim) => claim.evidence.map((evidence) => domainFromUrl(evidence.url))).filter(Boolean))].slice(0, 4);
  if (domains.length === 0) return <span className="db-research-history-source-count"><Globe2 size={14} /> {run.sourceCount} sources</span>;
  return <span className="db-research-history-marks">{domains.map((domain) => <SourceMark key={domain} domain={domain} small />)}{run.sourceCount > domains.length && <small>+{run.sourceCount - domains.length}</small>}</span>;
}

export function ResearchPage() {
  const list = useDashboardResource("research", listResearchRuns, { freshnessMs: 2_000 });
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("run");
  const [request, setRequest] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const runs = useMemo(() => list.data ?? [], [list.data]);
  const activeRuns = runs.filter((run) => activeStates.has(run.state) || run.state === "awaiting_clarification");
  const historyRuns = runs.filter((run) => !activeRuns.includes(run));

  const openRun = (runId: string) => setSearchParams({ run: runId });
  const closeRun = () => setSearchParams({});
  const beginRelated = (value: string) => {
    closeRun();
    setRequest(value);
    requestAnimationFrame(() => document.getElementById("research-request")?.focus());
  };
  if (selectedId) return <ResearchDetail runId={selectedId} onBack={closeRun} onChanged={list.reload} onNewRequest={beginRelated} />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!request.trim() || starting) return;
    setStarting(true);
    setStartError("");
    try {
      const run = await startResearch(request.trim());
      setRequest("");
      openRun(run.runId);
      list.reload();
    } catch (err) {
      setStartError("Buddy could not set up this research. Check your connection and try again.");
      logError("ResearchPage: start", err);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="db-page db-page-wide db-research-page db-research-home">
      <section className="db-research-command">
        <div className="db-research-command-copy"><span className="db-research-eyebrow"><Sparkles size={14} /> Background research</span><h1>What do you want to understand?</h1><p>Buddy turns an open question into a source-backed brief while you keep working.</p></div>
        <form onSubmit={submit}>
          <label htmlFor="research-request">Research request</label>
          <textarea id="research-request" value={request} onChange={(event) => setRequest(event.target.value)} maxLength={2000} placeholder="Compare speech-to-text APIs for a Windows app, including current pricing, streaming latency, and privacy tradeoffs." />
          <div className="db-research-composer-foot"><span>Research starts immediately and continues in the background.</span><button type="submit" className="db-research-primary" disabled={starting || !request.trim()}>{starting ? <LoaderCircle size={17} /> : <Search size={17} />} {starting ? "Starting" : "Start research"}</button></div>
        </form>
        <div className="db-research-starters" aria-label="Research starters">{starterPrompts.map((item) => <button key={item} type="button" onClick={() => { setRequest(starterCopy[item]); requestAnimationFrame(() => document.getElementById("research-request")?.focus()); }}>{item}<ChevronRight size={14} /></button>)}</div>
      </section>

      {startError && <div className="db-research-inline-error"><CircleAlert size={17} /><span>{startError}</span><button type="button" onClick={() => setStartError("")}>Dismiss</button></div>}

      {activeRuns.length > 0 && (
        <section className="db-research-active-runs">
          <div className="db-research-section-head"><div><span className="db-research-section-kicker">In progress</span><h2>Buddy is on it</h2></div><RefreshIndicator refreshing={list.refreshing} stale={list.stale} cachedAt={list.cachedAt} onRetry={list.reload} /></div>
          {activeRuns.map((run) => (
            <button type="button" key={run.runId} className="db-research-active-run" onClick={() => openRun(run.runId)}>
              <span className={`db-research-active-symbol${isLegacyParked(run) ? " is-legacy" : ""}`}>{isLegacyParked(run) ? <CircleAlert size={20} /> : <LoaderCircle size={20} />}</span>
              <span>{runStatus(run)}<strong>{researchTitle(run)}</strong><small>{isLegacyParked(run) ? "This older request never started. Open it to restart." : run.state === "planning" ? "Building the research plan." : run.state === "queued" ? "Waiting for a research worker." : "Open to view committed queries and sources."}</small></span>
              <span className="db-research-active-meta"><strong>{run.sourceCount}</strong><small>sources</small></span>
              <ChevronRight size={18} />
            </button>
          ))}
        </section>
      )}

      <section className="db-research-history">
        <div className="db-research-section-head"><div><span className="db-research-section-kicker">Library</span><h2>Past research</h2></div>{activeRuns.length === 0 && <RefreshIndicator refreshing={list.refreshing} stale={list.stale} cachedAt={list.cachedAt} onRetry={list.reload} />}</div>
        {list.error && !list.data ? <PageError authExpired={list.authExpired} onRetry={list.reload} /> : historyRuns.length === 0 ? <EmptyState Icon={BookOpen} heading="Your research library is empty" copy="Start with a question above. Finished briefs and their sources will stay here." /> : (
          <div className="db-research-history-list">
            {historyRuns.map((run) => (
              <button type="button" key={run.runId} onClick={() => openRun(run.runId)}>
                <span className={`db-research-history-icon is-${run.state}`}>{run.state === "ready" ? <CheckCircle2 size={19} /> : run.state === "partial" ? <CircleAlert size={19} /> : <BookOpen size={19} />}</span>
                <span className="db-research-history-copy">{runStatus(run)}<strong>{researchTitle(run)}</strong><small>{shortDateTime(run.updatedAt || run.createdAt)}</small></span>
                <HistorySourceMarks run={run} />
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
