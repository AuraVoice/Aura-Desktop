import { useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import {
  allBriefClaims,
  preparationSources,
  withClaimVerification,
  type InterviewAnswerLength,
  type InterviewBrief,
  type InterviewBriefClaim,
  type InterviewPreparationInput,
} from "../../lib/interviewBrief";
import { buildInterviewBrief } from "../../lib/interviewCompanionApi";
import { loadInterviewBrief, storeInterviewBrief } from "../../lib/interviewBriefMemory";
import { logError } from "../../lib/log";
import "./InterviewPage.css";

const EMPTY_INPUT: InterviewPreparationInput = {
  company: "",
  role: "",
  resume: "",
  jobDescription: "",
  verifiedFacts: "",
  starStories: "",
  metrics: "",
  gaps: "",
  doNotClaim: "",
  answerLength: "balanced",
  questionsToAsk: "",
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
}) {
  return (
    <label className="db-interview-field">
      <span>{label}</span>
      {multiline ? (
        <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      )}
    </label>
  );
}

function ClaimRow({
  claim,
  sourceLabels,
  onVerification,
  prefix,
}: {
  claim: InterviewBriefClaim;
  sourceLabels: Map<string, string>;
  onVerification: (claimId: string, verified: boolean) => void;
  prefix?: string;
}) {
  const verified = claim.verificationState === "verified";
  return (
    <div className="db-interview-claim">
      <div>
        {prefix && <span className="db-interview-claim-prefix">{prefix}</span>}
        <p>{claim.text}</p>
        <span className="db-interview-sources">
          {claim.sourceIds.map((sourceId) => sourceLabels.get(sourceId) ?? sourceId).join(" + ")}
        </span>
      </div>
      <button
        type="button"
        className={verified ? "is-verified" : ""}
        onClick={() => onVerification(claim.claimId, !verified)}
      >
        {verified && <Check size={14} />}
        {verified ? "Verified" : "Verify"}
      </button>
    </div>
  );
}

function ClaimSection({
  title,
  claims,
  sourceLabels,
  onVerification,
}: {
  title: string;
  claims: InterviewBriefClaim[];
  sourceLabels: Map<string, string>;
  onVerification: (claimId: string, verified: boolean) => void;
}) {
  if (claims.length === 0) return null;
  return (
    <section className="db-interview-review-section">
      <h3>{title}</h3>
      <div className="db-interview-claims">
        {claims.map((claim) => (
          <ClaimRow
            key={claim.claimId}
            claim={claim}
            sourceLabels={sourceLabels}
            onVerification={onVerification}
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
  const sourceLabels = useMemo(
    () => new Map(brief.sources.map((source) => [source.sourceId, source.label])),
    [brief.sources],
  );
  const onVerification = (claimId: string, verified: boolean) =>
    onChange(withClaimVerification(brief, claimId, verified ? "verified" : "unverified"));
  const claims = allBriefClaims(brief);
  const verifiedCount = claims.filter((claim) => claim.verificationState === "verified").length;
  const isActive = activeBriefId === brief.briefId && brief.reviewedAtMs !== null;

  return (
    <section className="db-interview-review">
      <div className="db-interview-review-head">
        <div>
          <span className="db-interview-eyebrow">Review the evidence</span>
          <h2>{brief.role?.text || "Interview"} at {brief.company?.text || "the company"}</h2>
          <p>Only claims marked verified can support an answer. Gaps and do-not-claim items remain hard boundaries.</p>
        </div>
        <div className="db-interview-review-count">
          <strong>{verifiedCount}</strong>
          <span>of {claims.length} verified</span>
        </div>
      </div>

      <ClaimSection title="Role context" claims={[brief.company, brief.role].filter((claim): claim is InterviewBriefClaim => claim !== null)} sourceLabels={sourceLabels} onVerification={onVerification} />
      <ClaimSection title="Verified facts" claims={brief.verifiedFacts} sourceLabels={sourceLabels} onVerification={onVerification} />
      <ClaimSection title="Projects" claims={brief.projects} sourceLabels={sourceLabels} onVerification={onVerification} />

      {brief.starStories.length > 0 && (
        <section className="db-interview-review-section">
          <h3>STAR stories</h3>
          <div className="db-interview-stories">
            {brief.starStories.map((story) => (
              <article key={story.storyId}>
                <h4>{story.title}</h4>
                <ClaimRow claim={story.situation} prefix="Situation" sourceLabels={sourceLabels} onVerification={onVerification} />
                <ClaimRow claim={story.task} prefix="Task" sourceLabels={sourceLabels} onVerification={onVerification} />
                <ClaimRow claim={story.action} prefix="Action" sourceLabels={sourceLabels} onVerification={onVerification} />
                <ClaimRow claim={story.result} prefix="Result" sourceLabels={sourceLabels} onVerification={onVerification} />
              </article>
            ))}
          </div>
        </section>
      )}

      <ClaimSection title="Metrics" claims={brief.metrics} sourceLabels={sourceLabels} onVerification={onVerification} />
      <ClaimSection title="Job requirements" claims={brief.jdRequirements} sourceLabels={sourceLabels} onVerification={onVerification} />
      <ClaimSection title="Gaps" claims={brief.gaps} sourceLabels={sourceLabels} onVerification={onVerification} />
      <ClaimSection title="Do not claim" claims={brief.doNotClaim} sourceLabels={sourceLabels} onVerification={onVerification} />
      <ClaimSection title="Questions to ask" claims={brief.questionsToAsk} sourceLabels={sourceLabels} onVerification={onVerification} />

      <div className="db-interview-review-footer">
        <span>
          <ShieldCheck size={16} />
          {activeBriefId && !isActive
            ? "Your previous reviewed brief remains in use until you apply these changes."
            : "This brief stays in Aura's memory and is lost when the app closes."}
        </span>
        <button type="button" disabled={saving || isActive} onClick={onUse}>
          {saving ? <LoaderCircle size={16} /> : <Check size={16} />}
          {isActive ? "Brief in use" : saving ? "Saving" : "Use reviewed brief"}
        </button>
      </div>
    </section>
  );
}

export function InterviewPage() {
  const [input, setInput] = useState<InterviewPreparationInput>(EMPTY_INPUT);
  const [brief, setBrief] = useState<InterviewBrief | null>(null);
  const [activeBriefId, setActiveBriefId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    loadInterviewBrief()
      .then((saved) => {
        if (!active || !saved) return;
        setBrief(saved);
        setActiveBriefId(saved.briefId);
      })
      .catch((err) => logError("InterviewPage: load brief", err));
    return () => { active = false; };
  }, []);

  const update = (key: keyof InterviewPreparationInput, value: string) =>
    setInput((current) => ({ ...current, [key]: value }));

  const sources = preparationSources(input);
  const canBuild = sources.length > 0 && !building;

  async function build() {
    if (!canBuild) return;
    setBuilding(true);
    setError("");
    try {
      setBrief(await buildInterviewBrief(sources, input.answerLength));
    } catch (err) {
      logError("InterviewPage: build brief", err);
      setError("Aura could not build the brief. Your preparation text is still here, so you can try again.");
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
      setActiveBriefId(reviewed.briefId);
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
        <span className="db-interview-eyebrow">Interview preparation</span>
        <h1>Give Aura the truth you want beside you.</h1>
        <p>Build a source-backed brief before the call, review every claim, then use it for concise answers in the notch.</p>
      </header>

      <section className="db-interview-builder">
        <div className="db-interview-grid db-interview-grid-two">
          <Field label="Company" value={input.company} onChange={(value) => update("company", value)} placeholder="Acme" />
          <Field label="Role" value={input.role} onChange={(value) => update("role", value)} placeholder="Senior product engineer" />
        </div>
        <div className="db-interview-grid db-interview-grid-two">
          <Field label="Resume" value={input.resume} onChange={(value) => update("resume", value)} placeholder="Paste your resume" multiline />
          <Field label="Job description" value={input.jobDescription} onChange={(value) => update("jobDescription", value)} placeholder="Paste the job description" multiline />
        </div>
        <div className="db-interview-grid db-interview-grid-three">
          <Field label="Verified facts" value={input.verifiedFacts} onChange={(value) => update("verifiedFacts", value)} placeholder="One confirmed fact per line" multiline />
          <Field label="Metrics" value={input.metrics} onChange={(value) => update("metrics", value)} placeholder="One measurable result per line" multiline />
          <Field label="Gaps" value={input.gaps} onChange={(value) => update("gaps", value)} placeholder="Skills or experience you do not have" multiline />
        </div>
        <div className="db-interview-grid db-interview-grid-two">
          <Field label="STAR stories" value={input.starStories} onChange={(value) => update("starStories", value)} placeholder="Separate stories with a blank line. Include situation, task, action, and result." multiline />
          <Field label="Do not claim" value={input.doNotClaim} onChange={(value) => update("doNotClaim", value)} placeholder="One claim Aura must never make per line" multiline />
        </div>
        <div className="db-interview-grid db-interview-grid-two db-interview-final-inputs">
          <Field label="Questions to ask" value={input.questionsToAsk} onChange={(value) => update("questionsToAsk", value)} placeholder="One grounded panel question per line" multiline />
          <label className="db-interview-field">
            <span>Preferred answer length</span>
            <select value={input.answerLength} onChange={(event) => update("answerLength", event.target.value as InterviewAnswerLength)}>
              <option value="brief">Brief</option>
              <option value="balanced">Balanced</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>
        </div>
        <div className="db-interview-builder-footer">
          <span><ShieldCheck size={16} /> Resume, job description, brief, and call transcript are not written to disk.</span>
          <button type="button" disabled={!canBuild} onClick={() => void build()}>
            {building && <LoaderCircle size={16} />}
            {building ? "Building brief" : brief ? "Rebuild brief" : "Build brief"}
          </button>
        </div>
      </section>

      {error && <div className="db-interview-error"><CircleAlert size={17} />{error}</div>}
      {brief && (
        <BriefReview
          brief={brief}
          activeBriefId={activeBriefId}
          saving={saving}
          onChange={(next) => {
            setBrief({ ...next, reviewedAtMs: null });
          }}
          onUse={() => void useBrief()}
        />
      )}
    </div>
  );
}
