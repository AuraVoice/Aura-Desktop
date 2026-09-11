/**
 * Keyterms sent into Deepgram Nova-3 recognition for an interview session.
 *
 * Pure, no I/O, no React. Resolved on the desktop at Start and frozen for the
 * session, because Deepgram takes keyterms as query parameters when the socket
 * opens and cannot be re-biased mid-stream.
 *
 * Why this exists: the interview path used to open both ASR streams with an
 * empty keyterm list while dictation had been boosting user vocabulary for
 * months. A live round asking about "RAG" transcribed it as "Rack", which then
 * reached the answer model as the question. The brief, job description, and
 * resume were holding the right strings the whole time.
 *
 * Deriving here rather than in Rust is deliberate. `set_interview_hacker_brief`
 * REJECTS an unreviewed brief, so a Rust-side derivation from the stored brief
 * produces nothing in exactly the case that broke: a session started with no
 * prepared brief at all. Everything below degrades to the always-on lexicon.
 */

import type { InterviewBrief, InterviewBriefClaim } from "./interviewBrief";

/** Mirrors `MAX_KEYTERMS` in dictation/asr/deepgram.rs; the Rust side
 *  truncates too, so this is a budget rather than a safety limit. Deepgram's
 *  own ceiling is 500 tokens across the list and its guidance is 20-50
 *  focused terms, so fifty entries of up to four words each stays inside it. */
export const MAX_INTERVIEW_KEYTERMS = 50;

/**
 * Short, high-confusion technical tokens, always sent.
 *
 * The 50 slots are the whole design. Long distinctive words ("Kubernetes",
 * "containerization") already transcribe correctly, so spending slots on them
 * crowds out the three and four letter tokens that are the only things Nova-3
 * actually gets wrong. Every entry here is a term whose acoustic neighbours are
 * ordinary English.
 *
 * Terms that collide with common speech are deliberately absent: REST ("rest"),
 * SPA ("spa"), and Go would each turn frequent ordinary words into false
 * positives. RAG is kept despite "rag" because a cloth almost never comes up in
 * a technical interview and a retrieval system very often does.
 */
const ALWAYS_ON_LEXICON = [
  "RAG",
  "LLM",
  "gRPC",
  "GraphQL",
  "JWT",
  "OAuth",
  "SaaS",
  "ETL",
  "SQL",
  "NoSQL",
  "CDN",
  "TTL",
  "SLA",
  "CI/CD",
  "Kafka",
  "Redis",
  "Postgres",
  "WebSocket",
];

/** Slots reserved for session-specific vocabulary the interviewer will use:
 *  company, role, and the job description. */
const TARGET_BUDGET = 20;

/** Words that survive the "looks distinctive" test but carry no acoustic value.
 *  Sentence-initial capitals and title-case prose are the main source. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "your", "our", "who", "what", "when",
  "where", "why", "how", "this", "that", "they", "them", "their", "from",
  "have", "has", "had", "will", "would", "can", "could", "should", "must",
  "are", "was", "were", "been", "being", "not", "but", "all", "any", "each",
  "into", "over", "under", "than", "then", "there", "here", "some", "such",
  "very", "more", "most", "other", "about", "also", "just", "like", "well",
  "work", "working", "team", "teams", "role", "roles", "years", "year",
  "experience", "strong", "ability", "including", "across", "within", "using",
  "build", "building", "help", "make", "new", "good", "great", "plus",
  "required", "preferred", "responsibilities", "qualifications", "candidate",
  "company", "position", "job", "description", "apply", "please", "we", "us",
  // Title and seniority words. These appear capitalised in every job posting and
  // would otherwise eat the target budget before a single product name lands.
  "senior", "junior", "staff", "principal", "lead", "manager", "director",
  "engineer", "engineering", "developer", "software", "backend", "frontend",
  "fullstack", "intern", "architect", "specialist", "analyst", "scientist",
  // Sentence-initial verbs and connectives. Free text is full of capitalised
  // prose that passes the "has a capital" test while carrying no vocabulary.
  "built", "build", "cut", "led", "ran", "made", "used", "own", "owned",
  "designed", "created", "shipped", "wrote", "added", "familiarity", "strong",
  "excellent", "proven", "track", "record", "bonus", "nice",
  // Resume boilerplate. Capitalised in every CV, said by no interviewer.
  "university", "college", "institute", "school", "bachelor", "bachelors",
  "master", "masters", "science", "degree", "skills", "education", "summary",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "present",
]);

const TITLE_CASE = /^[A-Z][a-z]+$/;
/** Longest phrase kept whole. Product and company names run two to four
 *  words; anything longer is a sentence that happened to be capitalised. */
const PHRASE_MAX_WORDS = 4;

/**
 * A token worth boosting on its own.
 *
 * Kept deliberately loose on shape and strict on length: acronyms (RAG),
 * mixed case product names (GraphQL, PyTorch), dotted and plus forms (.NET,
 * C++), and versioned tokens (S3, k8s) all qualify. Lowercase prose does not.
 */
function isDistinctive(token: string): boolean {
  if (token.length < 3 || token.length > 32) return false;
  // Leading digit means a measurement, not vocabulary: "4.2s" and "99.9" are
  // this session's numbers and boosting them helps nothing. Terms that merely
  // CONTAIN digits survive, so p99, S3, k8s, and H100 all still qualify.
  if (/^\d/.test(token)) return false;
  if (STOPWORDS.has(token.toLocaleLowerCase())) return false;
  // Purely lowercase prose carries no signal; the interesting tokens all have a
  // capital, a digit, or a symbol somewhere.
  return /[A-Z]/.test(token) || /\d/.test(token) || /[+.#/]/.test(token);
}

/** Whether a token can sit inside a multi-word name. Looser than
 *  `isDistinctive` on purpose: the "AI" in "Vertex AI" and the "DB" in
 *  "Oracle DB" are two letters, and the phrase is what Deepgram matches. */
function isNameShaped(token: string): boolean {
  if (token.length < 2 || token.length > 32 || /^\d/.test(token)) return false;
  if (STOPWORDS.has(token.toLocaleLowerCase())) return false;
  return /[A-Z]/.test(token) || /\d/.test(token) || /[+.#/]/.test(token);
}

/**
 * Splits free text into keyterm candidates: multi-word names kept whole
 * ("Google Cloud Run", "Vertex AI", "Acme Robotics") and single tokens
 * otherwise, with internal +, ., #, / and - preserved so that C++, .NET,
 * CI/CD and Node.js survive intact.
 *
 * Two rules do the work. Adjacent name-shaped tokens separated by nothing but
 * whitespace form one phrase, because Deepgram matches phrases and the split
 * halves ("Cloud", "Run") bias ordinary speech instead. A Title-case word that
 * opens a sentence is dropped: that capital is punctuation, not vocabulary,
 * and it is where "Strong", "Experience" and "Bachelor" were getting in.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const pattern = /[A-Za-z0-9][A-Za-z0-9+.#/-]*/g;
  let run: string[] = [];
  let lastEnd = -1;
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      if (isDistinctive(run[0])) out.push(run[0]);
    } else {
      out.push(run.slice(0, PHRASE_MAX_WORDS).join(" "));
    }
    run = [];
  };
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0].replace(/[.\-/]+$/, "");
    // The gap is measured from the trimmed token, so the period the pattern
    // swallowed after "LiveKit." still separates it from the next sentence.
    const gap = lastEnd < 0 ? "" : text.slice(lastEnd, match.index);
    lastEnd = match.index + token.length;
    if (token.length === 0) continue;
    // Text start is not a sentence boundary: the company and role fields are
    // names, and their first word is the one that matters.
    const sentenceInitial = /[.!?:;\n]/.test(gap);
    const adjacent = run.length > 0 && /^\s+$/.test(gap);
    if (!adjacent) flush();
    if (!isNameShaped(token)) {
      flush();
      continue;
    }
    if (sentenceInitial && TITLE_CASE.test(token)) continue;
    run.push(token);
  }
  flush();
  return out;
}

function claimText(claims: InterviewBriefClaim[]): string {
  return claims.map((claim) => claim.text).join(" ");
}

/**
 * Adds tokens to `into` until `budget` is spent, skipping anything already
 * present. Case-insensitive on the dedup, first-seen casing on the value:
 * Deepgram matches case-insensitively, and the first spelling is the one the
 * user actually wrote.
 */
function take(into: Map<string, string>, text: string, budget: number): void {
  let spent = 0;
  for (const term of tokenize(text)) {
    if (spent >= budget || into.size >= MAX_INTERVIEW_KEYTERMS) return;
    const key = term.toLocaleLowerCase();
    if (into.has(key)) continue;
    into.set(key, term);
    spent += 1;
  }
}

export interface InterviewKeytermSources {
  brief: InterviewBrief | null;
  resumeText: string | null;
  company?: string | null;
  role?: string | null;
  jobDescription?: string | null;
}

/**
 * The session's keyterm list, in priority order and capped at
 * `MAX_INTERVIEW_KEYTERMS`.
 *
 * Priority matters because the cap is real: the always-on lexicon goes in
 * first so that a session with no preparation at all still gets the tokens
 * that break most often, then target vocabulary the interviewer is likely to
 * say, then the candidate's own history.
 */
export function interviewKeyterms(sources: InterviewKeytermSources): string[] {
  const selected = new Map<string, string>();

  for (const term of ALWAYS_ON_LEXICON) {
    selected.set(term.toLocaleLowerCase(), term);
  }

  // Target vocabulary: what the interviewer will be saying.
  const brief = sources.brief;
  const target = [
    sources.company ?? "",
    sources.role ?? "",
    brief?.company?.text ?? "",
    brief?.role?.text ?? "",
    sources.jobDescription ?? "",
    brief ? claimText(brief.jdRequirements) : "",
    brief ? claimText(brief.targetFacts) : "",
  ].join(" ");
  take(selected, target, TARGET_BUDGET);

  // Candidate vocabulary: project and product names, then the resume. Gaps and
  // do-not-claim are excluded on purpose - boosting recognition of something
  // the candidate must not say is the wrong direction.
  const candidate = [
    brief ? claimText(brief.projects) : "",
    brief ? claimText(brief.metrics) : "",
    brief ? claimText(brief.candidateFacts) : "",
    brief ? brief.starStories.map((story) => story.title).join(" ") : "",
    sources.resumeText ?? "",
  ].join(" ");
  take(selected, candidate, MAX_INTERVIEW_KEYTERMS);

  return [...selected.values()].slice(0, MAX_INTERVIEW_KEYTERMS);
}
