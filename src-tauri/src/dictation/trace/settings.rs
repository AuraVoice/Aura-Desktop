//! The opt-in switch and its retention policy.
//!
//! Kept in a plain JSON file next to the trace store rather than in the Tauri
//! store the dashboard uses for everything else, for one reason: the dictation
//! worker has to read `enabled` on the insert path, and reaching into a
//! JavaScript-owned store from there would mean an IPC round trip in front of
//! the user's keystrokes. It is cached in memory and only re-read when written.
//!
//! Not encrypted, because it holds no user content: a boolean, a day count, and
//! a list of executable names the user chose to exclude. The trace data itself
//! is encrypted; see `store.rs`.

#![cfg(windows)]

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const SETTINGS_FILE: &str = "settings.json";

/// Retention choices offered in the UI. Anything else the file might contain is
/// clamped into this range on load.
pub const MIN_RETENTION_DAYS: u32 = 1;
pub const MAX_RETENTION_DAYS: u32 = 365;

/// Ceilings the user does not set. Surfaced read-only so the settings page can
/// explain what "and then it stops growing" actually means.
pub const MAX_TRACES: usize = 500;
pub const MAX_AUDIO_BYTES: u64 = 512 * 1024 * 1024;

/// The version of the sharing consent text currently published in
/// `LEGAL_ADDENDUM_DRAFT.md`.
///
/// Bump this whenever that wording changes in a way that alters what the user
/// is agreeing to. A stored consent below this number is treated as no consent
/// at all: sharing switches itself off and the user is asked again, rather than
/// being silently carried into terms they never read.
pub const CONSENT_VERSION: u32 = 2;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSettings {
    /// The opt-in. Default false, and nothing is captured, no directory is
    /// created and no field is read until it is true.
    #[serde(default)]
    pub enabled: bool,
    /// Keep the utterance audio. Off means text-only traces: still useful for
    /// spotting which words the recognizer gets wrong, but not trainable,
    /// because a NeMo manifest line needs an audio file.
    #[serde(default = "default_true")]
    pub capture_audio: bool,
    #[serde(default = "default_retention")]
    pub retention_days: u32,
    /// Executable stems the user never wants traced, on top of the built-in
    /// list in `uia::anchor`.
    #[serde(default)]
    pub excluded_apps: Vec<String>,
    /// Upload settled traces, audio and text, to Aura. A SEPARATE decision from
    /// `enabled`: consenting to have your speech recorded on your own PC is not
    /// consenting to send it anywhere, and collapsing the two would make the
    /// local-only promise on the first toggle untrue.
    #[serde(default)]
    pub sharing_enabled: bool,
    /// Which consent version the user accepted when they turned sharing on.
    #[serde(default)]
    pub consent_version: u32,
}

fn default_true() -> bool {
    true
}

fn default_retention() -> u32 {
    30
}

impl Default for TraceSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            capture_audio: true,
            retention_days: default_retention(),
            excluded_apps: Vec::new(),
            sharing_enabled: false,
            consent_version: 0,
        }
    }
}

impl TraceSettings {
    fn sanitized(mut self) -> Self {
        self.retention_days = self
            .retention_days
            .clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS);
        // Sharing cannot outlive the thing it shares, and cannot survive a
        // consent-text change. Both are enforced here rather than at each call
        // site so no path can leave a stale consent switched on.
        if !self.enabled || self.consent_version < CONSENT_VERSION {
            self.sharing_enabled = false;
        }
        if self.sharing_enabled {
            self.consent_version = CONSENT_VERSION;
        }
        self.excluded_apps = self
            .excluded_apps
            .iter()
            .map(|app| app.trim().to_ascii_lowercase())
            .filter(|app| !app.is_empty())
            .take(128)
            .collect();
        self.excluded_apps.sort();
        self.excluded_apps.dedup();
        self
    }

    pub fn excludes(&self, app: &str) -> bool {
        let app = app.to_ascii_lowercase();
        self.excluded_apps.contains(&app)
    }

    /// Sharing is genuinely on, under current terms. `sanitized` already
    /// enforces this, so this is a readable name for the check rather than a
    /// second source of truth.
    pub fn shares(&self) -> bool {
        self.enabled && self.sharing_enabled && self.consent_version >= CONSENT_VERSION
    }
}

/// The in-memory copy every reader shares. Cloned cheaply on the hot path.
pub type SharedSettings = Arc<Mutex<TraceSettings>>;

pub fn load(app: &AppHandle) -> TraceSettings {
    let Ok(path) = super::store::trace_dir(app) else {
        return TraceSettings::default();
    };
    let Ok(raw) = std::fs::read_to_string(path.join(SETTINGS_FILE)) else {
        return TraceSettings::default();
    };
    serde_json::from_str::<TraceSettings>(&raw)
        .map(TraceSettings::sanitized)
        .unwrap_or_default()
}

/// Writes the settings, creating the trace directory if this is the first time
/// the feature has ever been switched on.
pub fn save(app: &AppHandle, settings: TraceSettings) -> Result<TraceSettings, String> {
    let settings = settings.sanitized();
    let dir = super::store::trace_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    super::store::write_atomically(&dir.join(SETTINGS_FILE), &body)?;
    Ok(settings)
}

pub fn shared(settings: TraceSettings) -> SharedSettings {
    Arc::new(Mutex::new(settings))
}

pub fn snapshot(shared: &SharedSettings) -> TraceSettings {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}
