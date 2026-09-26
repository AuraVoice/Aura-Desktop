//! Background Browser Agent: the desktop runner (future-features.txt, the
//! "BACKGROUND BROWSER AGENT" entry, sections 8 and 9).
//!
//! The shape is `interview.rs`: one handle holding at most one live task, a
//! worker thread under `catch_unwind` that always releases the handle and
//! tells the webview how it ended, a cancel generation so a Stop cannot be
//! overtaken by the start it interrupted, and `is_active` gating the updater.
//!
//! What the worker does, per step: take an accessibility snapshot of Aura's
//! OWN Chromium (launch.rs, cdp.rs, snapshot.rs), post it with the brief and a
//! short history to `POST /agent/step` on juno-backend (which holds the model
//! key and answers with ONE action), run that action through the guard
//! (guard.rs: refs must exist, risky targets pause for the user) and then
//! through the browser, record a trace line, checkpoint the encrypted row
//! (store.rs), and repeat until the model says done, a cap trips, or the user
//! stops it. Code owns every part of the control flow; the model only fills
//! in the next action (section 9.1).
//!
//! Authorization is `Operation::StartBrowserTask`, NOT `DesktopControl`: the
//! latter requires a live voice call, and a task must outlive the call that
//! started it. The Firebase ID token for the backend call is pushed by the
//! webview's credential pump and held here in RAM only, the same
//! "React mints, Rust holds" arrangement as `dictation/command_brain.rs`.

pub mod cdp;
pub mod consent;
pub mod guard;
pub mod launch;
pub mod snapshot;
pub mod store;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::dictation::scoped_token::ScopedToken;
use crate::events::{BROWSER_TASK_APPROVAL as APPROVAL_EVENT, BROWSER_TASK_STATUS as STATUS_EVENT};
use crate::security::{self, Operation};
use guard::{Action, Gate};
use store::TraceEntry;

/// Mirrors `API_BASE_URL` in `src/lib/api.ts`, for the reason polish.rs and
/// command_brain.rs carry their own copies: the worker thread must not IPC to
/// the webview to learn where the backend lives.
const API_BASE_URL: &str = "https://juno-backend-620715294422.us-central1.run.app";

/// Hard stop: whatever was found so far is saved, marked partial (section 4).
const STEP_CAP: u32 = 40;
const WALL_CLOCK_LIMIT: Duration = Duration::from_secs(5 * 60);
/// The approval card's window. No answer means no.
const APPROVAL_WAIT: Duration = Duration::from_secs(60);
/// Two refusals in a row: the model has no other route to the goal.
const MAX_CONSECUTIVE_DENIALS: u32 = 2;
const HISTORY_KEEP: usize = 10;
const MAX_BRIEF_CHARS: usize = 500;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The backend's own model deadline is 15 s; this leaves room for the hop.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);

static TOKEN: Mutex<ScopedToken> = Mutex::new(ScopedToken::new("agent_browser.credential"));

pub enum RuntimeCommand {
    Stop,
    Approve(bool),
    Watch,
}

struct Active {
    epoch: u64,
    task_id: String,
    brief: String,
    origin: String,
    phase: String,
    steps: u32,
    url: String,
    commands: mpsc::Sender<RuntimeCommand>,
}

#[derive(Default)]
pub struct BrowserAgentHandle(Mutex<Option<Active>>, AtomicU64);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTaskStatusPayload {
    pub phase: String,
    pub task_id: Option<String>,
    pub epoch: Option<u64>,
    pub origin: Option<String>,
    pub brief: Option<String>,
    pub steps: u32,
    pub url: Option<String>,
    pub reason: Option<String>,
    pub answer: Option<String>,
    pub sources: Vec<String>,
    pub partial: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalPayload {
    task_id: String,
    epoch: u64,
    description: String,
    url: String,
}

fn idle_status() -> BrowserTaskStatusPayload {
    BrowserTaskStatusPayload {
        phase: "idle".to_string(),
        task_id: None,
        epoch: None,
        origin: None,
        brief: None,
        steps: 0,
        url: None,
        reason: None,
        answer: None,
        sources: Vec::new(),
        partial: false,
    }
}

fn snapshot_status(handle: &BrowserAgentHandle) -> BrowserTaskStatusPayload {
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    match state.as_ref() {
        Some(active) => BrowserTaskStatusPayload {
            phase: active.phase.clone(),
            task_id: Some(active.task_id.clone()),
            epoch: Some(active.epoch),
            origin: Some(active.origin.clone()),
            brief: Some(active.brief.clone()),
            steps: active.steps,
            url: Some(active.url.clone()),
            reason: None,
            answer: None,
            sources: Vec::new(),
            partial: false,
        },
        None => idle_status(),
    }
}

/// Writes the phase back onto the live task (if the epoch still matches) and
/// emits it. The payload carries the brief so a card mounting late can label
/// itself without a second round trip.
fn emit_progress(app: &AppHandle, epoch: u64, phase: &str, steps: u32, url: &str) {
    let Some(handle) = app.try_state::<BrowserAgentHandle>() else { return };
    let payload = {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(active) = state.as_mut().filter(|active| active.epoch == epoch) else { return };
        active.phase = phase.to_string();
        active.steps = steps;
        active.url = url.to_string();
        BrowserTaskStatusPayload {
            phase: phase.to_string(),
            task_id: Some(active.task_id.clone()),
            epoch: Some(epoch),
            origin: Some(active.origin.clone()),
            brief: Some(active.brief.clone()),
            steps,
            url: Some(url.to_string()),
            reason: None,
            answer: None,
            sources: Vec::new(),
            partial: false,
        }
    };
    let _ = app.emit(STATUS_EVENT, payload);
}

pub fn is_active(app: &AppHandle) -> bool {
    app.try_state::<BrowserAgentHandle>()
        .map(|handle| handle.0.lock().unwrap_or_else(|e| e.into_inner()).is_some())
        .unwrap_or(false)
}

pub fn active_task_id(app: &AppHandle) -> Option<String> {
    let handle = app.try_state::<BrowserAgentHandle>()?;
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    state.as_ref().map(|active| active.task_id.clone())
}

/// Asks the worker to stop and tells the webview at once; the worker's own
/// terminal emit is suppressed by the handle already being empty.
pub fn request_stop(app: &AppHandle, reason: &str) {
    let Some(handle) = app.try_state::<BrowserAgentHandle>() else { return };
    handle.1.fetch_add(1, Ordering::Relaxed);
    let active = handle.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(active) = active {
        let _ = active.commands.send(RuntimeCommand::Stop);
        let _ = app.emit(
            STATUS_EVENT,
            BrowserTaskStatusPayload {
                phase: "stopped".to_string(),
                task_id: Some(active.task_id),
                epoch: Some(active.epoch),
                origin: Some(active.origin),
                brief: Some(active.brief),
                steps: active.steps,
                url: Some(active.url),
                reason: Some(reason.to_string()),
                answer: None,
                sources: Vec::new(),
                partial: true,
            },
        );
    }
}

/// Startup: mirror the persisted consent into the security state and sweep a
/// browser a crash left behind. Called from lib.rs setup.
pub fn on_startup(app: &AppHandle) {
    security::set_browser_task_consent(app, consent::is_accepted(app));
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(root) = store::root_dir(&app) {
            launch::kill_orphan(&root);
        }
    });
}

/// Exit: stop the task and give the worker a moment to close the browser.
/// On Windows the Job Object ends the tree regardless; this is what makes
/// the macOS side clean too.
pub fn kill_for_shutdown(app: &AppHandle) {
    if !is_active(app) {
        return;
    }
    request_stop(app, "exit");
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && worker_alive() {
        std::thread::sleep(Duration::from_millis(50));
    }
}

static WORKERS: AtomicU64 = AtomicU64::new(0);

fn worker_alive() -> bool {
    WORKERS.load(Ordering::Relaxed) > 0
}

/// Starts a task. The one entry point for every caller (dashboard harness,
/// voice capability, Jev): `origin` only labels the row.
pub fn start(app: &AppHandle, brief: &str, origin: &str) -> Result<BrowserTaskStatusPayload, String> {
    let brief = brief.trim();
    if brief.is_empty() {
        return Err("Tell Buddy what to do first.".to_string());
    }
    if brief.chars().count() > MAX_BRIEF_CHARS {
        return Err("That request is too long. Keep it to a sentence or two.".to_string());
    }
    let origin = match origin {
        "voice" | "dictation" | "dashboard" => origin,
        _ => "dashboard",
    };
    let handle = app
        .try_state::<BrowserAgentHandle>()
        .ok_or_else(|| "browser agent unavailable".to_string())?;
    let cancel_generation = handle.1.load(Ordering::Relaxed);
    let ticket = security::authorize(app, Operation::StartBrowserTask)?;
    let uid = security::current_uid(app).ok_or_else(|| "denied: signed out".to_string())?;
    // Loud, not late: without a token the loop would launch a browser and
    // then fail on its first step.
    if TOKEN.lock().unwrap_or_else(|e| e.into_inner()).usable().is_none() {
        return Err("Buddy is not signed in for browser tasks yet. Try again in a moment.".to_string());
    }

    let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if handle.1.load(Ordering::Relaxed) != cancel_generation {
        return Err("The browser task start was cancelled.".to_string());
    }
    if state.is_some() {
        return Err("Buddy is already working on a browser task.".to_string());
    }
    static NEXT_EPOCH: AtomicU64 = AtomicU64::new(0);
    let epoch = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    let task_id = format!("bt-{}-{epoch}", crate::util::now_ms());
    let (command_tx, command_rx) = mpsc::channel();
    *state = Some(Active {
        epoch,
        task_id: task_id.clone(),
        brief: brief.to_string(),
        origin: origin.to_string(),
        phase: "starting".to_string(),
        steps: 0,
        url: String::new(),
        commands: command_tx,
    });
    drop(state);
    emit_progress(app, epoch, "starting", 0, "");

    let spec = TaskSpec {
        task_id,
        brief: brief.to_string(),
        origin: origin.to_string(),
        epoch,
        uid,
        ticket,
    };
    let worker_app = app.clone();
    WORKERS.fetch_add(1, Ordering::Relaxed);
    std::thread::Builder::new()
        .name("aura-browser-agent".to_string())
        .spawn(move || {
            run_worker(worker_app, spec, command_rx);
            WORKERS.fetch_sub(1, Ordering::Relaxed);
        })
        .map_err(|error| {
            WORKERS.fetch_sub(1, Ordering::Relaxed);
            *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
            format!("could not start the browser task: {error}")
        })?;
    Ok(snapshot_status(&handle))
}

fn send_command(app: &AppHandle, command: RuntimeCommand) -> Result<(), String> {
    let handle = app
        .try_state::<BrowserAgentHandle>()
        .ok_or_else(|| "browser agent unavailable".to_string())?;
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    let active = state.as_ref().ok_or_else(|| "no browser task is running".to_string())?;
    active
        .commands
        .send(command)
        .map_err(|_| "the browser task has already ended".to_string())
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn browser_task_start(
    app: AppHandle,
    brief: String,
    origin: Option<String>,
) -> Result<BrowserTaskStatusPayload, String> {
    start(&app, &brief, origin.as_deref().unwrap_or("dashboard"))
}

#[tauri::command]
pub fn browser_task_stop(app: AppHandle) -> BrowserTaskStatusPayload {
    request_stop(&app, "user");
    idle_status()
}

#[tauri::command]
pub fn browser_task_approve(app: AppHandle, allow: bool) -> Result<(), String> {
    send_command(&app, RuntimeCommand::Approve(allow))
}

#[tauri::command]
pub fn browser_task_watch(app: AppHandle) -> Result<(), String> {
    send_command(&app, RuntimeCommand::Watch)
}

#[tauri::command]
pub fn browser_task_status(app: AppHandle) -> BrowserTaskStatusPayload {
    app.try_state::<BrowserAgentHandle>()
        .map(|handle| snapshot_status(&handle))
        .unwrap_or_else(idle_status)
}

/// Receives a fresh Firebase ID token from the webview's credential pump.
/// Never logged, never serialized, never written to disk.
#[tauri::command]
pub async fn browser_task_set_credential(id_token: String, ttl_seconds: u32) -> Result<(), String> {
    TOKEN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .set(id_token, Duration::from_secs(ttl_seconds.into()));
    Ok(())
}

#[tauri::command]
pub async fn browser_task_clear_credential() -> Result<(), String> {
    TOKEN.lock().unwrap_or_else(|e| e.into_inner()).clear();
    Ok(())
}

#[tauri::command]
pub fn browser_task_consent(app: AppHandle) -> bool {
    consent::is_accepted(&app)
}

#[tauri::command]
pub async fn set_browser_task_consent(app: AppHandle, accepted: bool) -> Result<bool, String> {
    consent::set_accepted(&app, accepted)
}

#[tauri::command]
pub async fn browser_tasks_list(app: AppHandle, uid: String) -> Result<Vec<store::TaskSummary>, String> {
    if uid.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || store::list(&app, &uid))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn browser_task_load(
    app: AppHandle,
    uid: String,
    task_id: String,
) -> Result<Option<store::TaskDetail>, String> {
    if uid.is_empty() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || store::load(&app, &uid, &task_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn browser_task_delete(app: AppHandle, uid: String, task_id: String) -> Result<(), String> {
    if uid.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || store::delete(&app, &uid, &task_id))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// The worker

struct TaskSpec {
    task_id: String,
    brief: String,
    origin: String,
    epoch: u64,
    uid: String,
    ticket: security::Ticket,
}

struct Outcome {
    state: &'static str,
    reason: Option<String>,
    answer: String,
    sources: Vec<String>,
    partial: bool,
}

impl Outcome {
    fn failed(code: impl Into<String>) -> Self {
        Self { state: "failed", reason: Some(code.into()), answer: String::new(), sources: Vec::new(), partial: false }
    }

    fn stopped() -> Self {
        Self { state: "stopped", reason: Some("user".to_string()), answer: String::new(), sources: Vec::new(), partial: true }
    }

    fn partial(code: impl Into<String>, answer: String) -> Self {
        Self { state: "partial", reason: Some(code.into()), answer, sources: Vec::new(), partial: true }
    }
}

fn run_worker(app: AppHandle, spec: TaskSpec, commands: mpsc::Receiver<RuntimeCommand>) {
    if let Err(error) = store::open_task(&app, &spec.uid, &spec.task_id, &spec.origin, &spec.brief) {
        warn!("agent_browser: open_task failed: {error}");
    }
    let mut trace: Vec<TraceEntry> = Vec::new();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_worker_loop(&app, &spec, &commands, &mut trace)
    }));
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(_) => {
            log::error!("agent_browser: worker panicked epoch={}", spec.epoch);
            Outcome::failed("worker_panic")
        }
    };
    if let Ok(root) = store::root_dir(&app) {
        launch::clear_pid_file(&root);
    }
    if let Err(error) = store::finish(
        &app,
        &spec.uid,
        &spec.task_id,
        store::Finish {
            state: outcome.state,
            failure_code: outcome.reason.as_deref(),
            partial: outcome.partial,
            answer: &outcome.answer,
            sources: &outcome.sources,
            trace: &trace,
        },
    ) {
        warn!("agent_browser: finish failed: {error}");
    }
    info!(
        "agent_browser: task ended state={} reason={} steps={} tokens_in={}",
        outcome.state,
        outcome.reason.as_deref().unwrap_or("-"),
        trace.len(),
        trace.iter().map(|t| t.tokens_in).sum::<u64>()
    );

    let Some(handle) = app.try_state::<BrowserAgentHandle>() else { return };
    let (owned, last_url) = {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let owned = state.as_ref().is_some_and(|active| active.epoch == spec.epoch);
        let url = state.as_ref().map(|active| active.url.clone()).unwrap_or_default();
        if owned {
            *state = None;
        }
        (owned, url)
    };
    if owned {
        let _ = app.emit(
            STATUS_EVENT,
            BrowserTaskStatusPayload {
                phase: outcome.state.to_string(),
                task_id: Some(spec.task_id.clone()),
                epoch: Some(spec.epoch),
                origin: Some(spec.origin.clone()),
                brief: Some(spec.brief.clone()),
                steps: trace.len() as u32,
                url: Some(last_url),
                reason: outcome.reason.clone(),
                answer: Some(outcome.answer.clone()),
                sources: outcome.sources.clone(),
                partial: outcome.partial,
            },
        );
    }
}

enum StepError {
    Auth,
    Terminal(String),
    Retry(String),
    Malformed(String),
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("browser agent http client")
    })
}

async fn request_step(token: String, body: Value) -> Result<Value, StepError> {
    let response = client()
        .post(format!("{API_BASE_URL}/agent/step"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| StepError::Retry(if e.is_timeout() { "timeout".to_string() } else { "http".to_string() }))?;
    let status = response.status().as_u16();
    let parsed: Value = response.json().await.unwrap_or(Value::Null);
    let code = parsed.get("error").and_then(Value::as_str).unwrap_or("").to_string();
    match status {
        200 => Ok(parsed),
        401 | 403 => Err(StepError::Auth),
        402 | 429 => Err(StepError::Terminal(if code.is_empty() { "quota".to_string() } else { code })),
        422 => Err(StepError::Malformed(
            parsed.get("shape").and_then(Value::as_str).unwrap_or("malformed").to_string(),
        )),
        _ => Err(StepError::Retry(if code.is_empty() { format!("http_{status}") } else { code })),
    }
}

/// Byte ceiling on a read_page text before it becomes the next snapshot.
const READ_PAGE_MAX_BYTES: usize = 100_000;

/// The longest prefix of `text` that fits in `max_bytes`, on a char boundary.
fn clip_bytes(mut text: String, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

fn parse_action(value: &Value) -> Option<Action> {
    let action = value.get("action")?;
    let string = |key: &str| action.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    Some(Action {
        kind: string("type"),
        why: string("why"),
        ref_id: string("ref"),
        text: string("text"),
        submit: action.get("submit").and_then(Value::as_bool).unwrap_or(false),
        direction: string("direction"),
        url: string("url"),
        ms: action.get("ms").and_then(Value::as_u64).unwrap_or(0),
        answer: string("answer"),
        sources: action
            .get("sources")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        reason: string("reason"),
        detail: string("detail"),
    })
}

/// What the worker returns from a command drain.
enum Drained {
    Continue,
    Stop,
}

struct Visibility<'a> {
    cdp: &'a cdp::CdpClient,
    page: &'a cdp::Page,
    pid: u32,
    visible: bool,
}

impl Visibility<'_> {
    fn apply(&mut self, visible: bool) {
        self.visible = visible;
        launch::set_windows_visible(self.pid, visible);
        // Windows hides the HWND itself; the protocol minimize would put a
        // taskbar button back. macOS relies on the protocol alone.
        if visible || !cfg!(target_os = "windows") {
            cdp::set_window_visible(self.cdp, self.page, visible);
        }
    }
}

fn drain_commands(commands: &mpsc::Receiver<RuntimeCommand>, visibility: &mut Visibility<'_>) -> Drained {
    while let Ok(command) = commands.try_recv() {
        match command {
            RuntimeCommand::Stop => return Drained::Stop,
            RuntimeCommand::Watch => {
                let next = !visibility.visible;
                visibility.apply(next);
            }
            RuntimeCommand::Approve(_) => {}
        }
    }
    Drained::Continue
}

fn run_worker_loop(
    app: &AppHandle,
    spec: &TaskSpec,
    commands: &mpsc::Receiver<RuntimeCommand>,
    trace: &mut Vec<TraceEntry>,
) -> Outcome {
    let started = Instant::now();
    emit_progress(app, spec.epoch, "launching", 0, "");

    let root = match store::root_dir(app) {
        Ok(root) => root,
        Err(error) => {
            warn!("agent_browser: no data dir: {error}");
            return Outcome::failed("data_dir_unavailable");
        }
    };
    let mut launched = match launch::launch(&root) {
        Ok(launched) => launched,
        Err(error) => {
            warn!("agent_browser: launch failed code={} detail={}", error.code(), error.detail());
            return Outcome::failed(error.code());
        }
    };
    let cdp = match cdp::CdpClient::connect(launched.port, &launched.browser_ws_path) {
        Ok(cdp) => cdp,
        Err(error) => {
            warn!("agent_browser: {error}");
            launched.kill();
            return Outcome::failed("cdp_connect_failed");
        }
    };
    let page = match cdp::attach_page(&cdp) {
        Ok(page) => page,
        Err(error) => {
            warn!("agent_browser: attach failed: {error}");
            launched.kill();
            return Outcome::failed("cdp_attach_failed");
        }
    };
    let mut visibility = Visibility { cdp: &cdp, page: &page, pid: launched.pid, visible: true };
    visibility.apply(false);

    // The account must not have changed while the browser came up.
    if let Err(error) = security::recheck(app, Operation::StartBrowserTask, &spec.ticket) {
        warn!("agent_browser: {error}");
        let _ = cdp.call(None, "Browser.close", json!({}));
        launched.kill();
        return Outcome::failed("stale_auth");
    }
    info!(
        "agent_browser: task started browser={} launch_ms={}",
        launched.browser.label(),
        started.elapsed().as_millis()
    );

    let outcome = drive(app, spec, commands, trace, &cdp, &page, &mut visibility, started);

    // Cleanup in a fixed order: a polite close, then the hard kill.
    let _ = cdp.call(None, "Browser.close", json!({}));
    std::thread::sleep(Duration::from_millis(300));
    cdp.close();
    launched.kill();
    outcome
}

#[allow(clippy::too_many_arguments)]
fn drive(
    app: &AppHandle,
    spec: &TaskSpec,
    commands: &mpsc::Receiver<RuntimeCommand>,
    trace: &mut Vec<TraceEntry>,
    cdp: &cdp::CdpClient,
    page: &cdp::Page,
    visibility: &mut Visibility<'_>,
    started: Instant,
) -> Outcome {
    let mut notes = String::new();
    let mut history: Vec<Value> = Vec::new();
    let mut full_text = String::new();
    let mut refs = std::collections::HashMap::new();
    let mut page_offset = 0usize;
    let mut reuse_tree = false;
    // True while `full_text` holds the page's readable text from a read_page
    // action rather than the element tree. It has no refs, so the guard refuses
    // any click on it, and the next non-paging action refreshes the tree.
    let mut read_mode = false;
    let mut last_action_line = String::from("(none)");
    let mut consecutive_denials = 0u32;
    let mut step: u32 = 0;
    let mut retried_503 = false;
    let mut dialogs: Vec<cdp::Event> = Vec::new();

    loop {
        if matches!(drain_commands(commands, visibility), Drained::Stop) {
            return Outcome::stopped();
        }
        if step >= STEP_CAP {
            return Outcome::partial("step_cap", notes.clone());
        }
        if started.elapsed() >= WALL_CLOCK_LIMIT {
            return Outcome::partial("time_cap", notes.clone());
        }
        let step_started = Instant::now();

        let mut events = std::mem::take(&mut dialogs);
        events.extend(cdp.drain_events());
        let event_outcome = cdp::handle_events(cdp, page, events);
        if event_outcome.page_closed {
            return Outcome::failed("page_closed");
        }

        if !reuse_tree {
            match cdp::full_ax_tree(cdp, page) {
                Ok(nodes) => {
                    let rendered = snapshot::render(&nodes);
                    full_text = rendered.text;
                    refs = rendered.refs;
                    page_offset = 0;
                    read_mode = false;
                }
                Err(error) => {
                    warn!("agent_browser: snapshot failed: {error}");
                    return Outcome::failed("snapshot_failed");
                }
            }
        }
        reuse_tree = false;
        let (chunk, truncated) = snapshot::page(&full_text, page_offset);
        let info = match cdp::page_info(cdp, page) {
            Ok(info) => info,
            Err(error) => {
                warn!("agent_browser: page_info failed: {error}");
                return Outcome::failed("page_closed");
            }
        };
        let mode_line = if read_mode {
            "MODE: read_page (the page's readable text; no refs on this snapshot)\n"
        } else {
            ""
        };
        let snapshot_text = format!(
            "{mode_line}SCROLL: y={}/{} viewport={}\nLAST_ACTION: {}\n{}",
            info.scroll_y, info.scroll_height, info.viewport_height, last_action_line, chunk
        );

        let token = match TOKEN.lock().unwrap_or_else(|e| e.into_inner()).usable() {
            Some(token) => token,
            None => return Outcome::failed("no_credential"),
        };
        let remaining_ms = WALL_CLOCK_LIMIT.saturating_sub(started.elapsed()).as_millis() as u64;
        let body = json!({
            "task_id": spec.task_id,
            "step": step,
            "brief": spec.brief,
            "page": { "url": info.url, "title": info.title, "snapshot": snapshot_text, "truncated": truncated },
            "history": history.iter().rev().take(HISTORY_KEEP).rev().collect::<Vec<_>>(),
            "notes": notes,
            "remaining_steps": STEP_CAP.saturating_sub(step),
            "remaining_ms": remaining_ms,
        });
        let model_started = Instant::now();
        let response = tauri::async_runtime::block_on(request_step(token, body));
        let response = match response {
            Ok(response) => response,
            Err(StepError::Auth) => {
                TOKEN.lock().unwrap_or_else(|e| e.into_inner()).clear();
                return Outcome::failed("no_credential");
            }
            Err(StepError::Terminal(code)) => return Outcome::failed(code),
            Err(StepError::Malformed(shape)) => {
                // Counted as a step, fed back as history, so the next call
                // sees what was wrong instead of repeating it.
                step += 1;
                history.push(json!({ "step": step, "action": "invalid", "result": format!("malformed:{shape}") }));
                last_action_line = format!("your last action was malformed ({shape}); choose again");
                reuse_tree = true;
                continue;
            }
            Err(StepError::Retry(code)) => {
                if retried_503 {
                    return Outcome::failed(format!("backend_{code}"));
                }
                retried_503 = true;
                std::thread::sleep(Duration::from_secs(2));
                reuse_tree = true;
                continue;
            }
        };
        retried_503 = false;
        let model_ms = model_started.elapsed().as_millis() as u64;
        let Some(action) = parse_action(&response) else {
            return Outcome::failed("backend_invalid");
        };
        notes = response
            .get("notes")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(1024)
            .collect();
        let tokens_in = response.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0);
        let tokens_out = response.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0);
        let model = response.pointer("/usage/model").and_then(Value::as_str).unwrap_or("").to_string();
        step += 1;

        // The gate, in code, before anything touches the browser.
        let mut result = String::from("ok");
        let gate = guard::check(&action, &refs);
        let allowed = match gate {
            Gate::Allow => true,
            Gate::Refuse(code) => {
                result = code.to_string();
                false
            }
            Gate::NeedsApproval { description } => {
                emit_progress(app, spec.epoch, "awaiting_approval", step, &info.url);
                let _ = app.emit(
                    APPROVAL_EVENT,
                    ApprovalPayload {
                        task_id: spec.task_id.clone(),
                        epoch: spec.epoch,
                        description,
                        url: info.url.clone(),
                    },
                );
                let deadline = Instant::now() + APPROVAL_WAIT;
                let mut decision = false;
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match commands.recv_timeout(remaining) {
                        Ok(RuntimeCommand::Approve(allow)) => {
                            decision = allow;
                            break;
                        }
                        Ok(RuntimeCommand::Stop) => return Outcome::stopped(),
                        Ok(RuntimeCommand::Watch) => {
                            let next = !visibility.visible;
                            visibility.apply(next);
                        }
                        Err(_) => break,
                    }
                }
                if decision {
                    consecutive_denials = 0;
                } else {
                    consecutive_denials += 1;
                    result = "denied_by_user".to_string();
                    if consecutive_denials >= MAX_CONSECUTIVE_DENIALS {
                        trace.push(TraceEntry {
                            step,
                            action: action.kind.clone(),
                            ref_id: action.ref_id.clone(),
                            url: info.url.clone(),
                            ms: step_started.elapsed().as_millis() as u64,
                            tokens_in,
                            tokens_out,
                            result: result.clone(),
                            model: model.clone(),
                        });
                        return Outcome::partial("approval_denied", notes.clone());
                    }
                }
                decision
            }
        };

        let mut navigated = false;
        if allowed {
            let outcome: Result<(), String> = match action.kind.as_str() {
                "click" => {
                    let target = refs.get(&action.ref_id).map(|t| t.backend_node_id).unwrap_or_default();
                    navigated = true;
                    cdp::click(cdp, page, target)
                }
                "type" => {
                    let target = refs.get(&action.ref_id).map(|t| t.backend_node_id).unwrap_or_default();
                    navigated = action.submit;
                    cdp::type_text(cdp, page, target, &action.text, action.submit)
                }
                "scroll" => {
                    let target = (!action.ref_id.is_empty())
                        .then(|| refs.get(&action.ref_id).map(|t| t.backend_node_id))
                        .flatten();
                    cdp::scroll(cdp, page, action.direction != "up", target)
                }
                "navigate" => {
                    navigated = true;
                    cdp::navigate(cdp, page, &action.url)
                }
                "back" => {
                    navigated = true;
                    cdp::back(cdp, page)
                }
                "read_more" => {
                    page_offset += snapshot::MAX_CHARS;
                    reuse_tree = true;
                    Ok(())
                }
                "read_page" => match cdp::readable_text(cdp, page) {
                    Ok(text) => {
                        // Clipped by BYTES, not chars: the backend refuses a body over
                        // 128 KB before it ever reaches its own character cap, and a
                        // non-ASCII page runs to three bytes a character.
                        full_text = clip_bytes(text, READ_PAGE_MAX_BYTES);
                        refs = std::collections::HashMap::new();
                        page_offset = 0;
                        reuse_tree = true;
                        read_mode = true;
                        Ok(())
                    }
                    Err(error) => Err(error),
                },
                "wait" => {
                    std::thread::sleep(Duration::from_millis(action.ms.min(3000)));
                    Ok(())
                }
                "done" => {
                    trace.push(TraceEntry {
                        step,
                        action: "done".to_string(),
                        ref_id: String::new(),
                        url: info.url.clone(),
                        ms: step_started.elapsed().as_millis() as u64,
                        tokens_in,
                        tokens_out,
                        result: "ok".to_string(),
                        model,
                    });
                    return Outcome {
                        state: "done",
                        reason: None,
                        answer: action.answer.clone(),
                        sources: action.sources.clone(),
                        partial: false,
                    };
                }
                "blocked" => {
                    trace.push(TraceEntry {
                        step,
                        action: "blocked".to_string(),
                        ref_id: String::new(),
                        url: info.url.clone(),
                        ms: step_started.elapsed().as_millis() as u64,
                        tokens_in,
                        tokens_out,
                        result: action.reason.clone(),
                        model,
                    });
                    let answer = if action.detail.is_empty() { notes.clone() } else { action.detail.clone() };
                    return Outcome::partial(format!("blocked:{}", action.reason), answer);
                }
                other => Err(format!("unknown action {other}")),
            };
            if let Err(error) = outcome {
                warn!("agent_browser: action {} failed: {error}", action.kind);
                result = "action_failed".to_string();
            } else if navigated {
                cdp::wait_load(cdp, page, &mut dialogs);
            } else if action.kind == "scroll" || action.kind == "type" {
                std::thread::sleep(Duration::from_millis(300));
            }
        }
        let after = cdp::handle_events(cdp, page, cdp.drain_events());
        if after.page_closed {
            return Outcome::failed("page_closed");
        }
        if after.popup_blocked {
            result = "popup_blocked".to_string();
        }
        let url_after = cdp::page_info(cdp, page).map(|i| i.url).unwrap_or_default();
        let step_ms = step_started.elapsed().as_millis() as u64;
        trace.push(TraceEntry {
            step,
            action: action.kind.clone(),
            ref_id: action.ref_id.clone(),
            url: url_after.clone(),
            ms: step_ms,
            tokens_in,
            tokens_out,
            result: result.clone(),
            model,
        });
        // `why` is the model's one-line rationale, never page text, so it is
        // safe to log and is what makes a trace readable after the fact.
        info!(
            "agent_browser: step={step} action={} result={result} model_ms={model_ms} step_ms={step_ms} tokens_in={tokens_in} why={:?}",
            action.kind,
            action.why.chars().take(120).collect::<String>()
        );
        history.push(json!({
            "step": step,
            "action": action.kind,
            "ref": action.ref_id,
            "text": action.text.chars().take(60).collect::<String>(),
            "result": result,
            "url_after": url_after,
        }));
        if history.len() > HISTORY_KEEP {
            history.remove(0);
        }
        last_action_line = format!("{} {} -> {result}", action.kind, action.ref_id);
        if let Err(error) = store::checkpoint(app, &spec.uid, &spec.task_id, "running", trace) {
            warn!("agent_browser: checkpoint failed: {error}");
        }
        emit_progress(app, spec.epoch, "running", step, &url_after);
    }
}
