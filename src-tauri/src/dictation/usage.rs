//! Privacy-safe local dictation totals for the user-facing Insights page.
//!
//! Only an hourly timestamp and a word count are stored. Transcript text,
//! audio, application names, and field information never enter this store.

#![cfg(windows)]

use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use super::DictationUsageEntry;

const USAGE_STORE: &str = "dictation-usage.json";
const HOUR_MS: i64 = 60 * 60 * 1_000;
const RETENTION_MS: i64 = 120 * 24 * HOUR_MS;

fn usage_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

fn store_key(uid: &str) -> String {
    format!("account:{uid}")
}

fn read_entries(app: &AppHandle, uid: &str) -> Result<Vec<DictationUsageEntry>, String> {
    let store = app
        .store(USAGE_STORE)
        .map_err(|error| format!("could not open the dictation usage store: {error}"))?;
    store
        .get(store_key(uid))
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("could not read dictation usage: {error}"))
        .map(|entries| entries.unwrap_or_default())
}

pub fn word_count(text: &str) -> u64 {
    let mut words = 0u64;
    let mut in_word = false;
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character.is_alphanumeric() {
            if !in_word {
                words += 1;
                in_word = true;
            }
        } else if !matches!(character, '\'' | '’' | '-')
            || !in_word
            || !characters.peek().is_some_and(|next| next.is_alphanumeric())
        {
            in_word = false;
        }
    }
    words
}

pub fn record_later(app: &AppHandle, words: u64) {
    if words == 0 {
        return;
    }
    let Some(uid) = crate::security::current_uid(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = record(&app, &uid, words) {
            log::warn!("dictation.usage: local count was not saved: {error}");
        }
    });
}

fn record(app: &AppHandle, uid: &str, words: u64) -> Result<(), String> {
    let _guard = usage_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = now_ms();
    let bucket = now - now.rem_euclid(HOUR_MS);
    let cutoff = now.saturating_sub(RETENTION_MS);
    let mut entries = read_entries(app, uid)?;
    let expired = entries.partition_point(|entry| entry.recorded_at_ms < cutoff);
    entries.drain(..expired);
    match entries.binary_search_by_key(&bucket, |entry| entry.recorded_at_ms) {
        Ok(index) => {
            entries[index].words = entries[index].words.saturating_add(words);
        }
        Err(index) => entries.insert(index, DictationUsageEntry {
            recorded_at_ms: bucket,
            words,
        }),
    }
    let store = app
        .store(USAGE_STORE)
        .map_err(|error| format!("could not open the dictation usage store: {error}"))?;
    store.set(
        store_key(uid),
        serde_json::to_value(entries)
            .map_err(|error| format!("could not encode dictation usage: {error}"))?,
    );
    store
        .save()
        .map_err(|error| format!("could not save dictation usage: {error}"))
}

pub fn entries(app: &AppHandle, uid: &str) -> Result<Vec<DictationUsageEntry>, String> {
    let _guard = usage_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let cutoff = now_ms().saturating_sub(RETENTION_MS);
    let mut entries = read_entries(app, uid)?;
    let expired = entries.partition_point(|entry| entry.recorded_at_ms < cutoff);
    entries.drain(..expired);
    Ok(entries)
}
