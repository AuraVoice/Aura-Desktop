//! Optional AI cleanup of the finished transcript, before it is typed.
//!
//! Off by default. When the user switches it on, the transcript (text only,
//! never audio) goes to `POST /dictation/polish` on juno-backend, which holds
//! the LLM provider key and does the actual formatting call. No provider key
//! exists in this process, the bundle, or the installer - the same posture as
//! transcription itself (credential.rs).
//!
//! Auth follows the credential.rs pattern exactly: React mints (a Firebase ID
//! token via `usePolishCredential`), Rust holds it in RAM only, refreshed
//! ahead of expiry so the keyup path never pays a minting round trip. Same
//! storage rules: no Serialize, no Debug, never disk.
//!
//! The worker blocks on an mpsc `recv_timeout`, the same shape as
//! `session.await_final`: the HTTP request runs on the async runtime and a
//! late reply after the timeout is dropped on a dead channel. Every failure -
//! timeout, network, auth, off-script reply - falls back to the unformatted
//! text, so dictation can never hang or lose words on this step.
//!
//! Settings live in a plain JSON file (no user content, same rationale as
//! trace/settings.rs: the worker reads the flag on the insert path and must
//! not IPC there).
//!
//! Logging discipline is the module-wide one (mod.rs header): outcomes,
//! durations and character counts only. Never the transcript, the reply, a
//! request body, or a raw error string that could carry one.


use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::vocab;

const SETTINGS_FILE: &str = "polish.json";

/// Mirrors `API_BASE_URL` in `src/lib/api.ts`. Rust needs it here because the
/// polish call runs on the dictation worker, in front of the keystrokes, and
/// must not IPC to the webview to learn where the backend lives.
const API_BASE_URL: &str = "https://juno-backend-620715294422.us-central1.run.app";

/// Total wall-clock the worker will wait before typing the raw text instead.
const WAIT_BUDGET: Duration = Duration::from_millis(2500);
/// The HTTP client gives up slightly earlier so the channel send beats the
/// recv_timeout and the outcome is a categorized error, not a silent drop.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1000);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(2300);

/// Refuse a token this close to its expiry, mirroring credential.rs: a token
/// that dies between keyup and the request would surface as a silent raw
/// fallback every time instead of a clean re-mint.
const EXPIRY_MARGIN: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolishSettings {
    /// The opt-in. The model and prompt are the backend's decision.
    #[serde(default)]
    pub enabled: bool,
}

/// The Firebase ID token, alone in a struct so nothing can derive Debug over
/// it by accident (same discipline as credential.rs).
struct BackendToken {
    token: String,
    expires_at: Instant,
}

struct PolishState {
    settings: PolishSettings,
    token: Option<BackendToken>,
}

/// Managed in lib.rs at startup; the worker takes one mutex per utterance.
pub struct PolishHandle {
    state: Arc<Mutex<PolishState>>,
}

pub fn handle(app: &AppHandle) -> Option<tauri::State<'_, PolishHandle>> {
    app.try_state::<PolishHandle>()
}

/// Reads the settings once. Cheap when the feature has never been touched:
/// the read misses and defaults to off.
pub fn start(app: AppHandle) -> PolishHandle {
    let settings = load_settings(&app);
    let handle = PolishHandle {
        state: Arc::new(Mutex::new(PolishState {
            settings,
            token: None,
        })),
    };
    handle.warm_if_wanted();
    handle
}

impl PolishHandle {
    pub fn snapshot(&self) -> PolishSettings {
        self.state.lock().expect("polish state lock").settings.clone()
    }

    pub fn apply_settings(&self, next: PolishSettings) {
        let mut state = self.state.lock().expect("polish state lock");
        state.settings = next;
        drop(state);
        self.warm_if_wanted();
    }

    /// Stores a fresh Firebase ID token from the webview's refresh pump.
    /// Duration only in the log - never the token, its length, or a prefix.
    pub fn set_token(&self, token: String, ttl: Duration) {
        let mut state = self.state.lock().expect("polish state lock");
        state.token = Some(BackendToken {
            token,
            expires_at: Instant::now() + ttl,
        });
        drop(state);
        info!("dictation: phase=polish credential=stored ttl_s={}", ttl.as_secs());
        self.warm_if_wanted();
    }

    /// Drops the token on sign-out, so it cannot outlive the session that was
    /// allowed to have it.
    pub fn clear_token(&self) {
        let mut state = self.state.lock().expect("polish state lock");
        if state.token.take().is_some() {
            info!("dictation: phase=polish credential=cleared");
        }
    }

    fn usable(&self) -> Option<String> {
        let mut state = self.state.lock().expect("polish state lock");
        if !state.settings.enabled {
            return None;
        }
        let expired = state
            .token
            .as_ref()
            .is_some_and(|token| Instant::now() + EXPIRY_MARGIN >= token.expires_at);
        if expired {
            state.token = None;
            return None;
        }
        state.token.as_ref().map(|token| token.token.clone())
    }

    /// Fire-and-forget TLS warmup so the handshake is not paid inside the
    /// keyup budget of the first polished utterance. No token is sent.
    fn warm_if_wanted(&self) {
        if self.usable().is_none() {
            return;
        }
        tauri::async_runtime::spawn(async {
            let _ = client().head(API_BASE_URL).send().await;
        });
    }
}

/// Whether the insert path should attempt a polish at all. One lock.
pub fn wants(app: &AppHandle) -> bool {
    handle(app).is_some_and(|handle| handle.usable().is_some())
}

// ---------------------------------------------------------------------------
// Settings persistence

fn load_settings(app: &AppHandle) -> PolishSettings {
    let Ok(dir) = vocab::dictation_dir(app) else {
        return PolishSettings::default();
    };
    let Ok(raw) = std::fs::read_to_string(dir.join(SETTINGS_FILE)) else {
        return PolishSettings::default();
    };
    serde_json::from_str::<PolishSettings>(&raw).unwrap_or_default()
}

/// Writes the settings and returns the stored truth.
pub fn save_settings(app: &AppHandle, settings: PolishSettings) -> Result<PolishSettings, String> {
    let dir = vocab::dictation_dir(app)?;
    let body = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    crate::fsx::write_atomic(&dir.join(SETTINGS_FILE), &body, crate::fsx::Durability::Fsync)?;
    Ok(settings)
}

// ---------------------------------------------------------------------------
// The request

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("polish http client")
    })
}

enum PolishError {
    Timeout,
    Auth,
    Unavailable,
    Http,
    Invalid,
}

impl PolishError {
    fn outcome(&self) -> &'static str {
        match self {
            PolishError::Timeout => "timeout",
            PolishError::Auth => "http_401",
            PolishError::Unavailable => "http_503",
            PolishError::Http => "http_other",
            PolishError::Invalid => "invalid",
        }
    }
}

#[derive(Deserialize)]
struct PolishResponse {
    text: String,
}

async fn request_polish(
    token: String,
    text: String,
    app_name: Option<String>,
) -> Result<String, PolishError> {
    let body = serde_json::json!({
        "text": text,
        "app": app_name,
    });
    let response = client()
        .post(format!("{API_BASE_URL}/dictation/polish"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                PolishError::Timeout
            } else {
                PolishError::Http
            }
        })?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err(PolishError::Auth),
        503 => return Err(PolishError::Unavailable),
        _ => return Err(PolishError::Http),
    }
    let parsed: PolishResponse = response.json().await.map_err(|_| PolishError::Invalid)?;
    Ok(parsed.text)
}

/// Rejects replies that went off-script: empty, wrapped in a fence or quote
/// pair, or wildly different in length from the input (commands like "bullet
/// list" expand, filler removal shrinks; 0.25x to 4x covers both). A backstop
/// behind the backend's own validation, because what comes back goes straight
/// into keystrokes.
fn validate(input: &str, output: &str) -> Option<String> {
    let mut text = output.trim();
    if let Some(stripped) = text.strip_prefix("```") {
        if let Some(stripped) = stripped.strip_suffix("```") {
            // A fenced reply may open with a language tag on the fence line;
            // drop that first line only when it is a single bare word.
            text = match stripped.split_once('\n') {
                Some((tag, rest))
                    if tag.trim().chars().all(|c| c.is_ascii_alphanumeric()) =>
                {
                    rest.trim()
                }
                _ => stripped.trim(),
            };
        }
    }
    if text.len() >= 2 {
        let quoted = (text.starts_with('"') && text.ends_with('"'))
            || (text.starts_with('\u{201c}') && text.ends_with('\u{201d}'));
        if quoted && !input.trim().starts_with('"') {
            text = &text[text.chars().next()?.len_utf8()..];
            text = &text[..text.len() - text.chars().next_back()?.len_utf8()];
            text = text.trim();
        }
    }
    if text.is_empty() {
        return None;
    }
    let input_chars = input.chars().count().max(1);
    let output_chars = text.chars().count();
    if output_chars * 4 < input_chars || output_chars > input_chars * 4 {
        return None;
    }
    Some(text.replace("\r\n", "\n").replace('\r', "\n"))
}

/// Formats the transcript, or returns None and the caller types the raw text.
/// Blocks the worker for at most `WAIT_BUDGET`. Logs outcome, duration and
/// character counts only.
pub fn format_transcript(app: &AppHandle, text: &str, app_name: Option<&str>) -> Option<String> {
    let polish_handle = handle(app)?;
    let token = polish_handle.usable()?;
    let started = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    let owned_text = text.to_string();
    let owned_app = app_name.map(|name| name.to_string());
    tauri::async_runtime::spawn(async move {
        let result = request_polish(token, owned_text, owned_app).await;
        let _ = tx.send(result);
    });
    let result = match rx.recv_timeout(WAIT_BUDGET) {
        Ok(result) => result,
        Err(_) => Err(PolishError::Timeout),
    };
    let chars_in = text.chars().count();
    let formatting_ms = started.elapsed().as_millis();
    if formatting_ms > 2000 {
        warn!("dictation: phase=polish target_miss=polish formatting_ms={formatting_ms}");
    }
    match result {
        Ok(reply) => match validate(text, &reply) {
            Some(cleaned) => {
                info!(
                    "dictation: phase=polish outcome=ok formatting_ms={formatting_ms} \
                     chars_in={chars_in} chars_out={}",
                    cleaned.chars().count()
                );
                Some(cleaned)
            }
            None => {
                info!(
                    "dictation: phase=polish outcome=invalid formatting_ms={formatting_ms} \
                     chars_in={chars_in}"
                );
                None
            }
        },
        Err(error) => {
            info!(
                "dictation: phase=polish outcome={} formatting_ms={formatting_ms} \
                 chars_in={chars_in}",
                error.outcome()
            );
            if matches!(error, PolishError::Auth) {
                // The backend refused this token; drop it so the webview's
                // refresh pump replaces it rather than it being retried.
                polish_handle.clear_token();
            }
            None
        }
    }
}
