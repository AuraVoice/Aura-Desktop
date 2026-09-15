import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { BookOpenText, ChevronLeft, ChevronRight, Copy, Download, Dumbbell } from "lucide-react";
import type {
  CompanyResearchResult,
  InterviewBrief,
  InterviewBriefSource,
  InterviewPrepRoom,
  PracticeMark,
  PrepAnswer,
  PrepFit,
  PrepLine,
} from "../../../lib/interviewBrief";
import { logError } from "../../../lib/log";
import { SlidingTabs, useTabStage } from "../../components/SlidingTabs";
import "./PrepRoom.css";

type PrepView = "practice" | "briefing";
type SourceMap = Map<string, InterviewBriefSource>;

// Numbers worth a second look in an answer: "8x", "p99 180 ms" -> "180 ms", "$62M", "38%".
// Deterministic on purpose: the model never marks up its own text.
const METRIC_PATTERN = /((?<![\w.])\$?\d+(?:[.,]\d+)*(?:\s?(?:%|x|ms|s|k\/s|k|m|bn|gb|mb|tb|hrs?|hours?|days?|weeks?|months?|years?))?)(?![\w])/gi;

const KIND_LABELS: Partial<Record<InterviewBriefSource["kind"], string>> = {
  company: "Company",
  role: "Role",
  resume: "Resume",
  job_description: "Job description",
  likely_interviewer_question: "Likely question",
};

const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five"];

const FIT_LABELS: Record<PrepFit["strength"], string> = {
  strong: "Strong",
  partial: "Partial",
  gap: "Gap",
};

function withMetrics(text: string): ReactNode {
  return text.split(METRIC_PATTERN).map((part, index) =>
    index % 2 === 1 ? <span key={index} className="db-prep-metric">{part}</span> : part,
  );
}

function sourceLabel(source: InterviewBriefSource): string {
  const label = KIND_LABELS[source.kind] ?? source.label;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function sourceLabels(ids: string[], sources: SourceMap): string[] {
  return [...new Set(ids.flatMap((id) => {
    const source = sources.get(id);
    return source ? [sourceLabel(source)] : [];
  }))];
}

function SourceChips({ ids, sources }: { ids: string[]; sources: SourceMap }) {
  return (
    <>
      {sourceLabels(ids, sources).map((label) => (
        <span key={label} className="db-prep-chip is-source">{label}</span>
      ))}
    </>
  );
}

function prefersReducedMotion(): boolean {
  return Boolean(document.querySelector(".db-app")?.classList.contains("db-reduce-motion"))
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function prepRoomMarkdown(company: string, meta: string, prep: InterviewPrepRoom): string {
  const out: string[] = [`# ${company}`];
  if (meta) out.push(meta);
  if (prep.companyStory.length) out.push("", "## Company in 60 seconds", ...prep.companyStory.flatMap((line) => [line.text, ""]));
  if (prep.mustKnows.length) out.push("## Must-knows", ...prep.mustKnows.map((line) => `- ${line.text}`), "");
  if (prep.answers.length) {
    out.push("## Questions and your answers");
    for (const answer of prep.answers) {
      out.push("", `### ${answer.question}`);
      if (answer.whyTheyAsk) out.push(`Why they'd ask: ${answer.whyTheyAsk}`);
      if (answer.star) {
        out.push(
          "",
          `Story: ${answer.storyTitle}`,
          `- Situation: ${answer.star.situation.text}`,
          `- Task: ${answer.star.task.text}`,
          `- Action: ${answer.star.action.text}`,
          `- Result: ${answer.star.result.text}`,
        );
      }
      if (answer.spoken) out.push("", `> ${answer.spoken}`);
      if (answer.followUp) out.push("", `Follow-up: ${answer.followUp}${answer.followUpHint ? ` (${answer.followUpHint})` : ""}`);
      if (answer.avoid) out.push(`Avoid: ${answer.avoid.text}`);
    }
    out.push("");
  }
  const strengths = prep.fit.filter((row) => row.strength !== "gap");
  const gaps = prep.fit.filter((row) => row.strength === "gap");
  if (strengths.length) out.push("## Your fit", ...strengths.map((row) => `- ${row.requirement}: ${row.evidence} (${FIT_LABELS[row.strength]})`), "");
  if (gaps.length) out.push("## Gaps and bridges", ...gaps.map((row) => `- ${row.requirement}${row.bridge ? `: ${row.bridge}` : ""}`), "");
  if (prep.neverSay.length) out.push("## Never say", ...prep.neverSay.map((item) => `- ${item}`));
  return out.join("\n").trim();
}

/**
 * The candidate-facing half of interview preparation: rehearse (Practice) or
 * read (Briefing) the same prep room. Everything shown here cites the brief's
 * sources; the live companion never reads it.
 */
export function PrepRoom({
  company,
  meta,
  prep,
  brief,
  research,
  marks,
  onMark,
}: {
  company: string;
  meta: string;
  prep: InterviewPrepRoom;
  brief: InterviewBrief;
  research: CompanyResearchResult | null;
  marks: Record<string, PracticeMark>;
  onMark: (answerId: string, mark: PracticeMark | null) => void;
}) {
  const stage = useTabStage<PrepView>("practice");
  const [note, setNote] = useState("");
  const noteTimer = useRef<number | null>(null);
  const sources = useMemo<SourceMap>(
    () => new Map(brief.sources.map((source) => [source.sourceId, source])),
    [brief.sources],
  );

  useEffect(() => () => {
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
  }, []);

  const flash = (text: string) => {
    setNote(text);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(""), 4000);
  };

  const download = async () => {
    try {
      const { path } = await invoke<{ path: string }>("save_interview_prep", {
        markdown: prepRoomMarkdown(company, meta, prep),
        company,
      });
      flash(`Saved to ${path}`);
    } catch (err) {
      logError("PrepRoom: download", err);
      flash("Aura could not save the file. Copy it as Markdown instead.");
    }
  };

  const copy = async () => {
    try {
      await writeText(prepRoomMarkdown(company, meta, prep));
      flash("Copied as Markdown");
    } catch (err) {
      logError("PrepRoom: copy", err);
      flash("Aura could not reach the clipboard.");
    }
  };

  return (
    <section className="db-prep" aria-label="Prep room">
      <header className="db-prep-head">
        <div className="db-prep-title">
          <span className="db-prep-eyebrow">Prep room</span>
          <h2>{company}</h2>
          {meta && <p>{meta}</p>}
        </div>
        <div className="db-prep-actions">
          <button type="button" className="db-prep-ghost" onClick={() => void copy()}>
            <Copy size={15} aria-hidden />
            Copy as Markdown
          </button>
          <button type="button" className="db-prep-primary" onClick={() => void download()}>
            <Download size={15} aria-hidden />
            Download
          </button>
        </div>
      </header>
      {note && <p className="db-prep-note" role="status">{note}</p>}

      <SlidingTabs
        tabs={[
          { value: "practice", label: "Practice", Icon: Dumbbell, count: prep.answers.length },
          { value: "briefing", label: "Briefing", Icon: BookOpenText },
        ]}
        value={stage.tab}
        onChange={stage.switchTab}
        ariaLabel="Prep room view"
        idPrefix="prep"
      />

      <div className={`db-tab-stage db-prep-stage is-${stage.transition}`}>
        {stage.renderedTab === "practice" ? (
          <div id="prep-practice-panel" role="tabpanel" aria-labelledby="prep-practice-tab" className="db-prep-panel">
            <PracticeDeck answers={prep.answers} sources={sources} marks={marks} onMark={onMark} />
          </div>
        ) : (
          <div id="prep-briefing-panel" role="tabpanel" aria-labelledby="prep-briefing-tab" className="db-prep-panel">
            <BriefingDocument company={company} meta={meta} prep={prep} sources={sources} research={research} />
          </div>
        )}
      </div>
    </section>
  );
}

function PracticeDeck({
  answers,
  sources,
  marks,
  onMark,
}: {
  answers: PrepAnswer[];
  sources: SourceMap;
  marks: Record<string, PracticeMark>;
  onMark: (answerId: string, mark: PracticeMark | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);

  if (answers.length === 0) {
    return (
      <p className="db-prep-empty">
        No likely questions came back for this interview. The Briefing still has the company and where you fit.
      </p>
    );
  }

  const current = Math.min(index, answers.length - 1);
  const answer = answers[current];
  const confident = answers.filter((item) => marks[item.answerId] === "confident").length;
  const circumference = 2 * Math.PI * 36;
  const mark = marks[answer.answerId];

  const move = (delta: number) => {
    setIndex((value) => (Math.min(value, answers.length - 1) + delta + answers.length) % answers.length);
    setRevealed(false);
  };
  const jump = (target: number) => {
    setIndex(target);
    setRevealed(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1);
    } else if (event.key === " " && !(event.target as HTMLElement).closest("button")) {
      event.preventDefault();
      setRevealed((value) => !value);
    }
  };

  const star = answer.star;
  const storySources = star
    ? [...star.situation.sourceIds, ...star.task.sourceIds, ...star.action.sourceIds, ...star.result.sourceIds]
    : [];
  const starRows: Array<[string, PrepLine]> = star
    ? [["S", star.situation], ["T", star.task], ["A", star.action], ["R", star.result]]
    : [];

  return (
    <div className="db-prep-deck" tabIndex={0} onKeyDown={onKeyDown} aria-label="Practice questions">
      <aside className="db-prep-progress">
        <div className="db-prep-ring" role="img" aria-label={`${confident} of ${answers.length} marked confident`}>
          <svg viewBox="0 0 84 84" aria-hidden>
            <circle className="is-track" cx="42" cy="42" r="36" />
            <circle
              className="is-fill"
              cx="42"
              cy="42"
              r="36"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - confident / answers.length)}
            />
          </svg>
          <b>{confident}<small>/{answers.length}</small></b>
        </div>
        <small className="db-prep-progress-label">Confident</small>
        <div className="db-prep-dots">
          {answers.map((item, dot) => (
            <button
              key={item.answerId}
              type="button"
              aria-label={`Question ${dot + 1}`}
              aria-current={dot === current}
              className={marks[item.answerId] ? `is-${marks[item.answerId]}` : ""}
              onClick={() => jump(dot)}
            />
          ))}
        </div>
      </aside>

      <article className="db-prep-card">
        <div className="db-prep-card-top">
          <span className="db-prep-chip">{star ? answer.storyTitle || "Your story" : "Honest answer"}</span>
          <span className="db-prep-count">{current + 1} of {answers.length}</span>
        </div>
        <h3 className="db-prep-question">{answer.question}</h3>
        {answer.whyTheyAsk && (
          <div className="db-prep-why">
            <span className="db-prep-why-label">Why they'd ask</span>
            <span>{answer.whyTheyAsk}</span>
            <SourceChips ids={answer.whySourceIds} sources={sources} />
          </div>
        )}

        {revealed ? (
          <div className="db-prep-answer">
            {star ? (
              <>
                <span className="db-prep-label">Your answer</span>
                <div className="db-prep-story">
                  {answer.storyTitle || "Your story"}
                  <SourceChips ids={storySources} sources={sources} />
                </div>
                <ul className="db-prep-star">
                  {starRows.map(([letter, line]) => (
                    <li key={letter} className={letter === "R" ? "is-result" : ""}>
                      <b aria-hidden>{letter}</b>
                      <span>{withMetrics(line.text)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="db-prep-nostory">
                None of your stories matches this question yet. Add one under Stories and truth boundaries, then rebuild.
              </p>
            )}
            {answer.spoken && (
              <>
                <span className="db-prep-label">30-second version</span>
                <p className="db-prep-spoken">{withMetrics(answer.spoken)}</p>
              </>
            )}
            {(answer.followUp || answer.avoid) && (
              <div className="db-prep-pair">
                {answer.followUp && (
                  <div>
                    <span className="db-prep-label">Likely follow-up</span>
                    {answer.followUp}
                    {answer.followUpHint && <span className="db-prep-hint">{answer.followUpHint}</span>}
                  </div>
                )}
                {answer.avoid && (
                  <div className="is-avoid">
                    <span className="db-prep-label">Avoid</span>
                    {answer.avoid.text}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <button type="button" className="db-prep-reveal" onClick={() => setRevealed(true)}>
            Reveal your answer
          </button>
        )}

        <div className="db-prep-card-foot">
          <div className="db-prep-nav">
            <button type="button" aria-label="Previous question" onClick={() => move(-1)}>
              <ChevronLeft size={18} aria-hidden />
            </button>
            <button type="button" aria-label="Next question" onClick={() => move(1)}>
              <ChevronRight size={18} aria-hidden />
            </button>
          </div>
          <div className="db-prep-rate">
            <button
              type="button"
              className="is-work"
              aria-pressed={mark === "work"}
              onClick={() => onMark(answer.answerId, mark === "work" ? null : "work")}
            >
              Needs work
            </button>
            <button
              type="button"
              className="is-confident"
              aria-pressed={mark === "confident"}
              onClick={() => onMark(answer.answerId, mark === "confident" ? null : "confident")}
            >
              Confident
            </button>
          </div>
        </div>
        <p className="db-prep-keys"><kbd>←</kbd> <kbd>→</kbd> move · <kbd>Space</kbd> reveal</p>
      </article>
    </div>
  );
}

function BriefingDocument({
  company,
  meta,
  prep,
  sources,
  research,
}: {
  company: string;
  meta: string;
  prep: InterviewPrepRoom;
  sources: SourceMap;
  research: CompanyResearchResult | null;
}) {
  const strengths = prep.fit.filter((row) => row.strength !== "gap");
  const gaps = prep.fit.filter((row) => row.strength === "gap");
  const mustKnowsLabel = `${COUNT_WORDS[prep.mustKnows.length] ?? prep.mustKnows.length} must-know${prep.mustKnows.length === 1 ? "" : "s"}`;
  const sections = [
    prep.companyStory.length > 0 && { id: "prep-story", label: "Company in 60 seconds" },
    prep.mustKnows.length > 0 && { id: "prep-musts", label: mustKnowsLabel },
    prep.answers.length > 0 && { id: "prep-answers", label: "Questions and your answers" },
    strengths.length > 0 && { id: "prep-fit", label: "Your fit" },
    gaps.length > 0 && { id: "prep-gaps", label: "Gaps and bridges" },
    prep.neverSay.length > 0 && { id: "prep-never", label: "Never say" },
  ].filter((section): section is { id: string; label: string } => Boolean(section));

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  };

  // Status and date come from the research fact the must-know cites, matched by
  // the exact statement text preparationSources copied into the brief.
  const factMeta = (line: PrepLine) => {
    const source = sources.get(line.sourceIds[0]);
    const fact = source ? research?.facts.find((item) => item.statement.trim() === source.text.trim()) : undefined;
    return { status: fact?.status ?? null, asOf: fact?.asOf || source?.asOf || "" };
  };

  return (
    <div className="db-prep-brief">
      <nav className="db-prep-index" aria-label="Briefing sections">
        {sections.map((section) => (
          <button key={section.id} type="button" onClick={() => jump(section.id)}>
            {section.label}
          </button>
        ))}
      </nav>

      <article className="db-prep-paper">
        <header className="db-prep-paper-head">
          <span className="db-prep-eyebrow">Interview brief</span>
          <h3>{company}</h3>
          {meta && <p>{meta}</p>}
        </header>

        {prep.companyStory.length > 0 && (
          <section id="prep-story" className="db-prep-section">
            <h4>Company in 60 seconds</h4>
            <div className="db-prep-read">
              {prep.companyStory.map((line) => <p key={line.text}>{line.text}</p>)}
            </div>
          </section>
        )}

        {prep.mustKnows.length > 0 && (
          <section id="prep-musts" className="db-prep-section">
            <h4>{mustKnowsLabel}</h4>
            <ul className="db-prep-musts">
              {prep.mustKnows.map((line) => {
                const detail = factMeta(line);
                return (
                  <li key={line.text}>
                    <span className="db-prep-read">{withMetrics(line.text)}</span>
                    <span className="db-prep-when">
                      {detail.status && <span className={`db-prep-status is-${detail.status}`}>{detail.status}</span>}
                      {detail.asOf && <span className="db-prep-mono">{detail.asOf}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {prep.answers.length > 0 && (
          <section id="prep-answers" className="db-prep-section">
            <h4>Questions and your answers</h4>
            {prep.answers.map((answer) => (
              <div key={answer.answerId} className="db-prep-qa">
                <h5>{answer.question}</h5>
                {answer.whyTheyAsk && (
                  <div className="db-prep-why">
                    <SourceChips ids={answer.whySourceIds} sources={sources} />
                    <span>{answer.whyTheyAsk}</span>
                  </div>
                )}
                {answer.spoken && <blockquote>{withMetrics(answer.spoken)}</blockquote>}
                <div className="db-prep-mini">
                  {answer.star && <span><b>Story</b> {answer.storyTitle || "Your story"}</span>}
                  {answer.followUp && <span><b>Follow-up</b> {answer.followUp}</span>}
                  {answer.avoid && <span className="is-avoid"><b>Avoid</b> {answer.avoid.text}</span>}
                </div>
              </div>
            ))}
          </section>
        )}

        {strengths.length > 0 && (
          <section id="prep-fit" className="db-prep-section">
            <h4>Your fit</h4>
            <div className="db-prep-fit">
              {strengths.map((row) => (
                <div key={row.fitId} className="db-prep-fit-row">
                  <span className="db-prep-fit-copy">
                    <b>{row.requirement}</b>
                    <span>{withMetrics(row.evidence)}</span>
                  </span>
                  <span className={`db-prep-strength is-${row.strength}`}>
                    <span className="db-prep-meter" aria-hidden><i /><i /><i /></span>
                    <span className={`db-prep-status is-${row.strength}`}>{FIT_LABELS[row.strength]}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {gaps.length > 0 && (
          <section id="prep-gaps" className="db-prep-section">
            <h4>Gaps and bridges</h4>
            {gaps.map((row) => (
              <div key={row.fitId} className="db-prep-bridge">
                <b>{row.requirement}</b>
                {row.bridge && <p className="db-prep-read">{row.bridge}</p>}
              </div>
            ))}
          </section>
        )}

        {prep.neverSay.length > 0 && (
          <section id="prep-never" className="db-prep-section">
            <h4>Never say</h4>
            <div className="db-prep-never">
              {prep.neverSay.map((item) => <span key={item}>{item}</span>)}
            </div>
          </section>
        )}
      </article>
    </div>
  );
}
