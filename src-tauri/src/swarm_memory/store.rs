//! The per-manager memory rows: one encrypted SQLite file for every manager of
//! every account on this machine, sealed under its OWN key file so that no other
//! feature's wipe can brick it (the same stance as `agent_browser/store.rs`).
//!
//! The clear columns are an index with no content: uid, manager, row type, a
//! hash of the key, confidence, source and timestamps. The key, the text, the
//! source word and the session that wrote the row live only inside the sealed
//! body. Nothing in this module logs a key or a text.
//!
//! Ordering is by the SESSION's end time, never by arrival: a sweep that
//! delivers an older session after a newer one cannot overwrite newer text,
//! and a Forget (a tombstone stamped with "now") beats any later sweep that
//! still carries the forgotten key, because the row is skipped whenever the
//! tombstone is newer than the session that wants to write it.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::sealed_store::{aad, seal, unseal};
use crate::util::now_ms;

pub const DIR: &str = "swarm-memory";
const DATABASE_FILE: &str = "memory.sqlite3";
const KEY_FILE: &str = "key.bin";
/// FROZEN namespace: rows decrypt only under exactly this grammar.
const AAD_NAMESPACE: &str = "aura-swarm-memory-v1";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const TOMBSTONE_KEEP_MS: i64 = 90 * DAY_MS;
const CLOSED_THREAD_KEEP_MS: i64 = 30 * DAY_MS;
const MAX_KEY_CHARS: usize = 120;
const MAX_TEXT_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RowType {
    Fact,
    Outcome,
    Preference,
    Reported,
    Thread,
}

impl RowType {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "fact" => Some(Self::Fact),
            "outcome" => Some(Self::Outcome),
            "preference" => Some(Self::Preference),
            "reported" => Some(Self::Reported),
            "thread" => Some(Self::Thread),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Outcome => "outcome",
            Self::Preference => "preference",
            Self::Reported => "reported",
            Self::Thread => "thread",
        }
    }

    /// Confidence half-life, or none for rows that never fade.
    fn half_life_ms(self) -> Option<i64> {
        match self {
            Self::Fact => Some(30 * DAY_MS),
            Self::Outcome => Some(14 * DAY_MS),
            Self::Preference | Self::Reported | Self::Thread => None,
        }
    }

    /// Live rows kept per manager; the oldest past this are dropped.
    fn cap(self) -> i64 {
        match self {
            Self::Fact => 200,
            Self::Outcome => 100,
            Self::Preference => 50,
            Self::Reported => 500,
            Self::Thread => 30,
        }
    }
}

/// One learning as the backend's report carries it, and as an import file does.
#[derive(Debug, Clone, Deserialize)]
pub struct Learning {
    #[serde(rename = "type")]
    pub row_type: String,
    pub key: String,
    pub text: String,
    pub confidence: i64,
    #[serde(default)]
    pub source: String,
}

/// The sealed body of a row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Body {
    key: String,
    text: String,
    source: String,
    #[serde(default)]
    session_id: String,
}

/// A decrypted row for the manager card and for recall.
#[derive(Debug, Clone, Serialize)]
pub struct RowView {
    pub id: String,
    #[serde(rename = "type")]
    pub row_type: String,
    pub key: String,
    pub text: String,
    pub confidence: i64,
    pub source: String,
    pub updated_at_ms: i64,
    pub session_id: String,
    pub closed: bool,
}

/// A row as recall scores it: the stored confidence, not the rounded effective one.
#[derive(Debug, Clone)]
pub struct LiveRow {
    pub row_type: RowType,
    pub key: String,
    pub text: String,
    pub source: String,
    pub confidence: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upsert {
    Added,
    Updated,
    Skipped,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct IngestSummary {
    pub added: u32,
    pub updated: u32,
    pub skipped: u32,
}

impl IngestSummary {
    pub fn count(&mut self, outcome: Upsert) {
        match outcome {
            Upsert::Added => self.added += 1,
            Upsert::Updated => self.updated += 1,
            Upsert::Skipped => self.skipped += 1,
        }
    }
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

pub fn key(app: &AppHandle) -> Result<[u8; 32], String> {
    crate::crypto::load_or_create_key_at(&root_dir(app)?.join(KEY_FILE), "swarm-memory")
}

pub fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(root_dir(app)?.join(DATABASE_FILE)).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rows (
            uid TEXT NOT NULL,
            manager_id TEXT NOT NULL,
            type TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            body BLOB NOT NULL,
            confidence INTEGER NOT NULL,
            source TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            reinforced INTEGER NOT NULL DEFAULT 0,
            tombstone INTEGER NOT NULL DEFAULT 0,
            tombstoned_at_ms INTEGER NOT NULL DEFAULT 0,
            closed_at_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (uid, manager_id, type, key_hash)
         );
         CREATE INDEX IF NOT EXISTS rows_recent ON rows (uid, manager_id, updated_at_ms DESC);
         CREATE TABLE IF NOT EXISTS cursors (
            uid TEXT NOT NULL,
            manager_id TEXT NOT NULL,
            last_ingested_at TEXT NOT NULL,
            PRIMARY KEY (uid, manager_id)
         );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn row_aad(uid: &str, manager_id: &str, row_type: &str, key_hash: &str) -> String {
    aad(AAD_NAMESPACE, &[uid, manager_id, row_type, key_hash])
}

fn normalize_key(raw: &str) -> String {
    raw.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn key_hash(row_type: RowType, raw_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(row_type.as_str().as_bytes());
    hasher.update([0u8]);
    hasher.update(normalize_key(raw_key).as_bytes());
    format!("{:x}", hasher.finalize())
}

fn clip(raw: &str, max_chars: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        trimmed.chars().take(max_chars).collect()
    }
}

/// Confidence after decay, as a real number; rows fade by their type's half-life.
pub fn effective_confidence(row_type: RowType, confidence: i64, updated_at_ms: i64, now: i64) -> f64 {
    match row_type.half_life_ms() {
        Some(half) => {
            let age = (now - updated_at_ms).max(0) as f64;
            confidence as f64 * 0.5f64.powf(age / half as f64)
        }
        None => confidence as f64,
    }
}

struct Existing {
    body: Vec<u8>,
    confidence: i64,
    updated_at_ms: i64,
    tombstone: bool,
    tombstoned_at_ms: i64,
}

fn existing(conn: &Connection, uid: &str, manager_id: &str, row_type: RowType, hash: &str) -> Result<Option<Existing>, String> {
    let row = conn.query_row(
        "SELECT body, confidence, updated_at_ms, tombstone, tombstoned_at_ms
         FROM rows WHERE uid = ?1 AND manager_id = ?2 AND type = ?3 AND key_hash = ?4",
        params![uid, manager_id, row_type.as_str(), hash],
        |row| {
            Ok(Existing {
                body: row.get(0)?,
                confidence: row.get(1)?,
                updated_at_ms: row.get(2)?,
                tombstone: row.get::<_, i64>(3)? != 0,
                tombstoned_at_ms: row.get(4)?,
            })
        },
    );
    match row {
        Ok(found) => Ok(Some(found)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Keyed upsert of one learning on behalf of the session that ended at
/// `ended_at_ms`. A newer row, or a newer tombstone, wins over this write.
#[allow(clippy::too_many_arguments)]
pub fn upsert_learning(
    conn: &Connection,
    key: &[u8; 32],
    uid: &str,
    manager_id: &str,
    row_type: RowType,
    learning: &Learning,
    session_id: &str,
    ended_at_ms: i64,
) -> Result<Upsert, String> {
    let raw_key = clip(&learning.key, MAX_KEY_CHARS);
    let text = clip(&learning.text, MAX_TEXT_CHARS);
    if raw_key.is_empty() || text.is_empty() {
        return Ok(Upsert::Skipped);
    }
    let source = match learning.source.as_str() {
        "user_stated" | "user" => "user",
        _ => "observed",
    };
    if row_type == RowType::Preference && source != "user" {
        return Ok(Upsert::Skipped);
    }
    let confidence = learning.confidence.clamp(1, 10);
    let hash = key_hash(row_type, &raw_key);
    let aad_str = row_aad(uid, manager_id, row_type.as_str(), &hash);
    let found = existing(conn, uid, manager_id, row_type, &hash)?;

    let mut reinforced_delta = 0;
    let mut stored_confidence = confidence;
    let mut outcome = Upsert::Added;
    let mut created_at_ms = ended_at_ms;
    if let Some(prev) = found {
        if prev.tombstone {
            if prev.tombstoned_at_ms > ended_at_ms {
                return Ok(Upsert::Skipped);
            }
            // A tombstone older than this session: the row is legitimately back.
        } else {
            if prev.updated_at_ms > ended_at_ms {
                return Ok(Upsert::Skipped);
            }
            outcome = Upsert::Updated;
            let prev_body: Option<Body> = unseal(key, &prev.body, &aad_str)
                .ok()
                .and_then(|json| serde_json::from_str(&json).ok());
            if prev_body.as_ref().map(|b| b.text == text).unwrap_or(false) {
                reinforced_delta = 1;
                stored_confidence = (prev.confidence.max(confidence) + 1).min(10);
            }
            created_at_ms = conn
                .query_row(
                    "SELECT created_at_ms FROM rows WHERE uid = ?1 AND manager_id = ?2 AND type = ?3 AND key_hash = ?4",
                    params![uid, manager_id, row_type.as_str(), hash],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(ended_at_ms);
        }
    }
    let body = Body {
        key: raw_key,
        text,
        source: source.to_string(),
        session_id: session_id.to_string(),
    };
    let json = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let sealed = seal(key, &json, &aad_str)?;
    conn.execute(
        "INSERT INTO rows (uid, manager_id, type, key_hash, body, confidence, source,
                           created_at_ms, updated_at_ms, reinforced, tombstone, tombstoned_at_ms, closed_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, 0, 0)
         ON CONFLICT (uid, manager_id, type, key_hash) DO UPDATE SET
            body = excluded.body, confidence = excluded.confidence, source = excluded.source,
            updated_at_ms = excluded.updated_at_ms, reinforced = rows.reinforced + ?10,
            tombstone = 0, tombstoned_at_ms = 0, closed_at_ms = 0",
        params![
            uid,
            manager_id,
            row_type.as_str(),
            hash,
            sealed,
            stored_confidence,
            source,
            created_at_ms,
            ended_at_ms,
            reinforced_delta,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(outcome)
}

/// Marks open threads closed by the keys a report resolved.
pub fn close_threads(conn: &Connection, uid: &str, manager_id: &str, keys: &[String], ended_at_ms: i64) -> Result<(), String> {
    for raw in keys {
        let hash = key_hash(RowType::Thread, raw);
        conn.execute(
            "UPDATE rows SET closed_at_ms = ?5
             WHERE uid = ?1 AND manager_id = ?2 AND type = ?3 AND key_hash = ?4 AND tombstone = 0 AND closed_at_ms = 0",
            params![uid, manager_id, RowType::Thread.as_str(), hash, ended_at_ms],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn set_cursor(conn: &Connection, uid: &str, manager_id: &str, last_ingested_at: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO cursors (uid, manager_id, last_ingested_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (uid, manager_id) DO UPDATE SET last_ingested_at = excluded.last_ingested_at
         WHERE excluded.last_ingested_at > cursors.last_ingested_at",
        params![uid, manager_id, last_ingested_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn cursors(conn: &Connection, uid: &str) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT manager_id, last_ingested_at FROM cursors WHERE uid = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![uid], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (manager_id, at) = row.map_err(|e| e.to_string())?;
        out.insert(manager_id, at);
    }
    Ok(out)
}

/// Drops faded, surplus and stale rows for one manager. Runs after every ingest.
pub fn prune(conn: &Connection, uid: &str, manager_id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM rows WHERE uid = ?1 AND manager_id = ?2 AND tombstone = 1 AND tombstoned_at_ms < ?3",
        params![uid, manager_id, now - TOMBSTONE_KEEP_MS],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM rows WHERE uid = ?1 AND manager_id = ?2 AND type = 'thread' AND closed_at_ms <> 0 AND closed_at_ms < ?3",
        params![uid, manager_id, now - CLOSED_THREAD_KEEP_MS],
    )
    .map_err(|e| e.to_string())?;
    // Decay: a fact or outcome whose effective confidence fell under 1 is gone.
    let mut faded: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT type, key_hash, confidence, updated_at_ms FROM rows
                 WHERE uid = ?1 AND manager_id = ?2 AND tombstone = 0 AND type IN ('fact', 'outcome')",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![uid, manager_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (type_name, hash, confidence, updated) = row.map_err(|e| e.to_string())?;
            let Some(row_type) = RowType::parse(&type_name) else { continue };
            if effective_confidence(row_type, confidence, updated, now) < 1.0 {
                faded.push((type_name, hash));
            }
        }
    }
    for (type_name, hash) in faded {
        conn.execute(
            "DELETE FROM rows WHERE uid = ?1 AND manager_id = ?2 AND type = ?3 AND key_hash = ?4",
            params![uid, manager_id, type_name, hash],
        )
        .map_err(|e| e.to_string())?;
    }
    // Caps: the oldest live rows past each type's cap go. Threads count open rows only.
    for row_type in [RowType::Fact, RowType::Outcome, RowType::Preference, RowType::Reported, RowType::Thread] {
        let closed_filter = if row_type == RowType::Thread { " AND closed_at_ms = 0" } else { "" };
        let sql = format!(
            "DELETE FROM rows WHERE uid = ?1 AND manager_id = ?2 AND type = ?3 AND tombstone = 0{closed_filter}
             AND key_hash NOT IN (
                SELECT key_hash FROM rows WHERE uid = ?1 AND manager_id = ?2 AND type = ?3 AND tombstone = 0{closed_filter}
                ORDER BY updated_at_ms DESC LIMIT ?4
             )"
        );
        conn.execute(&sql, params![uid, manager_id, row_type.as_str(), row_type.cap()])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every live row of a manager, decrypted. A row that will not decrypt is skipped.
pub fn live_rows(conn: &Connection, key: &[u8; 32], uid: &str, manager_id: &str, include_closed: bool) -> Result<Vec<(LiveRow, String, String, bool)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT type, key_hash, body, confidence, updated_at_ms, closed_at_ms FROM rows
             WHERE uid = ?1 AND manager_id = ?2 AND tombstone = 0
             ORDER BY updated_at_ms DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![uid, manager_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (type_name, hash, body, confidence, updated, closed_at) = row.map_err(|e| e.to_string())?;
        let Some(row_type) = RowType::parse(&type_name) else { continue };
        let closed = closed_at != 0;
        if closed && !include_closed {
            continue;
        }
        let Ok(json) = unseal(key, &body, &row_aad(uid, manager_id, &type_name, &hash)) else { continue };
        let Ok(parsed) = serde_json::from_str::<Body>(&json) else { continue };
        out.push((
            LiveRow {
                row_type,
                key: parsed.key,
                text: parsed.text,
                source: parsed.source,
                confidence,
                updated_at_ms: updated,
            },
            hash,
            parsed.session_id,
            closed,
        ));
    }
    Ok(out)
}

pub fn list(conn: &Connection, key: &[u8; 32], uid: &str, manager_id: &str) -> Result<Vec<RowView>, String> {
    let now = now_ms();
    Ok(live_rows(conn, key, uid, manager_id, true)?
        .into_iter()
        .map(|(row, hash, session_id, closed)| RowView {
            id: format!("{}:{hash}", row.row_type.as_str()),
            row_type: row.row_type.as_str().to_string(),
            confidence: effective_confidence(row.row_type, row.confidence, row.updated_at_ms, now).round() as i64,
            key: row.key,
            text: row.text,
            source: if row.source == "user" { "user_stated".to_string() } else { "observed".to_string() },
            updated_at_ms: row.updated_at_ms,
            session_id,
            closed,
        })
        .collect())
}

/// Tombstones the listed `type:key_hash` ids, and every live row a session wrote
/// when `session_id` is given. The stamp is "now", which is what beats a late sweep.
pub fn forget(conn: &Connection, key: &[u8; 32], uid: &str, manager_id: &str, row_ids: &[String], session_id: &str) -> Result<u32, String> {
    let now = now_ms();
    let mut targets: Vec<(String, String)> = row_ids
        .iter()
        .filter_map(|id| id.split_once(':').map(|(t, h)| (t.to_string(), h.to_string())))
        .collect();
    if !session_id.is_empty() {
        for (row, hash, owner, _) in live_rows(conn, key, uid, manager_id, true)? {
            if owner == session_id {
                targets.push((row.row_type.as_str().to_string(), hash));
            }
        }
    }
    let mut count = 0u32;
    for (type_name, hash) in targets {
        count += conn
            .execute(
                "UPDATE rows SET tombstone = 1, tombstoned_at_ms = ?5, closed_at_ms = 0
                 WHERE uid = ?1 AND manager_id = ?2 AND type = ?3 AND key_hash = ?4 AND tombstone = 0",
                params![uid, manager_id, type_name, hash, now],
            )
            .map_err(|e| e.to_string())? as u32;
    }
    Ok(count)
}

pub fn delete_manager(conn: &Connection, uid: &str, manager_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM rows WHERE uid = ?1 AND manager_id = ?2", params![uid, manager_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM cursors WHERE uid = ?1 AND manager_id = ?2", params![uid, manager_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Called from `security::session_changed` on every transition. Lets decay and
/// the caps run over OTHER accounts' managers and deletes nothing of the current
/// account's; isolation already holds through the uid scope on every read and
/// the uid in every AAD. Never wipe on a switch: these rows exist nowhere else.
pub fn retain_only_for_session(app: &AppHandle, uid: Option<&str>) {
    let Some(uid) = uid.filter(|uid| !uid.is_empty()) else {
        log::warn!("swarm_memory.store: prune skipped, no uid to scope by");
        return;
    };
    let Ok(conn) = open(app) else { return };
    let others: Vec<(String, String)> = {
        let Ok(mut stmt) = conn.prepare("SELECT DISTINCT uid, manager_id FROM rows WHERE uid <> ?1") else { return };
        let Ok(rows) = stmt.query_map(params![uid], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else { return };
        rows.filter_map(Result::ok).collect()
    };
    let now = now_ms();
    for (other_uid, manager_id) in others {
        if let Err(e) = prune(&conn, &other_uid, &manager_id, now) {
            log::warn!("swarm_memory.store: retain_only_for_session failed: {e}");
        }
    }
}

// ---- ISO 8601 helpers (no chrono in this crate) ----

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.frac][Z|+HH:MM|-HH:MM]` to epoch milliseconds.
pub fn parse_iso_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.len() < 19 {
        return None;
    }
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let rest = &s[19..];
    let mut frac_ms = 0i64;
    let mut offset_min = 0i64;
    let mut tail = rest;
    if let Some(after_dot) = tail.strip_prefix('.') {
        let digits: String = after_dot.chars().take_while(|c| c.is_ascii_digit()).collect();
        let padded = format!("{:0<3}", digits.chars().take(3).collect::<String>());
        frac_ms = padded.parse().ok()?;
        tail = &after_dot[digits.len()..];
    }
    match tail.chars().next() {
        None | Some('Z') | Some('z') => {}
        Some(sign @ ('+' | '-')) => {
            let oh = tail.get(1..3)?.parse::<i64>().ok()?;
            let om = tail.get(4..6).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            offset_min = oh * 60 + om;
            if sign == '-' {
                offset_min = -offset_min;
            }
        }
        _ => return None,
    }
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + frac_ms)
}

/// Formats epoch milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn format_iso_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}
