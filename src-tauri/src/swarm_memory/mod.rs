//! Per-manager Swarm memory, kept on this machine.
//!
//! Invariants:
//! - Local is truth. The backend only ever sees the small envelope `recall`
//!   builds for one brief, and keeps at most the last one per manager for runs
//!   that start while this machine is off; Forget deletes that copy too (the
//!   webview calls the backend, this module never does).
//! - Rows are sealed under this feature's OWN key (`swarm-memory/key.bin`), so
//!   wiping any other store cannot brick them, and vice versa.
//! - Nothing here logs a key, a text or an id; counts and outcomes only.
//! - A Forget is a tombstone stamped "now", and an ingest writes a row only when
//!   the session that produced it ended after that stamp. Late sweeps cannot
//!   resurrect a forgotten row.
//! - Every command needs a signed-in uid and scopes every read and write by it;
//!   an account switch keeps the other account's rows (see `store::retain_only_for_session`).

pub mod recall;
pub mod store;

use std::collections::HashMap;
use std::io::Write as _;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::security::{self, Operation};
use crate::util::now_ms;
use store::{IngestSummary, Learning, RowType, RowView};

const EXPORT_FOLDER: &str = "Aura Documents";
const EXPORT_VERSION: u8 = 1;
const MAX_IMPORT_BYTES: usize = 4 * 1024 * 1024;

fn uid(app: &AppHandle) -> Result<String, String> {
    security::current_uid(app).ok_or_else(|| "denied: signed out".to_string())
}

/// One finished session as the webview hands it over from the backend's view.
#[derive(Debug, Clone, Deserialize)]
pub struct IngestSession {
    pub manager_id: String,
    pub session_id: String,
    #[serde(default)]
    pub state: String,
    pub ended_at: String,
    #[serde(default)]
    pub learnings: Vec<Learning>,
    #[serde(default)]
    pub reported_ids: Vec<String>,
    #[serde(default)]
    pub closed_threads: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportedFile {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportRow {
    #[serde(rename = "type")]
    row_type: String,
    key: String,
    text: String,
    confidence: i64,
    source: String,
    updated_at: String,
    #[serde(default)]
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportFile {
    v: u8,
    manager_id: String,
    exported_at: String,
    rows: Vec<ExportRow>,
}

#[tauri::command]
pub async fn swarm_memory_recall(
    app: AppHandle,
    manager_ids: Vec<String>,
    brief: String,
) -> Result<HashMap<String, Option<recall::Envelope>>, String> {
    let uid = uid(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = store::key(&app)?;
        let conn = store::open(&app)?;
        let now = now_ms();
        let mut out = HashMap::new();
        for manager_id in manager_ids {
            let rows: Vec<store::LiveRow> = store::live_rows(&conn, &key, &uid, &manager_id, false)?
                .into_iter()
                .map(|(row, _, _, _)| row)
                .collect();
            let envelope = recall::build(&manager_id, &brief, &rows, now);
            log::info!(
                "swarm_memory: recall rows={} sent={}",
                rows.len(),
                envelope.as_ref().map(|e| e.facts.len() + e.outcomes.len() + e.preferences.len() + e.threads.len()).unwrap_or(0)
            );
            out.insert(manager_id, envelope);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn ingest_one(
    conn: &rusqlite::Connection,
    key: &[u8; 32],
    uid: &str,
    session: &IngestSession,
    summary: &mut IngestSummary,
) -> Result<(), String> {
    let Some(ended_at_ms) = store::parse_iso_ms(&session.ended_at) else {
        summary.skipped += 1;
        return Ok(());
    };
    // Only a session that ended leaves memory; a live view handed over by mistake would
    // otherwise advance the cursor past learnings it has not produced yet.
    if !matches!(session.state.as_str(), "done" | "partial" | "failed" | "cancelled") {
        summary.skipped += 1;
        return Ok(());
    }
    let manager_id = &session.manager_id;
    for learning in &session.learnings {
        let Some(row_type) = RowType::parse(&learning.row_type) else {
            summary.skipped += 1;
            continue;
        };
        if row_type == RowType::Reported {
            summary.skipped += 1;
            continue;
        }
        let outcome = store::upsert_learning(conn, key, uid, manager_id, row_type, learning, &session.session_id, ended_at_ms)?;
        summary.count(outcome);
    }
    for id in &session.reported_ids {
        let learning = Learning {
            row_type: RowType::Reported.as_str().to_string(),
            key: id.clone(),
            text: id.clone(),
            confidence: 10,
            source: "observed".to_string(),
        };
        let outcome = store::upsert_learning(conn, key, uid, manager_id, RowType::Reported, &learning, &session.session_id, ended_at_ms)?;
        summary.count(outcome);
    }
    store::close_threads(conn, uid, manager_id, &session.closed_threads, ended_at_ms)?;
    store::set_cursor(conn, uid, manager_id, &session.ended_at)?;
    Ok(())
}

#[tauri::command]
pub async fn swarm_memory_ingest(app: AppHandle, sessions: Vec<IngestSession>) -> Result<IngestSummary, String> {
    let uid = uid(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = store::key(&app)?;
        let mut conn = store::open(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut summary = IngestSummary::default();
        let mut touched: Vec<String> = Vec::new();
        let mut ordered: Vec<&IngestSession> = sessions.iter().collect();
        ordered.sort_by(|a, b| a.ended_at.cmp(&b.ended_at));
        for session in ordered {
            ingest_one(&tx, &key, &uid, session, &mut summary)?;
            if !touched.contains(&session.manager_id) {
                touched.push(session.manager_id.clone());
            }
        }
        let now = now_ms();
        for manager_id in &touched {
            store::prune(&tx, &uid, manager_id, now)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        log::info!(
            "swarm_memory: ingest sessions={} added={} updated={} skipped={}",
            sessions.len(),
            summary.added,
            summary.updated,
            summary.skipped
        );
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn swarm_memory_cursors(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let uid = uid(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = store::open(&app)?;
        store::cursors(&conn, &uid)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn swarm_memory_list(app: AppHandle, manager_id: String) -> Result<Vec<RowView>, String> {
    let uid = uid(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = store::key(&app)?;
        let conn = store::open(&app)?;
        store::list(&conn, &key, &uid, &manager_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn swarm_memory_forget(
    app: AppHandle,
    manager_id: String,
    row_ids: Vec<String>,
    session_id: String,
) -> Result<u32, String> {
    let uid = uid(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = store::key(&app)?;
        let conn = store::open(&app)?;
        let count = store::forget(&conn, &key, &uid, &manager_id, &row_ids, &session_id)?;
        log::info!("swarm_memory: forgot rows={count}");
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn swarm_memory_delete_manager(app: AppHandle, manager_id: String) -> Result<(), String> {
    let uid = uid(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = store::open(&app)?;
        store::delete_manager(&conn, &uid, &manager_id)?;
        log::info!("swarm_memory: deleted a manager's rows");
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn swarm_memory_export(app: AppHandle, manager_id: String, title: String) -> Result<ExportedFile, String> {
    let uid = uid(&app)?;
    let ticket = security::authorize(&app, Operation::SaveDocument)?;
    let folder = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?
        .join(EXPORT_FOLDER);
    let stem = format!("{} memory", crate::swarm_documents::safe_stem(&title));
    let app_for_rows = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        let key = store::key(&app_for_rows)?;
        let conn = store::open(&app_for_rows)?;
        let rows = store::live_rows(&conn, &key, &uid, &manager_id, true)?
            .into_iter()
            .map(|(row, _, session_id, _)| ExportRow {
                row_type: row.row_type.as_str().to_string(),
                key: row.key,
                text: row.text,
                confidence: row.confidence,
                source: if row.source == "user" { "user_stated".to_string() } else { "observed".to_string() },
                updated_at: store::format_iso_ms(row.updated_at_ms),
                session_id,
            })
            .collect();
        let file = ExportFile {
            v: EXPORT_VERSION,
            manager_id,
            exported_at: store::format_iso_ms(now_ms()),
            rows,
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
        for n in 1..=99 {
            let name = if n == 1 { format!("{stem}.json") } else { format!("{stem} ({n}).json") };
            let candidate = folder.join(name);
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
                Ok(mut file) => {
                    file.write_all(&bytes).map_err(|error| error.to_string())?;
                    file.sync_all().map_err(|error| error.to_string())?;
                    return Ok(candidate);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("There are too many files with that name in Aura Documents.".to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    security::recheck(&app, Operation::SaveDocument, &ticket)?;
    log::info!("swarm_memory: exported bytes={}", path.metadata().map(|m| m.len()).unwrap_or(0));
    Ok(ExportedFile { path: path.to_string_lossy().to_string() })
}

#[tauri::command]
pub async fn swarm_memory_import(app: AppHandle, manager_id: String, json: String) -> Result<IngestSummary, String> {
    let uid = uid(&app)?;
    if json.len() > MAX_IMPORT_BYTES {
        return Err("That file is too large to be a memory export.".to_string());
    }
    let file: ExportFile = serde_json::from_str(&json).map_err(|_| "That file is not a memory export.".to_string())?;
    if file.v != EXPORT_VERSION {
        return Err("That memory export comes from a newer version of Aura.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = store::key(&app)?;
        let mut conn = store::open(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut summary = IngestSummary::default();
        for row in &file.rows {
            let (Some(row_type), Some(ended_at_ms)) = (RowType::parse(&row.row_type), store::parse_iso_ms(&row.updated_at)) else {
                summary.skipped += 1;
                continue;
            };
            let learning = Learning {
                row_type: row.row_type.clone(),
                key: row.key.clone(),
                text: row.text.clone(),
                confidence: row.confidence,
                source: row.source.clone(),
            };
            let outcome = store::upsert_learning(&tx, &key, &uid, &manager_id, row_type, &learning, &row.session_id, ended_at_ms)?;
            summary.count(outcome);
        }
        store::prune(&tx, &uid, &manager_id, now_ms())?;
        tx.commit().map_err(|e| e.to_string())?;
        log::info!("swarm_memory: import added={} updated={} skipped={}", summary.added, summary.updated, summary.skipped);
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}
