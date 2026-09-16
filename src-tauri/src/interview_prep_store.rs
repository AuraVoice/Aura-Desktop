//! Local SQLite store for Interview Companion preparations (company, role, job
//! description, resume text, research, the built brief), encrypted at rest.
//! Modelled on `interview_store.rs`: same per-install key, same per-row AAD,
//! same "a row that will not decrypt is skipped, never fatal" rule.
//!
//! Why this exists: the preparation used to live in the dashboard's plugin-store
//! cache as ONE JSON key whose loader was all-or-nothing. A single record that
//! failed a shape check made the whole workspace load as empty, the page then
//! built a fresh one and its autosave wrote that over every interview the user
//! had prepared. The reviewed brief itself lived only in Rust process memory
//! and was pushed there only when the dashboard Interview page mounted, so a
//! relaunch followed by opening the companion from the notch ran with no brief
//! at all. One user prepared for a screening call, came back, and found
//! nothing (2026-09-16).
//!
//! ## What is stored
//!
//! One row per prepared interview: the whole `InterviewWorkspaceRecord` the
//! webview owns, sealed as a JSON blob, plus the clear-text id and update time
//! so listing and pruning are index reads. A meta row per account remembers
//! which interview is current on the page and which brief is active for the
//! companion. Rows are read back one at a time and validated one at a time on
//! the webview side, so a bad record costs that record, never the others.
//!
//! ## Encryption and account isolation
//!
//! Identical to `interview_store.rs`: sealed under the shared per-install key,
//! AAD bound to one account and one interview. Every query filters on `uid`.
//! `security::session_changed` calls `retain_only_for_session` on every real
//! transition; unlike the transcript store it keeps rows across a plain
//! sign-out (uid None), because a preparation is deliberate work the user made
//! ahead of time and signing out and back in to the same account must not cost
//! it. Signing in as a DIFFERENT account still drops the other account's rows.

use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::meeting::crypto;
use crate::sealed_store::{seal, unseal};

const DATABASE_FILE: &str = "interview-preparations.sqlite3";

/// Bounded: the most recently updated preparations per account. No age expiry,
/// a preparation is made ahead of time on purpose.
const MAX_PREPARATIONS: i64 = 30;
/// A record carries the resume text (20k chars), the research dossier and the
/// brief; a quarter megabyte covers the largest preparation seen with room.
const MAX_BODY_BYTES: usize = 512_000;

/// FROZEN namespace: existing sealed rows decrypt only under exactly this
/// grammar (this version string, NUL-separated parts).
const AAD_NAMESPACE: &str = "aura-interview-prep-v1";

fn row_aad(uid: &str, interview_id: &str) -> String {
    crate::sealed_store::aad(AAD_NAMESPACE, &[uid, interview_id, "body"])
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationRow {
    pub interview_id: String,
    pub updated_at_ms: i64,
    /// The record exactly as the webview stored it. Validated on that side.
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationWorkspace {
    pub records: Vec<PreparationRow>,
    pub current_interview_id: Option<String>,
    pub active_interview_id: Option<String>,
    /// Rows on disk that would not decrypt. They are left in place; the count
    /// lets the page say so instead of pretending they never existed.
    pub unreadable: i64,
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(DATABASE_FILE))
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    // The sign-in hook prunes other accounts and hydrates this one at the same
    // moment, on two connections; wait out the other writer instead of failing
    // the hydrate with "database is locked".
    conn.execute_batch(
        "PRAGMA busy_timeout = 2000;
         CREATE TABLE IF NOT EXISTS preparations (
            uid TEXT NOT NULL,
            interview_id TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            body BLOB NOT NULL,
            PRIMARY KEY (uid, interview_id)
         );
         CREATE INDEX IF NOT EXISTS preparations_recent
            ON preparations (uid, updated_at_ms DESC);
         CREATE TABLE IF NOT EXISTS workspace_meta (
            uid TEXT NOT NULL PRIMARY KEY,
            current_interview_id TEXT,
            active_interview_id TEXT
         );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn cache_key(app: &AppHandle) -> Result<[u8; 32], String> {
    crypto::load_or_create_key(app)
}

/// Keeps the newest MAX_PREPARATIONS rows for one account.
fn prune(conn: &Connection, uid: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM preparations
         WHERE uid = ?1 AND interview_id NOT IN (
            SELECT interview_id FROM preparations WHERE uid = ?1
            ORDER BY updated_at_ms DESC LIMIT ?2
         )",
        params![uid, MAX_PREPARATIONS],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reads and decrypts one account's preparations. Blocking: callers wrap it in
/// `spawn_blocking`. Undecryptable rows are counted and left on disk.
fn load_workspace(app: &AppHandle, uid: &str) -> Result<PreparationWorkspace, String> {
    let key = cache_key(app)?;
    let conn = open(app)?;
    let mut stmt = conn
        .prepare(
            "SELECT interview_id, updated_at_ms, body FROM preparations
             WHERE uid = ?1 ORDER BY updated_at_ms DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![uid], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut records = Vec::new();
    let mut unreadable = 0;
    for row in rows {
        let (interview_id, updated_at_ms, sealed) = row.map_err(|e| e.to_string())?;
        let body = unseal(&key, &sealed, &row_aad(uid, &interview_id))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        match body {
            Some(body) => records.push(PreparationRow { interview_id, updated_at_ms, body }),
            None => unreadable += 1,
        }
    }
    let meta: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT current_interview_id, active_interview_id FROM workspace_meta WHERE uid = ?1",
            params![uid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (current_interview_id, active_interview_id) = meta.unwrap_or((None, None));
    Ok(PreparationWorkspace {
        records,
        current_interview_id,
        active_interview_id,
        unreadable,
    })
}

/// The record the companion should run with: the active interview's body, or
/// None when no brief has been made active. Blocking, for `spawn_blocking`.
pub fn active_preparation(app: &AppHandle, uid: &str) -> Result<Option<serde_json::Value>, String> {
    let workspace = load_workspace(app, uid)?;
    let Some(active_id) = workspace.active_interview_id else {
        return Ok(None);
    };
    Ok(workspace
        .records
        .into_iter()
        .find(|record| record.interview_id == active_id)
        .map(|record| record.body))
}

#[tauri::command]
pub async fn interview_prep_load(app: AppHandle, uid: String) -> Result<PreparationWorkspace, String> {
    if uid.is_empty() {
        return Ok(PreparationWorkspace {
            records: Vec::new(),
            current_interview_id: None,
            active_interview_id: None,
            unreadable: 0,
        });
    }
    tauri::async_runtime::spawn_blocking(move || load_workspace(&app, &uid))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes one record, replacing any previous version of it. Idempotent.
#[tauri::command]
pub async fn interview_prep_upsert(
    app: AppHandle,
    uid: String,
    interview_id: String,
    updated_at_ms: i64,
    body: serde_json::Value,
) -> Result<(), String> {
    if uid.is_empty() || interview_id.is_empty() {
        return Err("Preparation identity is missing.".to_string());
    }
    let text = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    if text.len() > MAX_BODY_BYTES {
        return Err("Preparation is too large to store.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = cache_key(&app)?;
        let conn = open(&app)?;
        let sealed = seal(&key, &text, &row_aad(&uid, &interview_id))?;
        conn.execute(
            "INSERT INTO preparations (uid, interview_id, updated_at_ms, body)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (uid, interview_id) DO UPDATE SET
                updated_at_ms = excluded.updated_at_ms,
                body = excluded.body",
            params![uid, interview_id, updated_at_ms, sealed],
        )
        .map_err(|e| e.to_string())?;
        prune(&conn, &uid)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn interview_prep_delete(
    app: AppHandle,
    uid: String,
    interview_id: String,
) -> Result<(), String> {
    if uid.is_empty() || interview_id.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        conn.execute(
            "DELETE FROM preparations WHERE uid = ?1 AND interview_id = ?2",
            params![uid, interview_id],
        )
        .map_err(|e| e.to_string())?;
        // A deleted interview cannot stay current or active.
        conn.execute(
            "UPDATE workspace_meta SET
                current_interview_id = CASE WHEN current_interview_id = ?2 THEN NULL ELSE current_interview_id END,
                active_interview_id = CASE WHEN active_interview_id = ?2 THEN NULL ELSE active_interview_id END
             WHERE uid = ?1",
            params![uid, interview_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn interview_prep_set_meta(
    app: AppHandle,
    uid: String,
    current_interview_id: Option<String>,
    active_interview_id: Option<String>,
) -> Result<(), String> {
    if uid.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        conn.execute(
            "INSERT INTO workspace_meta (uid, current_interview_id, active_interview_id)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (uid) DO UPDATE SET
                current_interview_id = excluded.current_interview_id,
                active_interview_id = excluded.active_interview_id",
            params![uid, current_interview_id, active_interview_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Native session-boundary hook. Drops every OTHER account's preparations when
/// an account signs in; keeps everything across a plain sign-out (see the
/// module doc for why that differs from the transcript store). Fire-and-forget.
pub fn retain_only_for_session(app: &AppHandle, uid: Option<String>) {
    let Some(id) = uid.filter(|id| !id.is_empty()) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let conn = open(&app)?;
            conn.execute("DELETE FROM preparations WHERE uid <> ?1", params![id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM workspace_meta WHERE uid <> ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        })
        .await;
        match result {
            Ok(Err(error)) => log::warn!("interview_prep_store: prune failed: {error}"),
            Err(error) => log::warn!("interview_prep_store: prune join failed: {error}"),
            Ok(Ok(())) => {}
        }
    });
}
