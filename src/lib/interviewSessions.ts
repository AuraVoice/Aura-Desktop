import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrapper over the interview_store Tauri commands (src-tauri/src/
 * interview_store.rs). Finished interview sessions live LOCALLY, encrypted at
 * rest under the shared per-install key - the backend never stores an interview
 * transcript, so this is the only copy. Every read is uid-scoped; a native
 * session-change hook prunes other accounts' rows.
 *
 * The Rust side uses snake_case field names (serde default); this module keeps
 * them snake_case on the wire and camelCases only at the type boundary, matching
 * how dashboardApi.ts treats invoke payloads.
 */

/** One transcript turn: interviewer ("remote") or candidate speech. */
export interface StoredTurn {
  seq: number;
  source: "candidate" | "remote";
  atMs: number;
  text: string;
}

/** One question/answer pair the card produced. */
export interface StoredExchange {
  seq: number;
  question: string;
  answer: string;
  unverified: boolean;
}

/** Sessions-list row: metadata only, no bodies. */
export interface InterviewSessionSummary {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  roundKind: string;
  company: string | null;
  role: string | null;
  exchangeCount: number;
  turnCount: number;
}

/** Full detail for one session. */
export interface InterviewSessionDetail {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  roundKind: string;
  company: string | null;
  role: string | null;
  briefId: string | null;
  turns: StoredTurn[];
  exchanges: StoredExchange[];
}

/** The record handed over on Stop. Snake_case to match the Rust deserializer. */
export interface InterviewSessionRecord {
  session_id: string;
  started_at_ms: number;
  ended_at_ms: number;
  round_kind: string;
  company: string | null;
  role: string | null;
  brief_id: string | null;
  turns: Array<{ seq: number; source: string; at_ms: number; text: string }>;
  exchanges: Array<{ seq: number; question: string; answer: string; unverified: boolean }>;
}

interface RawTurn {
  seq: number;
  source: "candidate" | "remote";
  at_ms: number;
  text: string;
}

interface RawExchange {
  seq: number;
  question: string;
  answer: string;
  unverified: boolean;
}

interface RawSummary {
  session_id: string;
  started_at_ms: number;
  ended_at_ms: number;
  round_kind: string;
  company: string | null;
  role: string | null;
  exchange_count: number;
  turn_count: number;
}

interface RawDetail {
  session_id: string;
  started_at_ms: number;
  ended_at_ms: number;
  round_kind: string;
  company: string | null;
  role: string | null;
  brief_id: string | null;
  turns: RawTurn[];
  exchanges: RawExchange[];
}

function toTurn(raw: RawTurn): StoredTurn {
  return { seq: raw.seq, source: raw.source, atMs: raw.at_ms, text: raw.text };
}

function toExchange(raw: RawExchange): StoredExchange {
  return {
    seq: raw.seq,
    question: raw.question,
    answer: raw.answer,
    unverified: raw.unverified,
  };
}

/** Persist a finished session. Best-effort: a storage failure never blocks Stop. */
export async function saveInterviewSession(
  uid: string,
  session: InterviewSessionRecord,
): Promise<void> {
  await invoke("interview_session_save", { uid, session });
}

export async function listInterviewSessions(
  uid: string,
): Promise<InterviewSessionSummary[]> {
  const rows = await invoke<RawSummary[]>("interview_sessions_list", { uid });
  return rows.map((raw) => ({
    sessionId: raw.session_id,
    startedAtMs: raw.started_at_ms,
    endedAtMs: raw.ended_at_ms,
    roundKind: raw.round_kind,
    company: raw.company,
    role: raw.role,
    exchangeCount: raw.exchange_count,
    turnCount: raw.turn_count,
  }));
}

export async function loadInterviewSession(
  uid: string,
  sessionId: string,
): Promise<InterviewSessionDetail | null> {
  const raw = await invoke<RawDetail | null>("interview_session_load", {
    uid,
    sessionId,
  });
  if (!raw) return null;
  return {
    sessionId: raw.session_id,
    startedAtMs: raw.started_at_ms,
    endedAtMs: raw.ended_at_ms,
    roundKind: raw.round_kind,
    company: raw.company,
    role: raw.role,
    briefId: raw.brief_id,
    turns: raw.turns.map(toTurn),
    exchanges: raw.exchanges.map(toExchange),
  };
}

export async function deleteInterviewSession(
  uid: string,
  sessionId: string,
): Promise<void> {
  await invoke("interview_session_delete", { uid, sessionId });
}

export async function clearInterviewSessions(uid: string): Promise<void> {
  await invoke("interview_sessions_clear", { uid });
}
