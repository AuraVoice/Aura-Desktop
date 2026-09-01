//! Local SQLite cache for the desktop chat transcript, encrypted at rest.
//!
//! This is a rendering cache, never a source of truth. Firestore (through the
//! backend's `/desktop/chat/*` endpoints) owns the transcript; this file exists
//! so the overlay can paint the last conversation the instant it opens instead
//! of waiting on a network round trip, and so a message the user just sent is
//! still on screen after a crash. Every write is best-effort: the JS wrapper
//! swallows failures, so a corrupt or unwritable database degrades to "no cache"
//! and can never block a send.
//!
//! ## Encryption
//!
//! Message text is stored as AES-256-GCM ciphertext under the same
//! DPAPI-wrapped key the meeting capture pipeline and `saved_images.rs` use.
//! Chat content is at least as sensitive as a recording, so it does not get the
//! plaintext treatment the dashboard's JSON caches use for their own content.
//! Ids, sequence numbers and timestamps stay in the clear so ordering, pruning
//! and the latest-conversation lookup remain plain index reads.
//!
//! Each row's AAD is `{uid}:{conversation_id}:{message_id}`, so a row cannot be
//! replayed into another account, another conversation, or another message slot
//! even by hand-editing the database. A row that fails to decrypt is SKIPPED
//! rather than fatal: a rotated key or a copied file degrades to an empty cache
//! instead of a broken chat.
//!
//! The crypto module is Windows-only, so on other platforms these commands are
//! quiet no-ops. They never fall back to writing readable text.
//!
//! ## Account isolation
//!
//! Three overlapping mechanisms, deliberately: every row carries its `uid`,
//! every query filters on the caller's uid, and `security::session_changed`
//! prunes the file whenever the signed-in uid changes. The last one matters
//! most, since it does not depend on the webview running any cleanup code.
//!
//! Screenshots are NOT stored here in any form; `has_attachments` is the only
//! trace a screen-context turn leaves behind, matching the Firestore schema.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::meeting::crypto;

const DATABASE_FILE: &str = "chat-cache.sqlite3";

/// Whether message text can be sealed. Key wrapping is per-OS (crypto.rs) but
/// present on every shipping platform, so this stays true; a runtime keystore
/// failure surfaces as an Err from `cache_key`, never as a silent no-op.
const ENCRYPTION_AVAILABLE: bool = true;

/// One cached message. Field names mirror the canonical Firestore message
/// document so hydration can round-trip a server row through the cache without
/// a second mapping layer. `text` is plaintext in this struct (it crosses only
/// the in-process IPC boundary) and is sealed before it reaches disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedMessage {
    pub message_id: String,
    pub client_message_id: String,
    pub conversation_id: String,
    pub role: String,
    pub text: String,
    pub status: String,
    pub seq: i64,
    /// Epoch milliseconds. The client supplies this so ordering survives a
    /// round trip through the server's ISO timestamps.
    pub created_at_ms: i64,
    pub has_attachments: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CachedConversation {
    pub conversation_id: String,
    pub messages: Vec<CachedMessage>,
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(DATABASE_FILE))
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS messages (
            uid TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            client_message_id TEXT NOT NULL,
            role TEXT NOT NULL,
            text BLOB NOT NULL,
            status TEXT NOT NULL,
            seq INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            has_attachments INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (uid, conversation_id, message_id)
         );
         CREATE INDEX IF NOT EXISTS messages_order
            ON messages (uid, conversation_id, seq, created_at_ms);
         CREATE INDEX IF NOT EXISTS messages_recent
            ON messages (uid, created_at_ms);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Binds a row's ciphertext to exactly one account, conversation and message.
/// FROZEN grammar (unversioned, colon-joined): existing sealed rows decrypt
/// only under exactly this string, so it cannot change. New stores use
/// sealed_store::aad instead.
fn row_aad(uid: &str, conversation_id: &str, message_id: &str) -> String {
    format!("{uid}:{conversation_id}:{message_id}")
}

fn cache_key(app: &AppHandle) -> Result<[u8; 32], String> {
    crypto::load_or_create_key(app)
}

use crate::sealed_store::{seal, unseal};

/// Replaces one conversation's cached messages wholesale.
///
/// Delete-then-insert inside a single transaction, NOT an upsert. A retry mints
/// a fresh client_message_id and re-keys its bubble, so an upsert would leave
/// the old row behind for the next cache-first paint to resurrect as a
/// duplicate. The caller always holds the complete conversation, so replacing is
/// both correct and cheap at these sizes.
#[tauri::command]
pub async fn chat_cache_replace(
    app: AppHandle,
    uid: String,
    conversation_id: String,
    messages: Vec<CachedMessage>,
) -> Result<(), String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() || conversation_id.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = cache_key(&app)?;
        let mut conn = open(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM messages WHERE uid = ?1 AND conversation_id = ?2",
            params![uid, conversation_id],
        )
        .map_err(|e| e.to_string())?;
        for message in &messages {
            let sealed = seal(
                &key,
                &message.text,
                &row_aad(&uid, &conversation_id, &message.message_id),
            )?;
            tx.execute(
                "INSERT OR REPLACE INTO messages (
                    uid, conversation_id, message_id, client_message_id, role, text,
                    status, seq, created_at_ms, has_attachments
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    uid,
                    conversation_id,
                    message.message_id,
                    message.client_message_id,
                    message.role,
                    sealed,
                    message.status,
                    message.seq,
                    message.created_at_ms,
                    i64::from(message.has_attachments),
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Loads one conversation, newest `limit` messages, returned in send order.
/// With no `conversation_id` it resolves the account's most recently touched
/// conversation, which is what the overlay wants on a cold start.
#[tauri::command]
pub async fn chat_cache_load(
    app: AppHandle,
    uid: String,
    conversation_id: Option<String>,
    limit: i64,
) -> Result<Option<CachedConversation>, String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Ok(None);
    }
    let capped = limit.clamp(1, 500);
    tauri::async_runtime::spawn_blocking(move || {
        let key = cache_key(&app)?;
        let conn = open(&app)?;
        let target = match conversation_id {
            Some(id) if !id.is_empty() => id,
            _ => {
                let latest: Option<String> = conn
                    .query_row(
                        "SELECT conversation_id FROM messages WHERE uid = ?1
                         ORDER BY created_at_ms DESC LIMIT 1",
                        params![uid],
                        |row| row.get(0),
                    )
                    .ok();
                match latest {
                    Some(id) => id,
                    None => return Ok(None),
                }
            }
        };
        // Newest first with the limit applied, then reversed, so a long
        // conversation keeps its most recent tail rather than its opening.
        let mut statement = conn
            .prepare(
                "SELECT message_id, client_message_id, role, text,
                        status, seq, created_at_ms, has_attachments
                 FROM messages WHERE uid = ?1 AND conversation_id = ?2
                 ORDER BY seq DESC, created_at_ms DESC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![uid, target, capped], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut messages: Vec<CachedMessage> = Vec::new();
        let mut undecryptable = 0usize;
        for row in rows {
            let (message_id, client_message_id, role, sealed, status, seq, created_at_ms, attach) =
                row.map_err(|e| e.to_string())?;
            // A row we cannot open is dropped, not fatal: a rotated key or a
            // database copied from another machine must degrade to a thinner
            // cache, never to a chat that refuses to render.
            let text = match unseal(&key, &sealed, &row_aad(&uid, &target, &message_id)) {
                Ok(text) => text,
                Err(_) => {
                    undecryptable += 1;
                    continue;
                }
            };
            messages.push(CachedMessage {
                message_id,
                client_message_id,
                conversation_id: target.clone(),
                role,
                text,
                status,
                seq,
                created_at_ms,
                has_attachments: attach != 0,
            });
        }
        if undecryptable > 0 {
            log::warn!("chat_cache: skipped {undecryptable} undecryptable row(s)");
        }
        messages.reverse();
        if messages.is_empty() {
            return Ok(None);
        }
        Ok(Some(CachedConversation {
            conversation_id: target,
            messages,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drops one account's cached chat, or every account's when `uid` is omitted.
/// Called on sign-out from React and unconditionally from the native session
/// boundary, so neither path alone is load-bearing.
#[tauri::command]
pub async fn chat_cache_clear(app: AppHandle, uid: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        match uid {
            Some(id) if !id.is_empty() => conn
                .execute("DELETE FROM messages WHERE uid = ?1", params![id])
                .map_err(|e| e.to_string())?,
            _ => conn
                .execute("DELETE FROM messages", [])
                .map_err(|e| e.to_string())?,
        };
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Native session boundary hook: keeps only the signed-in account's rows, and
/// keeps nothing at all once signed out.
///
/// Signing in must NOT wipe the current account's cache (that is exactly what
/// the overlay paints from on launch), so this prunes other accounts rather
/// than clearing outright. It also covers the case React cannot: a crash while
/// signed in as one account, then a fresh sign-in as another with no sign-out
/// in between. Fire-and-forget, since the session transition must not block on
/// disk IO and every read is uid-filtered anyway.
pub fn retain_only_for_session(app: &AppHandle, uid: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let conn = open(&app)?;
            match uid {
                Some(id) if !id.is_empty() => conn
                    .execute("DELETE FROM messages WHERE uid <> ?1", params![id])
                    .map_err(|e| e.to_string())?,
                _ => conn
                    .execute("DELETE FROM messages", [])
                    .map_err(|e| e.to_string())?,
            };
            Ok::<(), String>(())
        })
        .await;
        match result {
            Ok(Err(error)) => log::warn!("chat_cache: session prune failed: {error}"),
            Err(error) => log::warn!("chat_cache: session prune join failed: {error}"),
            Ok(Ok(())) => {}
        }
    });
}
