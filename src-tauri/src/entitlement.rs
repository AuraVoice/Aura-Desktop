use log::{error, warn};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::util::now_ms;

const ENTITLEMENT_STORE: &str = "entitlement.json";
const CACHE_KEY: &str = "cached";

/// Within this window the cached entitlement is "fresh" and a relaunch trusts
/// it without a backend read (SUBSCRIPTION_PLAN.md Flow 2: TTL ~12h).
const FRESH_TTL_MS: i64 = 12 * 60 * 60 * 1000;
/// A failed fetch may lean on the cache up to this old (the 7-day offline
/// grace); beyond it, the frontend degrades to free.
const GRACE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// What `cached_entitlement` hands back to the frontend: the entitlement JSON
/// exactly as the backend returned it, plus whether it is still fresh (< 12h).
#[derive(Serialize)]
pub struct CachedEntitlement {
    entitlement: Value,
    fresh: bool,
}

/// Persists a freshly fetched entitlement to the store, stamped with the
/// current wall clock and the Firebase uid it belongs to. Called by the
/// frontend ONLY after a successful GET /entitlement, so a failed fetch can
/// never overwrite a good cache - the same "write the cache only after the
/// side effect succeeded" rule the overlay's applied-presentation cache
/// follows (overlay.rs). The uid keys the cache to one account: without it, a
/// paid user's cache could serve a different account that signs in later on
/// the same machine.
#[tauri::command]
pub async fn cache_entitlement(app: AppHandle, uid: String, entitlement: Value) -> Result<(), String> {
    let store = app.store(ENTITLEMENT_STORE).map_err(|e| {
        error!("cache_entitlement: failed to open store: {e}");
        sentry::capture_message(
            &format!("cache_entitlement: failed to open store: {e}"),
            sentry::Level::Error,
        );
        e.to_string()
    })?;
    store.set(
        CACHE_KEY,
        serde_json::json!({ "uid": uid, "entitlement": entitlement, "fetched_at_ms": now_ms() }),
    );
    Ok(())
}

/// Returns the cached entitlement when one exists for THIS uid AND is within
/// the 7-day offline grace window; otherwise `None`, which the frontend reads
/// as "degrade to free". A uid mismatch (another account's leftover cache) and
/// a legacy pre-uid entry are both treated as no-cache, never served. `fresh`
/// tells the caller whether the copy is < 12h old (trust it without a
/// re-fetch) or should be refreshed in the background.
#[tauri::command]
pub async fn cached_entitlement(app: AppHandle, uid: String) -> Result<Option<CachedEntitlement>, String> {
    let store = app.store(ENTITLEMENT_STORE).map_err(|e| {
        error!("cached_entitlement: failed to open store: {e}");
        e.to_string()
    })?;

    let Some(value) = store.get(CACHE_KEY) else {
        return Ok(None); // expected on first run - nothing cached yet
    };

    let cached_uid = value.get("uid").and_then(Value::as_str);
    if cached_uid != Some(uid.as_str()) {
        // Another account's entry, or an old-shape entry without a uid. The
        // next successful fetch rewrites the new shape for the current user.
        return Ok(None);
    }

    let fetched_at = value.get("fetched_at_ms").and_then(Value::as_i64);
    let entitlement = value.get("entitlement").cloned();
    let (Some(fetched_at), Some(entitlement)) = (fetched_at, entitlement) else {
        warn!("cached_entitlement: malformed cache entry: {value:?}");
        return Ok(None);
    };

    // A clock rolled back yields a negative age; treat that as fresh rather than
    // beyond grace (a bounded, accepted desktop posture per SUBSCRIPTION_PLAN's
    // edge cases). Only a genuinely old cache falls out of the grace window.
    let age_ms = now_ms() - fetched_at;
    if age_ms > GRACE_TTL_MS {
        return Ok(None);
    }

    Ok(Some(CachedEntitlement {
        entitlement,
        fresh: age_ms <= FRESH_TTL_MS,
    }))
}

/// Removes the cached entitlement entirely. Called on sign-out so the next
/// account on this machine can never inherit the previous account's plan.
#[tauri::command]
pub async fn clear_entitlement_cache(app: AppHandle) -> Result<(), String> {
    let store = app.store(ENTITLEMENT_STORE).map_err(|e| {
        error!("clear_entitlement_cache: failed to open store: {e}");
        e.to_string()
    })?;
    store.delete(CACHE_KEY);
    Ok(())
}
