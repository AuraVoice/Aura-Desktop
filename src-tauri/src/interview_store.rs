//! Local SQLite store for finished interview companion sessions, encrypted at
//! rest. Modelled on `chat_cache.rs`: same DPAPI-wrapped key, same per-row AAD,
//! same "a row that will not decrypt is skipped, never fatal" rule.
//!
//! Unlike the chat cache this is NOT a rendering cache of server state - the
//! backend never stores an interview transcript, so this file is the only copy.
//! It is written once, on Stop, with the whole session in a single transaction,
//! so nothing touches disk on the live answer path. A crash mid-interview loses
//! that one session; that is the accepted trade for keeping capture latency off
//! the disk.
//!
//! ## What is stored
//!
//! Both sides of the transcript (interviewer and candidate turns, timestamped)
//! and the question/answer exchanges the card produced. No audio, no images.
//! Text is AES-256-GCM ciphertext; ids, timestamps, source labels, and the
//! unverified flag stay in the clear so the sessions list and pruning are plain
//! index reads.
//!
//! ## Encryption and account isolation
//!
//! Identical to `chat_cache.rs`. Message text is sealed under the shared
//! per-install key; each row's AAD binds its ciphertext to one account, one
//! session, one row, so a row cannot be replayed into another account or slot.
//! Three overlapping isolation mechanisms: every row carries `uid`, every query
//! filters on it, and `security::session_changed` calls
//! `retain_only_for_session` on every transition. The last one is load-bearing:
//! it does not depend on the webview running any cleanup code.
//!
//! The crypto module is Windows-only, so on other platforms these commands are
//! quiet no-ops that never fall back to writing readable text.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use crate::meeting::crypto;

const DATABASE_FILE: &str = "interview-sessions.sqlite3";

/// Whether session text can be sealed on this platform. False disables the store
/// outright rather than degrading it to plaintext.
const ENCRYPTION_AVAILABLE: bool = cfg!(windows);

/// Retention: whichever bites first. A stored interview is preparation exhaust,
/// not a record to keep forever.
const MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS: i64 = 25;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTurn {
    pub seq: i64,
    /// "candidate" or "remote". Clear text: the sessions view filters on it.
    pub source: String,
    pub at_ms: i64,
    /// Plaintext across the IPC boundary; sealed before it reaches disk.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredExchange {
    pub seq: i64,
    pub question: String,
    pub answer: String,
    pub unverified: bool,
}

/// One finished session, as the webview hands it over on Stop.
#[derive(Debug, Clone, Deserialize)]
pub struct InterviewSessionRecord {
    pub session_id: String,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub round_kind: String,
    pub company: Option<String>,
    pub role: Option<String>,
    pub brief_id: Option<String>,
    pub turns: Vec<StoredTurn>,
    pub exchanges: Vec<StoredExchange>,
}

/// Sessions-list row: metadata only, no turn or exchange bodies.
#[derive(Debug, Clone, Serialize)]
pub struct InterviewSessionSummary {
    pub session_id: String,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub round_kind: String,
    pub company: Option<String>,
    pub role: Option<String>,
    pub exchange_count: i64,
    pub turn_count: i64,
}

/// Full detail for one session, for the dashboard modal.
#[derive(Debug, Clone, Serialize)]
pub struct InterviewSessionDetail {
    pub session_id: String,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub round_kind: String,
    pub company: Option<String>,
    pub role: Option<String>,
    pub brief_id: Option<String>,
    pub turns: Vec<StoredTurn>,
    pub exchanges: Vec<StoredExchange>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(DATABASE_FILE))
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS sessions (
            uid TEXT NOT NULL,
            session_id TEXT NOT NULL,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER NOT NULL,
            round_kind TEXT NOT NULL,
            company BLOB,
            role BLOB,
            brief_id TEXT,
            PRIMARY KEY (uid, session_id)
         );
         CREATE INDEX IF NOT EXISTS sessions_recent
            ON sessions (uid, started_at_ms DESC);
         CREATE TABLE IF NOT EXISTS turns (
            uid TEXT NOT NULL,
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            source TEXT NOT NULL,
            at_ms INTEGER NOT NULL,
            text BLOB NOT NULL,
            PRIMARY KEY (uid, session_id, seq),
            FOREIGN KEY (uid, session_id)
                REFERENCES sessions (uid, session_id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS exchanges (
            uid TEXT NOT NULL,
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            question BLOB NOT NULL,
            answer BLOB NOT NULL,
            unverified INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (uid, session_id, seq),
            FOREIGN KEY (uid, session_id)
                REFERENCES sessions (uid, session_id) ON DELETE CASCADE
         );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Binds a sealed value to exactly one account, session, and slot.
fn row_aad(uid: &str, session_id: &str, slot: &str) -> String {
    format!("aura-interview-v1\0{uid}\0{session_id}\0{slot}")
}

#[cfg(windows)]
fn cache_key(app: &AppHandle) -> Result<[u8; 32], String> {
    crypto::load_or_create_key(app)
}

#[cfg(not(windows))]
fn cache_key(_app: &AppHandle) -> Result<[u8; 32], String> {
    Err("interview store encryption is unavailable on this platform".to_string())
}

#[cfg(windows)]
fn seal(key: &[u8; 32], plaintext: &str, aad: &str) -> Result<Vec<u8>, String> {
    crypto::encrypt_with_aad(key, plaintext.as_bytes(), aad.as_bytes())
}

#[cfg(not(windows))]
fn seal(_key: &[u8; 32], _plaintext: &str, _aad: &str) -> Result<Vec<u8>, String> {
    Err("interview store encryption is unavailable on this platform".to_string())
}

#[cfg(windows)]
fn unseal(key: &[u8; 32], sealed: &[u8], aad: &str) -> Result<String, String> {
    let plain = crypto::decrypt_with_aad(key, sealed, aad.as_bytes())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn unseal(_key: &[u8; 32], _sealed: &[u8], _aad: &str) -> Result<String, String> {
    Err("interview store encryption is unavailable on this platform".to_string())
}

fn seal_optional(key: &[u8; 32], value: &Option<String>, aad: &str) -> Result<Option<Vec<u8>>, String> {
    match value {
        Some(text) if !text.is_empty() => Ok(Some(seal(key, text, aad)?)),
        _ => Ok(None),
    }
}

fn unseal_optional(key: &[u8; 32], sealed: &Option<Vec<u8>>, aad: &str) -> Option<String> {
    match sealed {
        Some(bytes) => unseal(key, bytes, aad).ok(),
        None => None,
    }
}

/// Deletes rows past either retention bound for one account, inside a caller's
/// transaction. Turns and exchanges cascade via the foreign key.
fn prune(tx: &rusqlite::Transaction, uid: &str) -> Result<(), String> {
    let cutoff = now_ms() - MAX_AGE_MS;
    tx.execute(
        "DELETE FROM sessions
         WHERE uid = ?1 AND (
            started_at_ms < ?2
            OR session_id NOT IN (
                SELECT session_id FROM sessions WHERE uid = ?1
                ORDER BY started_at_ms DESC LIMIT ?3
            )
         )",
        params![uid, cutoff, MAX_SESSIONS],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persists one finished session and prunes past the retention bounds, in a
/// single transaction. Called once on Stop.
#[tauri::command]
pub async fn interview_session_save(
    app: AppHandle,
    uid: String,
    session: InterviewSessionRecord,
) -> Result<(), String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() || session.session_id.is_empty() {
        return Ok(());
    }
    // A session with nothing said is not worth a row.
    if session.turns.is_empty() && session.exchanges.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = cache_key(&app)?;
        let mut conn = open(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let sid = &session.session_id;
        // Rewrite the whole session, so a re-save cannot leave stale rows behind.
        tx.execute(
            "DELETE FROM sessions WHERE uid = ?1 AND session_id = ?2",
            params![uid, sid],
        )
        .map_err(|e| e.to_string())?;

        let company = seal_optional(&key, &session.company, &row_aad(&uid, sid, "company"))?;
        let role = seal_optional(&key, &session.role, &row_aad(&uid, sid, "role"))?;
        tx.execute(
            "INSERT INTO sessions (
                uid, session_id, started_at_ms, ended_at_ms, round_kind,
                company, role, brief_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                uid,
                sid,
                session.started_at_ms,
                session.ended_at_ms,
                session.round_kind,
                company,
                role,
                session.brief_id,
            ],
        )
        .map_err(|e| e.to_string())?;

        for turn in &session.turns {
            let sealed = seal(&key, &turn.text, &row_aad(&uid, sid, &format!("turn:{}", turn.seq)))?;
            tx.execute(
                "INSERT INTO turns (uid, session_id, seq, source, at_ms, text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![uid, sid, turn.seq, turn.source, turn.at_ms, sealed],
            )
            .map_err(|e| e.to_string())?;
        }

        for exchange in &session.exchanges {
            let question = seal(
                &key,
                &exchange.question,
                &row_aad(&uid, sid, &format!("exchange:{}:q", exchange.seq)),
            )?;
            let answer = seal(
                &key,
                &exchange.answer,
                &row_aad(&uid, sid, &format!("exchange:{}:a", exchange.seq)),
            )?;
            tx.execute(
                "INSERT INTO exchanges (uid, session_id, seq, question, answer, unverified)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![uid, sid, exchange.seq, question, answer, i64::from(exchange.unverified)],
            )
            .map_err(|e| e.to_string())?;
        }

        prune(&tx, &uid)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Metadata for every stored session, newest first. Company and role are the only
/// sealed fields; a row whose metadata will not decrypt still lists (with those
/// fields blank) rather than vanishing.
#[tauri::command]
pub async fn interview_sessions_list(
    app: AppHandle,
    uid: String,
) -> Result<Vec<InterviewSessionSummary>, String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = cache_key(&app)?;
        let conn = open(&app)?;
        let mut statement = conn
            .prepare(
                "SELECT s.session_id, s.started_at_ms, s.ended_at_ms, s.round_kind,
                        s.company, s.role,
                        (SELECT COUNT(*) FROM exchanges e
                           WHERE e.uid = s.uid AND e.session_id = s.session_id),
                        (SELECT COUNT(*) FROM turns t
                           WHERE t.uid = s.uid AND t.session_id = s.session_id)
                 FROM sessions s
                 WHERE s.uid = ?1
                 ORDER BY s.started_at_ms DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![uid], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (session_id, started, ended, round_kind, company, role, exchanges, turns) =
                row.map_err(|e| e.to_string())?;
            out.push(InterviewSessionSummary {
                company: unseal_optional(&key, &company, &row_aad(&uid, &session_id, "company")),
                role: unseal_optional(&key, &role, &row_aad(&uid, &session_id, "role")),
                session_id,
                started_at_ms: started,
                ended_at_ms: ended,
                round_kind,
                exchange_count: exchanges,
                turn_count: turns,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Full detail for one session. Undecryptable turn/exchange rows are skipped, not
/// fatal - a rotated key degrades to a thinner transcript, never a broken page.
#[tauri::command]
pub async fn interview_session_load(
    app: AppHandle,
    uid: String,
    session_id: String,
) -> Result<Option<InterviewSessionDetail>, String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() || session_id.is_empty() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = cache_key(&app)?;
        let conn = open(&app)?;
        let meta: Option<(i64, i64, String, Option<Vec<u8>>, Option<Vec<u8>>, Option<String>)> = conn
            .query_row(
                "SELECT started_at_ms, ended_at_ms, round_kind, company, role, brief_id
                 FROM sessions WHERE uid = ?1 AND session_id = ?2",
                params![uid, session_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .ok();
        let Some((started, ended, round_kind, company, role, brief_id)) = meta else {
            return Ok(None);
        };

        let mut turn_stmt = conn
            .prepare(
                "SELECT seq, source, at_ms, text FROM turns
                 WHERE uid = ?1 AND session_id = ?2 ORDER BY seq ASC",
            )
            .map_err(|e| e.to_string())?;
        let turn_rows = turn_stmt
            .query_map(params![uid, session_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut turns = Vec::new();
        for row in turn_rows {
            let (seq, source, at_ms, sealed) = row.map_err(|e| e.to_string())?;
            let Ok(text) = unseal(&key, &sealed, &row_aad(&uid, &session_id, &format!("turn:{seq}")))
            else {
                continue;
            };
            turns.push(StoredTurn { seq, source, at_ms, text });
        }

        let mut ex_stmt = conn
            .prepare(
                "SELECT seq, question, answer, unverified FROM exchanges
                 WHERE uid = ?1 AND session_id = ?2 ORDER BY seq ASC",
            )
            .map_err(|e| e.to_string())?;
        let ex_rows = ex_stmt
            .query_map(params![uid, session_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut exchanges = Vec::new();
        for row in ex_rows {
            let (seq, q_sealed, a_sealed, unverified) = row.map_err(|e| e.to_string())?;
            let (Ok(question), Ok(answer)) = (
                unseal(&key, &q_sealed, &row_aad(&uid, &session_id, &format!("exchange:{seq}:q"))),
                unseal(&key, &a_sealed, &row_aad(&uid, &session_id, &format!("exchange:{seq}:a"))),
            ) else {
                continue;
            };
            exchanges.push(StoredExchange { seq, question, answer, unverified: unverified != 0 });
        }

        Ok(Some(InterviewSessionDetail {
            company: unseal_optional(&key, &company, &row_aad(&uid, &session_id, "company")),
            role: unseal_optional(&key, &role, &row_aad(&uid, &session_id, "role")),
            session_id,
            started_at_ms: started,
            ended_at_ms: ended,
            round_kind,
            brief_id,
            turns,
            exchanges,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes one stored session. Turns and exchanges cascade.
#[tauri::command]
pub async fn interview_session_delete(
    app: AppHandle,
    uid: String,
    session_id: String,
) -> Result<(), String> {
    if uid.is_empty() || session_id.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        conn.execute("PRAGMA foreign_keys = ON", []).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM sessions WHERE uid = ?1 AND session_id = ?2",
            params![uid, session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes one account's stored sessions, or every account's when `uid` is empty.
#[tauri::command]
pub async fn interview_sessions_clear(app: AppHandle, uid: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        conn.execute("PRAGMA foreign_keys = ON", []).map_err(|e| e.to_string())?;
        match uid {
            Some(id) if !id.is_empty() => conn
                .execute("DELETE FROM sessions WHERE uid = ?1", params![id])
                .map_err(|e| e.to_string())?,
            _ => conn
                .execute("DELETE FROM sessions", [])
                .map_err(|e| e.to_string())?,
        };
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Native session-boundary hook, mirroring `chat_cache::retain_only_for_session`.
/// Keeps only the signed-in account's rows, and nothing at all once signed out.
/// Fire-and-forget: the session transition must not block on disk IO, and every
/// read is uid-filtered anyway. This is the isolation mechanism React cannot
/// provide, since it covers a crash-then-resignin with no sign-out in between.
pub fn retain_only_for_session(app: &AppHandle, uid: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let conn = open(&app)?;
            conn.execute("PRAGMA foreign_keys = ON", []).map_err(|e| e.to_string())?;
            match uid {
                Some(id) if !id.is_empty() => conn
                    .execute("DELETE FROM sessions WHERE uid <> ?1", params![id])
                    .map_err(|e| e.to_string())?,
                _ => conn
                    .execute("DELETE FROM sessions", [])
                    .map_err(|e| e.to_string())?,
            };
            Ok::<(), String>(())
        })
        .await;
        match result {
            Ok(Err(error)) => log::warn!("interview_store: session prune failed: {error}"),
            Err(error) => log::warn!("interview_store: session prune join failed: {error}"),
            Ok(Ok(())) => {}
        }
    });
}
