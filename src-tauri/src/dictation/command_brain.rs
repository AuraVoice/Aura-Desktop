//! Voice commands: route a finished dictation to a desktop action.
//!
//! Every short finished hold is put to Jev, TypeSafe's System One model, as
//! ONE typed decision over options this code enumerates: which action, which
//! installed app, which candidate span. Jev never generates text, it only
//! selects, so nothing it answers can name an app, verb or URL that this
//! module did not offer it first. Anything below the confidence gates, any
//! error, and any timeout falls through to the ordinary insert path.
//!
//! The call goes to `POST /dictation/command` on juno-backend, which holds the
//! TypeSafe key and adds the model name. No provider key exists in this
//! process, the bundle, or the installer - the same posture as transcription
//! (credential.rs) and polish (polish.rs). Unlike transcription there is no
//! provider-side ephemeral token to mint, so the whole call is proxied.
//!
//! Auth follows the credential.rs pattern exactly: React mints (a Firebase ID
//! token, the same one `authFetch` attaches), Rust holds it in RAM only, and
//! the pump refreshes ahead of expiry so a keyup never pays a minting round
//! trip. Same storage rules: no Serialize, no Debug, never disk. With no
//! credential yet pushed the module is inert and costs one lock per hold.
//!
//! The routing is deliberately asymmetric, because the two mistakes are not
//! the same size. A command typed as text costs one delete; text executed as
//! a command yanks an app onto screen and loses the sentence. So with no text
//! field focused (dictation has nowhere to land) a command acts at
//! `GATE_FREE`, while over a focused field it acts only when the user
//! addressed the assistant by name (`GATE_ADDRESSED`, judged by the model,
//! never by a word list) or the answer is overwhelming (`GATE_TYPING`).
//!
//! The request mirrors polish.rs exactly: the HTTP call runs on the async
//! runtime, the dictation worker blocks on an mpsc `recv_timeout`, and a late
//! reply lands on a dead channel. Logging discipline is the module-wide one
//! (mod.rs header): verbs, confidences, durations and outcomes only. Never
//! the transcript, a candidate span, or a raw reply.
//!
//! This module owns no secret at all. The only thing it holds is the user's
//! own short-lived Firebase ID token, in RAM, dropped on sign-out.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::keystore;
use super::scoped_token::ScopedToken;
use crate::util::lock;

const SETTINGS_FILE: &str = "command_brain.json";

/// Mirrors `API_BASE_URL` in `src/lib/api.ts`, for the same reason polish.rs
/// carries its own copy: this call runs on the dictation worker in front of
/// the keystrokes and must not IPC to the webview to learn where the backend
/// lives. The model name is the backend's business, not this module's.
const API_BASE_URL: &str = "https://juno-backend-620715294422.us-central1.run.app";

/// Total wall-clock the worker waits before treating the hold as dictation.
/// Wider than the 1500ms of the direct-to-provider version because the call
/// now goes through juno-backend. Measured warm on 2026-09-22: ~70ms to Cloud
/// Run plus ~150ms provider time, so this is about 9x the real round trip.
/// The service runs with min-instances=1 precisely so a cold start cannot eat
/// this budget and silently turn a command back into typed words.
const WAIT_BUDGET: Duration = Duration::from_millis(2000);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(800);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1800);

/// No text field focused: dictation has nowhere to land, act on a clear read.
const GATE_FREE: f64 = 0.60;
/// A text field is focused and the user addressed the assistant by name.
const GATE_ADDRESSED: f64 = 0.70;
/// A text field is focused and no address: only an overwhelming answer acts.
const GATE_TYPING: f64 = 0.90;

/// Commands are short. Longer utterances skip the round trip entirely, so a
/// paragraph of prose never pays the decision latency.
const MAX_COMMAND_WORDS: usize = 12;
/// The cap for a hold that opens with an address word ("hey aura, ..."): a
/// browser task is a sentence, and the address is the user's own signal that
/// this hold is for Buddy rather than the page. See `try_command`.
const ADDRESSED_MAX_COMMAND_WORDS: usize = 30;

/// Jev choices cap at 255 options, so this is the ceiling the list is cut to.
/// Beware what the cut MEANS: `enumerate_apps` collects into a `BTreeMap` keyed
/// by lowercase name, so truncating is ALPHABETICAL and silently drops the tail
/// (a machine over the cap loses "Spotify", "Teams", "VS Code" while keeping
/// every "Adobe ..."). What keeps a normal machine clear of the cap is the
/// filtering, not the number: measured on a working Windows 11 install, 189
/// AppsFolder entries plus 111 shortcuts come to 180 after the non-app and
/// noise filters. If this ever does start biting, the fix is a ranking signal,
/// not a bigger number.
const MAX_APPS: usize = 250;

/// How long the installed-app scan is trusted before it is redone.
const APPS_TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    enabled: bool,
}

impl Default for Settings {
    // Entering a key is the real opt-in, so the switch itself defaults on.
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Clone)]
struct AppEntry {
    /// What Jev chooses between and what the caption shows.
    name: String,
    /// What the platform launcher is handed: the .lnk path on Windows, the
    /// application name on macOS.
    launch: String,
}

struct State {
    settings: Settings,
    /// A Firebase ID token for `/dictation/command`, never a provider key.
    credential: ScopedToken,
    apps: Vec<AppEntry>,
    apps_read_at: Option<Instant>,
}

/// Managed in lib.rs at startup; the worker takes one mutex per utterance.
pub struct CommandBrainHandle {
    state: Arc<Mutex<State>>,
}

fn handle(app: &AppHandle) -> Option<tauri::State<'_, CommandBrainHandle>> {
    app.try_state::<CommandBrainHandle>()
}

/// Reads the settings once. Cheap when the feature has never been touched:
/// the read misses and the module stays inert until a credential arrives.
pub fn start(app: AppHandle) -> CommandBrainHandle {
    let settings = load_settings(&app);
    CommandBrainHandle {
        state: Arc::new(Mutex::new(State {
            settings,
            credential: ScopedToken::new("dictation.command.credential"),
            apps: Vec::new(),
            apps_read_at: None,
        })),
    }
}

impl CommandBrainHandle {
    fn usable(&self) -> Option<String> {
        let mut state = lock(&self.state);
        if !state.settings.enabled {
            return None;
        }
        state.credential.usable()
    }

    /// Stores a fresh Firebase ID token from the webview's refresh pump.
    /// Duration only in the log - never the token, its length, or a prefix.
    pub fn set_token(&self, token: String, ttl: Duration) {
        lock(&self.state).credential.set(token, ttl);
    }

    /// Drops the token on sign-out, so it cannot outlive the session that was
    /// allowed to have it.
    pub fn clear_token(&self) {
        lock(&self.state).credential.clear();
    }

    /// The installed-app registry, re-enumerated when stale. The scan is a
    /// bounded directory walk and runs on whichever thread asks, which is the
    /// dictation worker, never the thread pumping window messages.
    fn apps(&self) -> Vec<AppEntry> {
        {
            let state = lock(&self.state);
            if let Some(read_at) = state.apps_read_at {
                if read_at.elapsed() < APPS_TTL && !state.apps.is_empty() {
                    return state.apps.clone();
                }
            }
        }
        let apps = platform::enumerate_apps();
        let mut state = lock(&self.state);
        state.apps = apps.clone();
        state.apps_read_at = Some(Instant::now());
        apps
    }
}

// ---------------------------------------------------------------------------
// Settings and key persistence

fn load_settings(app: &AppHandle) -> Settings {
    let Ok(dir) = keystore::dictation_dir(app) else {
        return Settings::default();
    };
    let Ok(raw) = std::fs::read_to_string(dir.join(SETTINGS_FILE)) else {
        return Settings::default();
    };
    serde_json::from_str::<Settings>(&raw).unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: Settings) -> Result<Settings, String> {
    let dir = keystore::dictation_dir(app)?;
    let body = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    crate::fsx::write_atomic(&dir.join(SETTINGS_FILE), &body, crate::fsx::Durability::Fsync)?;
    Ok(settings)
}

// ---------------------------------------------------------------------------
// Tauri commands (registered in lib.rs by full path)

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSettingsView {
    pub enabled: bool,
    /// Whether the webview's credential pump has supplied a usable token yet.
    /// The page shows readiness with it; there is nothing for a user to enter.
    pub ready: bool,
}

fn view(app: &AppHandle) -> CommandSettingsView {
    match handle(app) {
        Some(handle) => {
            let mut state = lock(&handle.state);
            CommandSettingsView {
                enabled: state.settings.enabled,
                ready: state.credential.usable().is_some(),
            }
        }
        None => CommandSettingsView {
            enabled: false,
            ready: false,
        },
    }
}

#[tauri::command]
pub async fn dictation_command_settings(app: AppHandle) -> Result<CommandSettingsView, String> {
    Ok(view(&app))
}

#[tauri::command]
pub async fn dictation_set_command_settings(
    app: AppHandle,
    enabled: bool,
) -> Result<CommandSettingsView, String> {
    let next = Settings { enabled };
    let blocking_app = app.clone();
    let saved =
        tauri::async_runtime::spawn_blocking(move || save_settings(&blocking_app, next))
            .await
            .map_err(|e| e.to_string())??;
    if let Some(handle) = handle(&app) {
        lock(&handle.state).settings = saved;
    }
    Ok(view(&app))
}

/// Receives a fresh Firebase ID token from the webview's credential pump. The
/// token is never logged, never serialized, and never written to disk.
#[tauri::command]
pub async fn dictation_set_command_credential(
    app: AppHandle,
    id_token: String,
    ttl_seconds: u32,
) -> Result<(), String> {
    if let Some(handle) = handle(&app) {
        handle.set_token(id_token, Duration::from_secs(ttl_seconds.into()));
    }
    Ok(())
}

/// Drops the token on sign-out or account switch.
#[tauri::command]
pub async fn dictation_clear_command_credential(app: AppHandle) -> Result<(), String> {
    if let Some(handle) = handle(&app) {
        handle.clear_token();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The decision

/// A hold that was executed as a command rather than typed. The caption is
/// what the HUD shows; it names the action, never quotes the transcript.
pub(super) struct Executed {
    pub caption: String,
}

/// Routes one finished hold. `None` means "this is dictation": the caller
/// falls through to the insert path unchanged. Blocking, bounded by
/// `WAIT_BUDGET` plus one focus probe; call it from the dictation worker.
pub(super) fn try_command(
    app: &AppHandle,
    transcript: &str,
    frontmost_app: Option<&str>,
) -> Option<Executed> {
    let brain = handle(app)?;
    let token = brain.usable()?;
    let words = transcript.split_whitespace().count();
    // A hold that opens by addressing Buddy is allowed to be a whole sentence:
    // a browser task ("hey aura, find three internships in Seattle posted
    // this week and list the deadlines") is rarely twelve words. Every other
    // hold keeps the short cap, so ordinary dictation pays nothing for this.
    let addressed_prefix = starts_with_address(transcript);
    let word_cap = if addressed_prefix { ADDRESSED_MAX_COMMAND_WORDS } else { MAX_COMMAND_WORDS };
    if words == 0 || words > word_cap {
        return None;
    }

    let started = Instant::now();
    // The same bounded probe the insert path uses, asked separately so the
    // insert-time verdict keeps its "last possible moment" semantics. Only
    // a confident NotTypable counts as free: Unknown and Password keep the
    // strict gates, because acting is the costlier mistake.
    let probe = crate::uia::probe_focus(app);
    let field_focused = !matches!(probe.verdict, crate::uia::FocusVerdict::NotTypable);

    let apps = brain.apps();
    let queries = query_candidates(transcript);
    let sites = site_candidates(transcript);
    let payload = build_payload(transcript, frontmost_app, field_focused, &apps, &queries, &sites);

    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let _ = tx.send(request_decision(token, payload).await);
    });
    let answers = match rx.recv_timeout(WAIT_BUDGET) {
        Ok(Ok(answers)) => answers,
        Ok(Err(reason)) => {
            // The backend refused this token; drop it so the webview's pump
            // mints a fresh one rather than every hold retrying a dead one.
            if reason == "auth" {
                brain.clear_token();
            }
            info!(
                "dictation: phase=command outcome={reason} decision_ms={}",
                started.elapsed().as_millis()
            );
            return None;
        }
        Err(_) => {
            info!(
                "dictation: phase=command outcome=timeout decision_ms={}",
                started.elapsed().as_millis()
            );
            return None;
        }
    };

    let decision_ms = started.elapsed().as_millis();
    let (intent, intent_c) = answer(&answers, "intent");
    let (action, action_c) = answer(&answers, "action");
    let (addressed, addressed_c) = answer(&answers, "addressed");

    if intent.as_deref() != Some("command") {
        info!(
            "dictation: phase=command outcome=dictation intent_conf={intent_c:.2} decision_ms={decision_ms}"
        );
        return None;
    }
    let action = action?;
    let mut conf = intent_c.min(action_c);

    // Resolve the action's argument first, folding its confidence in: a
    // strong "open_app" with no believable app is not a command.
    let verb = match action.as_str() {
        "open_app" => {
            let (choice, app_c) = answer(&answers, "app");
            let entry = choice
                .as_deref()
                .and_then(|name| apps.iter().find(|a| a.name.eq_ignore_ascii_case(name)))?;
            conf = conf.min(app_c);
            Verb::OpenApp(entry.clone())
        }
        "close_window" => Verb::CloseWindow,
        "web_search" | "web_search_beside" => {
            let (choice, query_c) = answer(&answers, "query");
            let query = choice.filter(|q| !q.trim().is_empty())?;
            conf = conf.min(query_c);
            Verb::WebSearch {
                query,
                beside: action == "web_search_beside",
            }
        }
        "open_site" => {
            let (choice, site_c) = answer(&answers, "site");
            let site = choice.filter(|s| !s.trim().is_empty())?;
            conf = conf.min(site_c);
            Verb::OpenSite(site)
        }
        "play_music" => {
            let (choice, query_c) = answer(&answers, "query");
            match choice.filter(|q| !q.trim().is_empty()) {
                Some(query) if query_c >= 0.4 => Verb::PlayMusic(query),
                _ => Verb::Media(MediaKey::PlayPause),
            }
        }
        "media_play_pause" => Verb::Media(MediaKey::PlayPause),
        "media_next" => Verb::Media(MediaKey::Next),
        "media_previous" => Verb::Media(MediaKey::Previous),
        "volume_up" => Verb::Media(MediaKey::VolumeUp),
        "volume_down" => Verb::Media(MediaKey::VolumeDown),
        "volume_mute" => Verb::Media(MediaKey::VolumeMute),
        // Jev only selects; it cannot write a brief. The utterance itself,
        // minus the address word, IS the brief (feature entry, section 9.1).
        "browser_task" => Verb::BrowserTask(strip_address(transcript)),
        _ => {
            info!(
                "dictation: phase=command outcome=dictation action=none decision_ms={decision_ms}"
            );
            return None;
        }
    };

    // A browser task acts only when the user addressed Buddy, whether or not
    // a field is focused. It is the one verb that can be mistaken for a
    // to-do item someone wanted TYPED ("find three internships and list the
    // deadlines"), and starting a browser on that is the costlier mistake.
    let acts = if matches!(verb, Verb::BrowserTask(_)) {
        addressed.as_deref() == Some("yes") && conf.min(addressed_c) >= GATE_ADDRESSED
    } else if !field_focused {
        conf >= GATE_FREE
    } else if addressed.as_deref() == Some("yes") {
        conf.min(addressed_c) >= GATE_ADDRESSED
    } else {
        conf >= GATE_TYPING
    };
    if !acts {
        info!(
            "dictation: phase=command outcome=below_gate verb={} conf={conf:.2} focused={field_focused} decision_ms={decision_ms}",
            verb.id()
        );
        return None;
    }

    info!(
        "dictation: phase=command outcome=execute verb={} conf={conf:.2} focused={field_focused} decision_ms={decision_ms}",
        verb.id()
    );
    match execute(app, verb) {
        Ok(caption) => Some(Executed { caption }),
        Err(reason) => {
            // The decision WAS a command; failing to carry it out must be
            // loud, never a silent fall-through that types the sentence.
            warn!("dictation: phase=command outcome=execute_failed reason={reason}");
            Some(Executed {
                caption: "That could not be done.".to_string(),
            })
        }
    }
}

enum Verb {
    OpenApp(AppEntry),
    CloseWindow,
    WebSearch { query: String, beside: bool },
    OpenSite(String),
    PlayMusic(String),
    Media(MediaKey),
    /// A multi-step web job handed to the Background Browser Agent
    /// (agent_browser). The String is the brief: the utterance verbatim,
    /// minus the address word.
    BrowserTask(String),
}

impl Verb {
    fn id(&self) -> &'static str {
        match self {
            Verb::OpenApp(_) => "open_app",
            Verb::CloseWindow => "close_window",
            Verb::WebSearch { beside: false, .. } => "web_search",
            Verb::WebSearch { beside: true, .. } => "web_search_beside",
            Verb::OpenSite(_) => "open_site",
            Verb::PlayMusic(_) => "play_music",
            Verb::Media(key) => key.id(),
            Verb::BrowserTask(_) => "browser_task",
        }
    }
}

/// Address words a hold may open with. Lowercased, punctuation-insensitive:
/// "Hey Aura, find ..." and "buddy find ..." both count.
const ADDRESS_WORDS: &[&str] = &["buddy", "aura", "hey buddy", "hey aura", "ok buddy", "ok aura"];

fn address_prefix_len(transcript: &str) -> usize {
    let lowered = transcript.trim_start().to_lowercase();
    let mut best = 0;
    for word in ADDRESS_WORDS {
        if let Some(rest) = lowered.strip_prefix(word) {
            // The address must end the token: "aurora" is not "aura".
            let ends_token = rest.is_empty()
                || rest.starts_with(|c: char| c.is_whitespace() || c == ',' || c == ':' || c == '.');
            if ends_token && word.len() > best {
                best = word.len();
            }
        }
    }
    best
}

fn starts_with_address(transcript: &str) -> bool {
    address_prefix_len(transcript) > 0
}

/// The brief: everything after the address word and its punctuation.
fn strip_address(transcript: &str) -> String {
    let trimmed = transcript.trim_start();
    let cut = address_prefix_len(trimmed);
    trimmed[cut..]
        .trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ':' || c == '.')
        .trim()
        .to_string()
}

#[derive(Clone, Copy)]
enum MediaKey {
    PlayPause,
    Next,
    Previous,
    VolumeUp,
    VolumeDown,
    VolumeMute,
}

impl MediaKey {
    fn id(self) -> &'static str {
        match self {
            MediaKey::PlayPause => "media_play_pause",
            MediaKey::Next => "media_next",
            MediaKey::Previous => "media_previous",
            MediaKey::VolumeUp => "volume_up",
            MediaKey::VolumeDown => "volume_down",
            MediaKey::VolumeMute => "volume_mute",
        }
    }

    fn caption(self) -> &'static str {
        match self {
            MediaKey::PlayPause => "Toggled playback",
            MediaKey::Next => "Next track",
            MediaKey::Previous => "Previous track",
            MediaKey::VolumeUp => "Volume up",
            MediaKey::VolumeDown => "Volume down",
            MediaKey::VolumeMute => "Toggled mute",
        }
    }
}

fn execute(app: &AppHandle, verb: Verb) -> Result<String, String> {
    match verb {
        Verb::OpenApp(entry) => {
            platform::launch(&entry.launch)?;
            Ok(format!("Opening {}", entry.name))
        }
        Verb::CloseWindow => {
            platform::close_front_window()?;
            Ok("Closed the window".to_string())
        }
        Verb::WebSearch { query, beside } => {
            let url = format!("https://www.google.com/search?q={}", encode_query(&query));
            open_in_browser(app, &url)?;
            if beside {
                platform::snap_foreground_right_later();
            }
            Ok(format!("Searching for {query}"))
        }
        Verb::OpenSite(site) => {
            let url = format!("https://{site}");
            open_in_browser(app, &url)?;
            Ok(format!("Opening {site}"))
        }
        Verb::PlayMusic(query) => {
            let encoded = encode_query(&query);
            // No Spotify app installed is not a failure worth showing the
            // user: the web player answers the same ask. launch_uri is the
            // one that knows whether a `spotify:` handler exists at all.
            if platform::launch_uri(&format!("spotify:search:{encoded}")).is_err() {
                open_in_browser(app, &format!("https://open.spotify.com/search/{encoded}"))?;
            }
            Ok(format!("Looking for {query} on Spotify"))
        }
        Verb::Media(key) => {
            platform::media_key(key)?;
            Ok(key.caption().to_string())
        }
        Verb::BrowserTask(brief) => {
            // Its own authorization (signed in + the browser agent opt-in),
            // its own worker thread; the hold returns at once with a caption.
            crate::agent_browser::start(app, &brief, "dictation")?;
            Ok("Working on it in the background".to_string())
        }
    }
}

/// The same scheme rule system_control::open_url enforces: only https ever
/// reaches the OS shell from here, and this module only builds https URLs.
fn open_in_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("open url failed: {e}"))
}

// ---------------------------------------------------------------------------
// Candidates: code enumerates, Jev selects

/// Tail word n-grams of the utterance, the spans a search query or music name
/// could be. Generation only; nothing here decides anything.
fn query_candidates(utterance: &str) -> Vec<String> {
    let words: Vec<String> = utterance
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '\'' && c != '.')
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect();
    let mut out = Vec::new();
    for n in 1..=words.len().min(7) {
        out.push(words[words.len() - n..].join(" "));
    }
    out
}

/// Domain-shaped tokens ("gmail.com"), for the open_site action. Shape only,
/// never meaning: whether the user WANTS it opened is Jev's call.
fn site_candidates(utterance: &str) -> Vec<String> {
    utterance
        .split_whitespace()
        .filter_map(|word| {
            let token = word
                .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-')
                .to_lowercase();
            let (rest, tld) = token.rsplit_once('.')?;
            let shaped = !rest.is_empty()
                && tld.len() >= 2
                && tld.chars().all(|c| c.is_ascii_alphabetic())
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
            shaped.then_some(token)
        })
        .take(4)
        .collect()
}

fn encode_query(query: &str) -> String {
    let mut out = String::with_capacity(query.len() * 3);
    for byte in query.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
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
            .expect("command brain http client")
    })
}

fn choice_criteria<'a>(options: impl Iterator<Item = (&'a str, &'a str)>) -> Value {
    let mut map = serde_json::Map::new();
    for (option, description) in options {
        map.insert(option.to_string(), Value::String(description.to_string()));
    }
    Value::Object(map)
}

fn build_payload(
    utterance: &str,
    frontmost_app: Option<&str>,
    field_focused: bool,
    apps: &[AppEntry],
    queries: &[String],
    sites: &[String],
) -> Value {
    const ACTIONS: &[(&str, &str)] = &[
        ("open_app", "Launch or switch to an application the user named."),
        ("close_window", "Close the window currently in front."),
        ("web_search", "Search the web for something the user asked for."),
        (
            "web_search_beside",
            "Search the web AND the user asked to see the result beside or next to what they are working on.",
        ),
        ("open_site", "Open a specific website the user named by its domain."),
        (
            "play_music",
            "Play specific music: an artist, song, album or playlist the user named.",
        ),
        ("media_play_pause", "Pause or resume whatever media is playing."),
        ("media_next", "Skip to the next track or song."),
        ("media_previous", "Go back to the previous track or song."),
        ("volume_up", "Turn the system volume up."),
        ("volume_down", "Turn the system volume down."),
        ("volume_mute", "Mute or unmute the system volume."),
        (
            "browser_task",
            "A multi-step job on the web to do in the background and report back: find, compare, collect or check something across websites. Not a single search or opening one site.",
        ),
        ("none", "No desktop action fits this utterance."),
    ];

    let mut questions = serde_json::Map::new();
    questions.insert(
        "intent".to_string(),
        json!({
            "type": "choice",
            "instructions": "The user spoke into Aura's push-to-talk dictation on their computer. state.text_field_focused says whether an editable text field currently has keyboard focus. Decide whether this utterance is a command for the computer to act on now, or ordinary dictation to be typed into the focused field. While a text field is focused, dictation is the default unless the user clearly addresses the assistant directly.",
            "criteria": {
                "command": "An instruction for the computer to act on now.",
                "dictation": "Ordinary speech to be inserted as text where the user is typing."
            }
        }),
    );
    questions.insert(
        "addressed".to_string(),
        json!({
            "type": "choice",
            "instructions": "Is the user directly addressing the assistant (named Aura or Buddy), speaking TO it by name or imperative, rather than merely mentioning it or talking to another person?",
            "criteria": {
                "yes": "The utterance is spoken to the assistant directly.",
                "no": "The assistant is not being addressed; any mention of it is content."
            }
        }),
    );
    questions.insert(
        "action".to_string(),
        json!({
            "type": "choice",
            "instructions": "If this is a command, which single action is it?",
            "criteria": choice_criteria(ACTIONS.iter().copied())
        }),
    );
    if !apps.is_empty() {
        questions.insert(
            "app".to_string(),
            json!({
                "type": "choice",
                "instructions": "Which installed application does the user mean, if any?",
                "criteria": choice_criteria(apps.iter().map(|a| (a.name.as_str(), "")))
            }),
        );
    }
    if !queries.is_empty() {
        questions.insert(
            "query".to_string(),
            json!({
                "type": "choice",
                "instructions": "If this is a search or music request, which candidate span is what the user wants searched or played?",
                "criteria": choice_criteria(queries.iter().map(|q| (q.as_str(), "")))
            }),
        );
    }
    if !sites.is_empty() {
        questions.insert(
            "site".to_string(),
            json!({
                "type": "choice",
                "instructions": "If the user named a website to open, which candidate is it?",
                "criteria": choice_criteria(sites.iter().map(|s| (s.as_str(), "")))
            }),
        );
    }

    json!({
        "state": {
            "utterance": utterance,
            "frontmost_app": frontmost_app,
            "text_field_focused": field_focused,
        },
        "questions": Value::Object(questions),
    })
}

/// One decision round trip, through juno-backend, which holds the provider key
/// and adds the model name. The error is a category for the log, never a body
/// that could quote the transcript back.
async fn request_decision(token: String, payload: Value) -> Result<Value, &'static str> {
    let response = client()
        .post(format!("{API_BASE_URL}/dictation/command"))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "timeout" } else { "http" })?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err("auth"),
        429 => return Err("rate_limited"),
        503 => return Err("unavailable"),
        _ => return Err("http_other"),
    }
    let parsed: Value = response.json().await.map_err(|_| "invalid")?;
    parsed.get("answers").cloned().ok_or("invalid")
}

fn answer(answers: &Value, key: &str) -> (Option<String>, f64) {
    let entry = answers.get(key);
    let choice = entry
        .and_then(|a| a.get("choice"))
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let confidence = entry
        .and_then(|a| a.get("confidence"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    (choice, confidence)
}

// ---------------------------------------------------------------------------
// Platform executors. Both sides real; the seam lives here, in the owning
// file, following insert.rs's `backend` pattern. Local mirrors of the tiny
// Win32 bodies in system_control.rs are deliberate (same rule as its own
// process_stem_for_window): that module's verbs sit behind the live-voice
// authorization gate, which a dictation hold neither has nor wants.

#[cfg(windows)]
mod platform {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use super::{AppEntry, MediaKey, MAX_APPS};

    /// Where a launchable app can be found on Windows: the Start Menu shortcut
    /// tree, plus the virtual AppsFolder. Both are needed. A Store (MSIX/AppX)
    /// app has no .lnk anywhere on disk, so the shortcut walk alone cannot see
    /// one at all, which is exactly how "open spotify" used to reach Jev with
    /// no Spotify anywhere in its choice list and fall through to typing.
    pub(super) fn enumerate_apps() -> Vec<AppEntry> {
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Ok(program_data) = std::env::var("ProgramData") {
            roots.push(Path::new(&program_data).join("Microsoft\\Windows\\Start Menu\\Programs"));
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            roots.push(Path::new(&app_data).join("Microsoft\\Windows\\Start Menu\\Programs"));
        }
        let mut seen = std::collections::BTreeMap::new();
        for root in roots {
            collect_shortcuts(&root, 0, &mut seen);
        }
        // Second, so a .lnk wins a name tie: its target is a real path, which
        // the shell resolves without going through an AppUserModelID.
        collect_apps_folder(&mut seen);
        seen.into_values().take(MAX_APPS).collect()
    }

    /// Entries nobody asks for by name. Shape only, never meaning: dropping
    /// these is what keeps a normal machine under `MAX_APPS`, whose cut is
    /// alphabetical and therefore not something to rely on.
    fn is_noise(lower: &str) -> bool {
        const NOISE: [&str; 5] = [
            "uninstall",
            "readme",
            "release notes",
            "documentation",
            "website",
        ];
        NOISE.iter().any(|needle| lower.contains(needle))
    }

    fn collect_shortcuts(
        dir: &Path,
        depth: usize,
        out: &mut std::collections::BTreeMap<String, AppEntry>,
    ) {
        if depth > 3 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_shortcuts(&path, depth + 1, out);
                continue;
            }
            let is_shortcut = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("lnk"));
            if !is_shortcut {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let lower = name.to_lowercase();
            // Shape filter only: installer leftovers are not launch targets.
            if is_noise(&lower) {
                continue;
            }
            out.entry(lower).or_insert_with(|| AppEntry {
                name: name.to_string(),
                launch: path.to_string_lossy().into_owned(),
            });
        }
    }

    /// Everything under here is an AppUserModelID, not a path.
    const APPS_FOLDER_PREFIX: &str = "shell:AppsFolder\\";

    /// The Store half of the list. AppsFolder is virtual, so it is read through
    /// the shell's item enumerator rather than the file system: a child's
    /// display name is what a person calls the app, and its parsing name is
    /// `shell:AppsFolder\<AppUserModelID>`, which is what `launch` hands to
    /// explorer.exe.
    fn collect_apps_folder(out: &mut std::collections::BTreeMap<String, AppEntry>) {
        use windows::core::HSTRING;
        use windows::Win32::System::Com::{
            CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::{
            IEnumShellItems, IShellItem, SHCreateItemFromParsingName, BHID_EnumItems,
            SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
        };

        // SAFETY: the calling thread may already own an apartment, in which
        // case this returns an error and we simply reuse it. CoUninitialize
        // runs only when this call is the one that initialized.
        let owned = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();

        unsafe {
            let folder: windows::core::Result<IShellItem> =
                SHCreateItemFromParsingName(&HSTRING::from("shell:AppsFolder"), None);
            if let Ok(folder) = folder {
                let items: windows::core::Result<IEnumShellItems> =
                    folder.BindToHandler(None::<&IBindCtx>, &BHID_EnumItems);
                if let Ok(items) = items {
                    // Bounded: a virtual folder that never reports exhaustion
                    // must not spin the dictation worker.
                    for _ in 0..2_000 {
                        let mut batch: [Option<IShellItem>; 1] = [None];
                        let mut fetched = 0u32;
                        if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                            break;
                        }
                        let Some(item) = batch[0].take() else {
                            break;
                        };
                        // Both strings are shell-allocated, so each is freed on
                        // every path out, including the one where the second
                        // call is the one that failed.
                        let Ok(display) = item.GetDisplayName(SIGDN_NORMALDISPLAY) else {
                            continue;
                        };
                        let Ok(parsing) = item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING) else {
                            CoTaskMemFree(Some(display.0 as *const _));
                            continue;
                        };
                        let name = display.to_string().unwrap_or_default();
                        let aumid = parsing.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(display.0 as *const _));
                        CoTaskMemFree(Some(parsing.0 as *const _));

                        // A child of AppsFolder parses to its AppUserModelID,
                        // which never contains a path separator. The ones that
                        // do are the folder's non-app members (a .chm, a .msi,
                        // an example folder: 57 of the 189 entries on a normal
                        // machine) and launching those is not what anyone means
                        // by "open X".
                        if name.is_empty() || aumid.is_empty() || aumid.contains('\\') {
                            continue;
                        }
                        let lower = name.to_lowercase();
                        if is_noise(&lower) {
                            continue;
                        }
                        out.entry(lower).or_insert(AppEntry {
                            name,
                            launch: format!("{APPS_FOLDER_PREFIX}{aumid}"),
                        });
                    }
                }
            }
        }

        if owned {
            unsafe { CoUninitialize() };
        }
    }

    /// Launches a shortcut path, an AppsFolder AUMID, or a URI via the shell.
    /// The path and URI shapes are the same cmd-start as
    /// system_control::spawn_launch: App Paths tokens, .lnk files and URI
    /// protocols all resolve uniformly, and the argument is always a registry
    /// entry, an enumerated app or a URI this module built, never user input
    /// handed to a parser.
    pub(super) fn launch(target: &str) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // `start` cannot resolve an AppUserModelID. explorer.exe is the
        // documented launcher for one, and it takes the whole shell: token.
        let mut command = if target.starts_with(APPS_FOLDER_PREFIX) {
            let mut c = std::process::Command::new("explorer.exe");
            c.arg(target);
            c
        } else {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "start", "", target]);
            c
        };
        command
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_child| ())
            .map_err(|e| format!("launch failed: {e}"))
    }

    /// A URI only launches something if its scheme has a handler. `cmd /C
    /// start` cannot report that: it exits 0 either way, so an unregistered
    /// `spotify:` used to look like a success while nothing opened at all.
    pub(super) fn launch_uri(uri: &str) -> Result<(), String> {
        let scheme = uri.split(':').next().unwrap_or_default();
        if !scheme_registered(scheme) {
            return Err(format!("no handler registered for {scheme}:"));
        }
        launch(uri)
    }

    /// True when `HKEY_CLASSES_ROOT\<scheme>\shell\open\command` exists, which
    /// is the same key the shell itself consults to resolve a protocol.
    fn scheme_registered(scheme: &str) -> bool {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::ERROR_SUCCESS;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ,
        };
        if scheme.is_empty() {
            return false;
        }
        let path = HSTRING::from(format!("{scheme}\\shell\\open\\command"));
        let mut key = HKEY::default();
        // SAFETY: the key handle is closed on every success path.
        let status = unsafe { RegOpenKeyExW(HKEY_CLASSES_ROOT, &path, None, KEY_READ, &mut key) };
        if status == ERROR_SUCCESS {
            unsafe {
                let _ = RegCloseKey(key);
            }
            true
        } else {
            false
        }
    }

    /// WM_CLOSE to the foreground window: the polite ask, exactly what the
    /// title bar X sends, so unsaved-changes prompts still appear. Never a
    /// process kill, and never one of Aura's own windows.
    pub(super) fn close_front_window() -> Result<(), String> {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
        };
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return Err("no window has focus".to_string());
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == std::process::id() {
                return Err("the front window is Aura's own".to_string());
            }
            PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0))
                .map_err(|e| format!("close failed: {e}"))
        }
    }

    /// One synthetic media/volume key, the same SendInput pair as
    /// system_control::media_control.
    pub(super) fn media_key(key: MediaKey) -> Result<(), String> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
            VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_VOLUME_DOWN,
            VK_VOLUME_MUTE, VK_VOLUME_UP,
        };
        let vk: VIRTUAL_KEY = match key {
            MediaKey::PlayPause => VK_MEDIA_PLAY_PAUSE,
            MediaKey::Next => VK_MEDIA_NEXT_TRACK,
            MediaKey::Previous => VK_MEDIA_PREV_TRACK,
            MediaKey::VolumeUp => VK_VOLUME_UP,
            MediaKey::VolumeDown => VK_VOLUME_DOWN,
            MediaKey::VolumeMute => VK_VOLUME_MUTE,
        };
        let mut down = INPUT {
            r#type: INPUT_KEYBOARD,
            ..Default::default()
        };
        down.Anonymous.ki = KEYBDINPUT {
            wVk: vk,
            wScan: 0,
            dwFlags: Default::default(),
            time: 0,
            dwExtraInfo: 0,
        };
        let mut up = INPUT {
            r#type: INPUT_KEYBOARD,
            ..Default::default()
        };
        up.Anonymous.ki = KEYBDINPUT {
            wVk: vk,
            wScan: 0,
            dwFlags: KEYEVENTF_KEYUP,
            time: 0,
            dwExtraInfo: 0,
        };
        let sent = unsafe { SendInput(&[down, up], core::mem::size_of::<INPUT>() as i32) };
        if sent == 0 {
            return Err("SendInput injected no events".to_string());
        }
        Ok(())
    }

    /// Best effort, after the browser has had a beat to take the foreground:
    /// snap whatever is front to the right half of the work area. A failure
    /// leaves the search open exactly where the browser put it.
    pub(super) fn snap_foreground_right_later() {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(1400));
            unsafe {
                use windows::Win32::Foundation::RECT;
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetForegroundWindow, SetWindowPos, SystemParametersInfoW, SPI_GETWORKAREA,
                    SWP_NOZORDER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
                };
                let hwnd = GetForegroundWindow();
                if hwnd.0.is_null() {
                    return;
                }
                let mut area = RECT::default();
                if SystemParametersInfoW(
                    SPI_GETWORKAREA,
                    0,
                    Some(&mut area as *mut RECT as *mut core::ffi::c_void),
                    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
                )
                .is_err()
                {
                    return;
                }
                let half = (area.right - area.left) / 2;
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    area.left + half,
                    area.top,
                    half,
                    area.bottom - area.top,
                    SWP_NOZORDER,
                );
            }
        });
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use super::{AppEntry, MediaKey, MAX_APPS};

    pub(super) fn enumerate_apps() -> Vec<AppEntry> {
        let mut roots = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            roots.push(Path::new(&home).join("Applications"));
        }
        let mut seen = std::collections::BTreeMap::new();
        for root in roots {
            collect_bundles(&root, 0, &mut seen);
        }
        seen.into_values().take(MAX_APPS).collect()
    }

    fn collect_bundles(
        dir: &Path,
        depth: usize,
        out: &mut std::collections::BTreeMap<String, AppEntry>,
    ) {
        if depth > 1 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let is_bundle = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("app"));
            if !is_bundle {
                // One level of folders (Utilities and the like).
                collect_bundles(&path, depth + 1, out);
                continue;
            }
            let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            out.entry(name.to_lowercase()).or_insert_with(|| AppEntry {
                name: name.to_string(),
                launch: name.to_string(),
            });
        }
    }

    /// `open -a <name>`: Launch Services resolves the bundle, exactly what
    /// the jev-voice demo does. The name is always a registry entry.
    pub(super) fn launch(target: &str) -> Result<(), String> {
        std::process::Command::new("open")
            .args(["-a", target])
            .spawn()
            .map(|_child| ())
            .map_err(|e| format!("launch failed: {e}"))
    }

    pub(super) fn launch_uri(uri: &str) -> Result<(), String> {
        std::process::Command::new("open")
            .arg(uri)
            .spawn()
            .map(|_child| ())
            .map_err(|e| format!("launch failed: {e}"))
    }

    /// Cmd+W to the front window: the polite ask, so unsaved-changes sheets
    /// still appear. Posted through the same stamped CGEvent path as
    /// insert.rs, so the chord tap drops it as our own.
    pub(super) fn close_front_window() -> Result<(), String> {
        use objc2_core_graphics::{
            CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID,
            CGEventTapLocation,
        };
        // kVK_ANSI_W.
        const KEYCODE_W: u16 = 13;
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
        if source.is_none() {
            return Err("no event source; is Accessibility granted?".to_string());
        }
        let source = source.as_deref();
        for down in [true, false] {
            let Some(event) = CGEvent::new_keyboard_event(source, KEYCODE_W, down) else {
                return Err("keyboard event could not be created".to_string());
            };
            CGEvent::set_integer_value_field(
                Some(&event),
                CGEventField::EventSourceUserData,
                crate::macos_input::INJECTED_EVENT_MARKER,
            );
            CGEvent::set_flags(Some(&event), CGEventFlags::MaskCommand);
            CGEvent::post(CGEventTapLocation::SessionEventTap, Some(&event));
        }
        Ok(())
    }

    /// The aux-key codes from IOKit's ev_keymap.h. These are what the
    /// physical media keys send, so anything registered with Now Playing
    /// (Music, Spotify, YouTube in a browser) obeys them.
    fn aux_code(key: MediaKey) -> i64 {
        match key {
            MediaKey::VolumeUp => 0,
            MediaKey::VolumeDown => 1,
            MediaKey::VolumeMute => 7,
            MediaKey::PlayPause => 16,
            MediaKey::Next => 17,
            MediaKey::Previous => 18,
        }
    }

    /// Posts one media/volume key as the NX_SYSDEFINED event pair the real
    /// keys produce. There is no CGEvent constructor for these, so the event
    /// is built as an NSEvent and its CGEvent is posted; this is the same
    /// mechanism every macOS media-key utility uses.
    pub(super) fn media_key(key: MediaKey) -> Result<(), String> {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_core_foundation::CGPoint;
        use objc2_core_graphics::{CGEvent, CGEventTapLocation};

        // NSEventTypeSystemDefined and the media-key subtype.
        const SYSTEM_DEFINED: usize = 14;
        const SUBTYPE_AUX_KEY: i16 = 8;

        let code = aux_code(key);
        // An autorelease pool because the NSEvent comes back autoreleased and
        // this runs on the dictation worker, which has no ambient pool.
        objc2::rc::autoreleasepool(|_| unsafe {
            for down in [true, false] {
                let key_state: i64 = if down { 0x0A } else { 0x0B };
                let flags: usize = if down { 0x0A00 } else { 0x0B00 };
                let data1: isize = ((code << 16) | (key_state << 8)) as isize;
                let event: *mut AnyObject = msg_send![
                    class!(NSEvent),
                    otherEventWithType: SYSTEM_DEFINED,
                    location: CGPoint { x: 0.0, y: 0.0 },
                    modifierFlags: flags,
                    timestamp: 0f64,
                    windowNumber: 0isize,
                    context: std::ptr::null_mut::<AnyObject>(),
                    subtype: SUBTYPE_AUX_KEY,
                    data1: data1,
                    data2: -1isize
                ];
                if event.is_null() {
                    return Err("media key event could not be created".to_string());
                }
                // Through c_void rather than a typed pointer: the CGEvent
                // property is read manually here, and the opaque CF type is
                // not directly message-encodable.
                let cg_event: *mut std::ffi::c_void = msg_send![event, CGEvent];
                if cg_event.is_null() {
                    return Err("media key event has no CGEvent".to_string());
                }
                let cg_event = cg_event.cast::<CGEvent>();
                CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&*cg_event));
            }
            Ok(())
        })
    }

    /// Best effort, after the browser has had a beat to take the foreground:
    /// move the front window to the right half of the screen via System
    /// Events, which rides the Accessibility grant dictation already holds.
    /// A failure leaves the search open exactly where the browser put it.
    pub(super) fn snap_foreground_right_later() {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(1400));
            let Some((width, height)) = desktop_bounds() else {
                return;
            };
            let half = width / 2;
            let script = format!(
                "tell application \"System Events\" to tell (first application process whose frontmost is true)\n\
                 set position of front window to {{{half}, 0}}\n\
                 set size of front window to {{{half}, {height}}}\n\
                 end tell"
            );
            let _ = std::process::Command::new("osascript")
                .args(["-e", &script])
                .output();
        });
    }

    fn desktop_bounds() -> Option<(i64, i64)> {
        let output = std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"Finder\" to get bounds of window of desktop",
            ])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<i64> = text
            .trim()
            .split(',')
            .filter_map(|part| part.trim().parse().ok())
            .collect();
        if parts.len() != 4 {
            return None;
        }
        Some((parts[2], parts[3]))
    }
}
