// What a manager remembers between runs lives on this computer, sealed, in
// src-tauri/src/swarm_memory. This module is the only place React talks to it:
// recall before a send, ingest after a session ends, and the sweep that catches
// every session that finished while the app was closed or the machine asleep.
//
// Local is truth. The backend only ever holds the last envelope a send carried, so
// a routine that fires with the laptop shut still knows what this manager knew.

import { invoke } from "@tauri-apps/api/core";
import {
  listFinishedSessions,
  TERMINAL_SESSION_STATES,
  type MemoryEnvelope,
  type SwarmLearning,
  type SwarmSessionView,
} from "./swarmApi";

export type MemoryRowType = "fact" | "outcome" | "preference" | "reported" | "thread";

/** One remembered row as the Memory section lists it (decrypted here, never logged). */
export interface MemoryRow {
  /** `type:key_hash`, what Forget takes. */
  id: string;
  type: MemoryRowType;
  key: string;
  text: string;
  /** Effective confidence after decay, 1..10. */
  confidence: number;
  source: "observed" | "user_stated";
  updatedAtMs: number;
  sessionId: string;
  closed: boolean;
}

export interface IngestSummary {
  added: number;
  updated: number;
  skipped: number;
}

interface IngestSession {
  manager_id: string;
  session_id: string;
  state: string;
  ended_at: string;
  learnings: SwarmLearning[];
  reported_ids: string[];
  closed_threads: string[];
}

/** Sessions with no cursor yet are rebuilt from this far back: a reinstall gets a week. */
const FIRST_SWEEP_DAYS = 7;
const SWEEP_PAGE = 50;
/** #group recall fans out to this many managers at most; six envelopes is 12 KB. */
export const RECALL_MANAGER_CAP = 6;

/** Keyword recall over the managers' local rows, keyed by manager. A manager with
 * nothing remembered maps to null and is left out of the send. */
export async function recallMemory(managerIds: string[], brief: string): Promise<Record<string, MemoryEnvelope>> {
  const ids = managerIds.filter(Boolean).slice(0, RECALL_MANAGER_CAP);
  if (ids.length === 0) return {};
  const raw = await invoke<Record<string, MemoryEnvelope | null>>("swarm_memory_recall", { managerIds: ids, brief });
  const out: Record<string, MemoryEnvelope> = {};
  for (const [id, envelope] of Object.entries(raw)) if (envelope) out[id] = envelope;
  return out;
}

function toIngest(view: SwarmSessionView): IngestSession {
  return {
    manager_id: view.managerId,
    session_id: view.sessionId,
    state: view.state,
    ended_at: view.endedAtIso,
    learnings: view.learnings,
    reported_ids: view.reportedIds,
    closed_threads: view.closedThreads,
  };
}

/** Remembers what finished sessions learned. Idempotent: a session seen twice (poll and
 * sweep) upserts the same keys; the store orders by `ended_at`, not arrival. */
export async function ingestSessionViews(views: SwarmSessionView[]): Promise<IngestSummary> {
  const sessions = views.filter((v) => TERMINAL_SESSION_STATES.has(v.state) && v.endedAtIso).map(toIngest);
  if (sessions.length === 0) return { added: 0, updated: 0, skipped: 0 };
  return invoke<IngestSummary>("swarm_memory_ingest", { sessions });
}

let sweeping: Promise<number> | null = null;

/** Pulls every session that ended since this computer last looked, oldest first, and
 * ingests it. One in flight at a time: the overlay hook and the Swarm page both call it. */
export function sweepFinishedSessions(): Promise<number> {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    let total = 0;
    try {
      const cursors = await invoke<Record<string, string>>("swarm_memory_cursors");
      const known = Object.values(cursors).filter(Boolean).sort();
      let since = known[0] ?? new Date(Date.now() - FIRST_SWEEP_DAYS * 86_400_000).toISOString();
      for (;;) {
        const page = await listFinishedSessions(since, SWEEP_PAGE);
        if (page.length === 0) break;
        const summary = await ingestSessionViews(page);
        total += summary.added + summary.updated;
        const last = page[page.length - 1].endedAtIso;
        if (page.length < SWEEP_PAGE || !last || last <= since) break;
        since = last;
      }
    } finally {
      sweeping = null;
    }
    return total;
  })();
  return sweeping;
}

export async function listMemory(managerId: string): Promise<MemoryRow[]> {
  const rows = await invoke<Array<Record<string, unknown>>>("swarm_memory_list", { managerId });
  return rows.map((r) => ({
    id: String(r.id ?? ""),
    type: String(r.type ?? "fact") as MemoryRowType,
    key: String(r.key ?? ""),
    text: String(r.text ?? ""),
    confidence: Number(r.confidence ?? 0),
    source: r.source === "user_stated" ? "user_stated" : "observed",
    updatedAtMs: Number(r.updated_at_ms ?? 0),
    sessionId: String(r.session_id ?? ""),
    closed: r.closed === true,
  }));
}

/** Tombstones rows by id, and when `sessionId` is given every row that session wrote. */
export function forgetMemory(managerId: string, rowIds: string[], sessionId = ""): Promise<void> {
  return invoke("swarm_memory_forget", { managerId, rowIds, sessionId });
}

export function deleteManagerMemory(managerId: string): Promise<void> {
  return invoke("swarm_memory_delete_manager", { managerId });
}

export function exportMemory(managerId: string, title: string): Promise<{ path: string }> {
  return invoke<{ path: string }>("swarm_memory_export", { managerId, title });
}

export function importMemory(managerId: string, json: string): Promise<IngestSummary> {
  return invoke<IngestSummary>("swarm_memory_import", { managerId, json });
}
