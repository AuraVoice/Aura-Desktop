//! Local, encrypted record of every browser task: brief, outcome, answer,
//! sources and the per-step trace. Modelled on `interview_store.rs` (same
//! open-row sentinel, same orphan finalisation on every read and write, same
//! per-row AAD), with its OWN key file under `agent-browser/`: per-feature
//! keys are what let "delete my meeting recordings" never brick anything
//! else, and this store must not inherit the meeting key for that reason.
//!
//! `ended_at_ms = 0` means the task is still open. The worker checkpoints the
//! row on every step and finishes it once; every read and write first closes
//! any open row that is NOT the live task as `failed/app_crash`, so a crash
//! costs at most the last step and never leaves a row pretending to run.
//!
//! What is stored: brief, answer, sources and the trace, all sealed. The
//! trace holds one entry per step with action, ref, url, milliseconds and
//! token counts. It never holds a snapshot or any page text: a URL is the
//! most a row knows about a page. State, counts and timestamps stay in the
//! clear so the list is a plain index read.

use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::sealed_store::{aad, seal, unseal};
use crate::util::now_ms;

pub const DIR: &str = "agent-browser";
const DATABASE_FILE: &str = "tasks.sqlite3";
const KEY_FILE: &str = "key.bin";
/// FROZEN namespace: rows decrypt only under exactly this grammar.
const AAD_NAMESPACE: &str = "aura-browser-task-v1";
const MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const MAX_ROWS: i64 = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEntry {
    pub step: u32,
    pub action: String,
    #[serde(default)]
    pub ref_id: String,
    #[serde(default)]
    pub url: String,
    pub ms: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub task_id: String,
    pub origin: String,
    pub state: String,
    pub steps: i64,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub failure_code: Option<String>,
    pub partial: bool,
    pub brief: String,
    pub source_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub task_id: String,
    pub origin: String,
    pub state: String,
    pub steps: i64,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub failure_code: Option<String>,
    pub partial: bool,
    pub brief: String,
    pub answer: String,
    pub sources: Vec<String>,
    pub trace: Vec<TraceEntry>,
}

pub fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn key(app: &AppHandle) -> Result<[u8; 32], String> {
    crate::crypto::load_or_create_key_at(&root_dir(app)?.join(KEY_FILE), "browser-agent")
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(root_dir(app)?.join(DATABASE_FILE)).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
            uid TEXT NOT NULL,
            task_id TEXT NOT NULL,
            origin TEXT NOT NULL,
            state TEXT NOT NULL,
            steps INTEGER NOT NULL DEFAULT 0,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER NOT NULL DEFAULT 0,
            failure_code TEXT,
            partial INTEGER NOT NULL DEFAULT 0,
            source_count INTEGER NOT NULL DEFAULT 0,
            brief BLOB NOT NULL,
            answer BLOB,
            sources BLOB,
            trace BLOB,
            PRIMARY KEY (uid, task_id)
         );
         CREATE INDEX IF NOT EXISTS tasks_recent ON tasks (uid, started_at_ms DESC);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn row_aad(uid: &str, task_id: &str, slot: &str) -> String {
    aad(AAD_NAMESPACE, &[uid, task_id, slot])
}

fn finalize_orphans(conn: &Connection, uid: &str, live_task_id: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET ended_at_ms = ?3, state = 'failed', failure_code = 'app_crash'
         WHERE uid = ?1 AND ended_at_ms = 0 AND task_id <> ?2",
        params![uid, live_task_id.unwrap_or(""), now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn prune(conn: &Connection, uid: &str) -> Result<(), String> {
    let cutoff = now_ms() - MAX_AGE_MS;
    conn.execute(
        "DELETE FROM tasks
         WHERE uid = ?1 AND ended_at_ms <> 0 AND (
            started_at_ms < ?2
            OR task_id NOT IN (
                SELECT task_id FROM tasks WHERE uid = ?1
                ORDER BY started_at_ms DESC LIMIT ?3
            )
         )",
        params![uid, cutoff, MAX_ROWS],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Inserts the open row for a task that is starting now.
pub fn open_task(app: &AppHandle, uid: &str, task_id: &str, origin: &str, brief: &str) -> Result<(), String> {
    let key = key(app)?;
    let conn = open(app)?;
    finalize_orphans(&conn, uid, Some(task_id))?;
    let sealed_brief = seal(&key, brief, &row_aad(uid, task_id, "brief"))?;
    conn.execute(
        "INSERT INTO tasks (uid, task_id, origin, state, steps, started_at_ms, ended_at_ms, brief)
         VALUES (?1, ?2, ?3, 'running', 0, ?4, 0, ?5)",
        params![uid, task_id, origin, now_ms(), sealed_brief],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Writes the step count and trace of the live task. Only matches an open
/// row, so a checkpoint that lands after `finish` writes nothing.
pub fn checkpoint(app: &AppHandle, uid: &str, task_id: &str, state: &str, trace: &[TraceEntry]) -> Result<(), String> {
    let key = key(app)?;
    let conn = open(app)?;
    let json = serde_json::to_string(trace).map_err(|e| e.to_string())?;
    let sealed = seal(&key, &json, &row_aad(uid, task_id, "trace"))?;
    conn.execute(
        "UPDATE tasks SET steps = ?3, state = ?4, trace = ?5
         WHERE uid = ?1 AND task_id = ?2 AND ended_at_ms = 0",
        params![uid, task_id, trace.len() as i64, state, sealed],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub struct Finish<'a> {
    pub state: &'a str,
    pub failure_code: Option<&'a str>,
    pub partial: bool,
    pub answer: &'a str,
    pub sources: &'a [String],
    pub trace: &'a [TraceEntry],
}

/// Closes the row once, and prunes past the retention bounds.
pub fn finish(app: &AppHandle, uid: &str, task_id: &str, finish: Finish<'_>) -> Result<(), String> {
    let key = key(app)?;
    let mut conn = open(app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let answer = (!finish.answer.is_empty())
        .then(|| seal(&key, finish.answer, &row_aad(uid, task_id, "answer")))
        .transpose()?;
    let sources_json = serde_json::to_string(finish.sources).map_err(|e| e.to_string())?;
    let sources = seal(&key, &sources_json, &row_aad(uid, task_id, "sources"))?;
    let trace_json = serde_json::to_string(finish.trace).map_err(|e| e.to_string())?;
    let trace = seal(&key, &trace_json, &row_aad(uid, task_id, "trace"))?;
    tx.execute(
        "UPDATE tasks SET state = ?3, steps = ?4, ended_at_ms = ?5, failure_code = ?6,
            partial = ?7, source_count = ?8, answer = ?9, sources = ?10, trace = ?11
         WHERE uid = ?1 AND task_id = ?2 AND ended_at_ms = 0",
        params![
            uid,
            task_id,
            finish.state,
            finish.trace.len() as i64,
            now_ms(),
            finish.failure_code,
            i64::from(finish.partial),
            finish.sources.len() as i64,
            answer,
            sources,
            trace,
        ],
    )
    .map_err(|e| e.to_string())?;
    prune(&tx, uid)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list(app: &AppHandle, uid: &str) -> Result<Vec<TaskSummary>, String> {
    let key = key(app)?;
    let conn = open(app)?;
    finalize_orphans(&conn, uid, super::active_task_id(app).as_deref())?;
    let mut stmt = conn
        .prepare(
            "SELECT task_id, origin, state, steps, started_at_ms, ended_at_ms, failure_code,
                    partial, source_count, brief
             FROM tasks WHERE uid = ?1 ORDER BY started_at_ms DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![uid, MAX_ROWS], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Vec<u8>>(9)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (task_id, origin, state, steps, started, ended, failure, partial, source_count, brief) =
            row.map_err(|e| e.to_string())?;
        // A row that will not decrypt is skipped, never fatal.
        let Ok(brief) = unseal(&key, &brief, &row_aad(uid, &task_id, "brief")) else { continue };
        out.push(TaskSummary {
            task_id,
            origin,
            state,
            steps,
            started_at_ms: started,
            ended_at_ms: ended,
            failure_code: failure,
            partial: partial != 0,
            brief,
            source_count,
        });
    }
    Ok(out)
}

pub fn load(app: &AppHandle, uid: &str, task_id: &str) -> Result<Option<TaskDetail>, String> {
    let key = key(app)?;
    let conn = open(app)?;
    finalize_orphans(&conn, uid, super::active_task_id(app).as_deref())?;
    let row = conn
        .query_row(
            "SELECT origin, state, steps, started_at_ms, ended_at_ms, failure_code, partial,
                    brief, answer, sources, trace
             FROM tasks WHERE uid = ?1 AND task_id = ?2",
            params![uid, task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Vec<u8>>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, Option<Vec<u8>>>(9)?,
                    row.get::<_, Option<Vec<u8>>>(10)?,
                ))
            },
        );
    let (origin, state, steps, started, ended, failure, partial, brief, answer, sources, trace) = match row {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let brief = unseal(&key, &brief, &row_aad(uid, task_id, "brief"))?;
    let answer = answer
        .and_then(|bytes| unseal(&key, &bytes, &row_aad(uid, task_id, "answer")).ok())
        .unwrap_or_default();
    let sources: Vec<String> = sources
        .and_then(|bytes| unseal(&key, &bytes, &row_aad(uid, task_id, "sources")).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let trace: Vec<TraceEntry> = trace
        .and_then(|bytes| unseal(&key, &bytes, &row_aad(uid, task_id, "trace")).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    Ok(Some(TaskDetail {
        task_id: task_id.to_string(),
        origin,
        state,
        steps,
        started_at_ms: started,
        ended_at_ms: ended,
        failure_code: failure,
        partial: partial != 0,
        brief,
        answer,
        sources,
        trace,
    }))
}

pub fn delete(app: &AppHandle, uid: &str, task_id: &str) -> Result<(), String> {
    let conn = open(app)?;
    conn.execute(
        "DELETE FROM tasks WHERE uid = ?1 AND task_id = ?2 AND ended_at_ms <> 0",
        params![uid, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Account isolation, called from `security::session_changed` on EVERY
/// transition: rows belonging to any other account are removed.
pub fn retain_only_for_session(app: &AppHandle, uid: Option<&str>) {
    let Ok(conn) = open(app) else { return };
    let result = match uid {
        Some(uid) if !uid.is_empty() => conn.execute("DELETE FROM tasks WHERE uid <> ?1", params![uid]),
        _ => conn.execute("DELETE FROM tasks", []),
    };
    if let Err(e) = result {
        log::warn!("agent_browser.store: retain_only_for_session failed: {e}");
    }
}
