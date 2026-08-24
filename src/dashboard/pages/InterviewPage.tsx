import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  buildInterviewBrief,
  researchInterviewCompany,
} from "../../lib/interviewCompanionApi";
import { loadInterviewBrief, storeInterviewBrief } from "../../lib/interviewBriefMemory";
import {
  loadInterviewWorkspace,
  saveInterviewWorkspace,
} from "../../lib/interviewWorkspace";
import { logError } from "../../lib/log";
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
        <button
          type="button"
          key={`${source.url}:${index}`}
          onClick={() => void openUrl(source.url).catch((err) => logError("InterviewPage: open source", err))}
        >
          {source.title}
        </button>
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

function ResumeImport({
  value,
  onChange,
  onError,
}: {
  value: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const useText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onError("Aura could not find resume text to import.");
      return;
    }
    if (trimmed.length > 12_000) {
      onError("This resume is over 12,000 characters. Import a focused version for this role.");
      return;
    }
    onError("");
    onChange(trimmed);
  };
  const importClipboard = () => {
    void navigator.clipboard.readText()
      .then(useText)
      .catch((err) => {
        logError("InterviewPage: import resume clipboard", err);
        onError("Aura could not read the clipboard. Choose a text file instead.");
      });
  };
  return (
    <div className={`db-interview-resume${value ? " has-resume" : ""}`}>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.md,text/plain,text/markdown"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void file.text().then(useText).catch((err) => {
            logError("InterviewPage: import resume file", err);
            onError("Aura could not read that resume file.");
          });
          event.target.value = "";
        }}
      />
      <div>
        <strong>{value ? "Resume ready" : "Add your resume"}</strong>
        <span>{value ? `${value.split(/\s+/).length} words imported` : "Optional"}</span>
      </div>
      {value ? (
        <button type="button" className="db-interview-remove-button" onClick={() => onChange("")}>Remove</button>
      ) : (
        <div className="db-interview-resume-actions">
          <button type="button" onClick={importClipboard}>Import clipboard</button>
          <button type="button" onClick={() => inputRef.current?.click()}>Choose text file</button>
        </div>
      )}
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
          <button
            type="button"
            key={`${url}:${urlIndex}`}
            onClick={() => void openUrl(url).catch((err) => logError("InterviewPage: open brief source", err))}
          >
            {source.label}{source.urls.length > 1 ? ` ${urlIndex + 1}` : ""}
          </button>
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

export function InterviewPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [input, setInput] = useState<InterviewPreparationInput>(EMPTY_INPUT);
  const [research, setResearch] = useState<CompanyResearchResult | null>(null);
  const [brief, setBrief] = useState<InterviewBrief | null>(null);
  const [activeBrief, setActiveBrief] = useState<InterviewBrief | null>(null);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [researching, setResearching] = useState(false);
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const persistenceRevision = useRef(0);
  const activeBriefId = activeBrief?.briefId ?? null;

  useEffect(() => {
    let active = true;
    persistenceRevision.current += 1;
    setPersistenceReady(false);
    setInput(EMPTY_INPUT);
    setResearch(null);
    setBrief(null);
    setActiveBrief(null);
    if (!uid) return () => { active = false; };
    void (async () => {
      const workspace = await loadInterviewWorkspace(uid);
      const memoryBrief = await loadInterviewBrief().catch((err) => {
        logError("InterviewPage: load active brief", err);
        return null;
      });
      if (!active) return;
      const restoredActive = memoryBrief ?? workspace?.activeBrief ?? null;
      setInput(workspace?.input ?? EMPTY_INPUT);
      setResearch(workspace?.research ?? null);
      setBrief(workspace?.draftBrief ?? restoredActive);
      setActiveBrief(restoredActive);
      if (!memoryBrief && restoredActive?.reviewedAtMs != null) {
        await storeInterviewBrief(restoredActive);
      }
      if (!active) return;
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
      void saveInterviewWorkspace(uid, {
        input,
        research,
        draftBrief: brief,
        activeBrief,
      }).then((saved) => {
        if (!saved && persistenceRevision.current === revision) {
          setError("Aura could not save your preparation on this device.");
        }
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeBrief, brief, input, persistenceReady, research, uid]);

  const update = (key: keyof InterviewPreparationInput, value: string) =>
    setInput((current) => ({ ...current, [key]: value }));
  const updateTarget = (key: "company" | "companyUrl" | "role" | "jobDescription", value: string) => {
    update(key, value);
    setResearch(null);
  };
  const canResearch = input.company.trim().length > 0 && !researching;
  const canBuild = Boolean(research) && !building;

  async function runResearch() {
    if (!canResearch) return;
    if (input.companyUrl.trim()) {
      try {
        const companyUrl = new URL(input.companyUrl.trim());
        if (companyUrl.protocol !== "http:" && companyUrl.protocol !== "https:") {
          throw new Error("Unsupported company website protocol");
        }
      } catch {
        setError("Enter the full company website, including https://, or leave it blank.");
        return;
      }
    }
    setResearching(true);
    setError("");
    try {
      setResearch(await researchInterviewCompany({
        company: input.company,
        companyUrl: input.companyUrl,
        role: input.role,
        jobDescription: input.jobDescription,
      }));
    } catch (err) {
      logError("InterviewPage: company research", err);
      setError("Aura could not complete the company research. Your inputs are still here, so you can try again.");
    } finally {
      setResearching(false);
    }
  }

  async function build() {
    if (!canBuild || !research) return;
    setBuilding(true);
    setError("");
    try {
      setBrief(await buildInterviewBrief(preparationSources(input, research), input.answerLength));
    } catch (err) {
      logError("InterviewPage: build brief", err);
      setError("Aura could not build the interview brief. Your preparation is still here, so you can try again.");
    } finally {
      setBuilding(false);
    }
  }

  async function useBrief() {
    if (!brief) return;
    const reviewed = { ...brief, reviewedAtMs: Date.now() };
    setSaving(true);
    setError("");
    try {
      await storeInterviewBrief(reviewed);
      setBrief(reviewed);
      setActiveBrief(reviewed);
    } catch (err) {
      logError("InterviewPage: store brief", err);
      setError("Aura could not keep this brief in memory.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="db-page db-page-wide db-interview-page">
      <header className="db-interview-intro">
        <span className="db-interview-eyebrow">Interview Companion</span>
        <h1>Walk in knowing the company and your own evidence.</h1>
        <p>Aura researches the target once, shows you every source, then keeps company context separate from claims about your experience.</p>
      </header>

      <section className="db-interview-builder">
        <div className="db-interview-section-head">
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
        <div className="db-interview-builder-footer">
          <button type="button" disabled={!canResearch} onClick={() => void runResearch()}>
            {researching ? "Researching company" : research ? "Research again" : "Research company"}
          </button>
        </div>
      </section>

      {error && <div className="db-interview-error">{error}</div>}
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

          <ResumeImport value={input.resume} onChange={(value) => update("resume", value)} onError={setError} />

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
            <label className="db-interview-field">
              <span>Preferred answer length</span>
              <select value={input.answerLength} onChange={(event) => update("answerLength", event.target.value as InterviewAnswerLength)}>
                <option value="brief">Brief</option>
                <option value="balanced">Balanced</option>
                <option value="detailed">Detailed</option>
              </select>
            </label>
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
          onChange={(next) => setBrief({ ...next, reviewedAtMs: null })}
          onUse={() => void useBrief()}
        />
      )}

    </div>
  );
}
