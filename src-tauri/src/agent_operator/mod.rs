//! The desktop Operator: a task the user starts that reads, clicks and types in
//! their own applications (future-features.txt, "OPERATOR HANDS + DYNAMIC
//! STEPPING", phases P2 and P3).
//!
//! The shape is `agent_browser/mod.rs`: one handle holding at most one live
//! task, a worker thread under `catch_unwind` that always releases the handle
//! and says how it ended, a cancel generation so a Stop cannot be overtaken by
//! the start it interrupted, and `is_active` gating the updater. Per step: list
//! the open windows, read the window being worked in (`native_ui`), post it with
//! the brief and a short history to `POST /agent/desktop-step` (which holds the
//! model key and answers with ONE action), run the action through the guard
//! (`guard.rs`) and then through `native_ui`, record a trace line, checkpoint the
//! encrypted row (`store.rs`), and repeat.
//!
//! There is no step or time cap. The task ends when the model says done, when
//! it stops reaching anything new (`agent_governor.rs`), when the user says
//! Stop, or at a spend check-in the user declines.
//!
//! Work is command-first, the way a coding agent works in a terminal:
//! `run_command` (PowerShell, `shell.rs`), then `web_search` / `fetch_url`
//! (`web.rs`), and only then an app's own window. The output of a command or a
//! page replaces the window tree as that step's observation.
//!
//! Only when asked: `Operation::OperatorTask` is the only grant of any of
//! this, and only `start` asks for it, from the Start card a Swarm desktop_task
//! decision shows in the channel (`origin` "swarm:<message id>"). No chat or voice
//! model holds these verbs as tools. The ticket is rechecked before every
//! action, so a sign-out or a withdrawn opt-in stops the very next step.
//!
//! The person can still be at the keyboard. Aura injects nothing while the
//! model is thinking, so any input during that window is theirs: the task
//! pauses and asks, rather than fighting them for the cursor.

pub mod consent;
pub mod guard;
pub mod shell;
pub mod store;
pub mod web;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use log::{info, warn};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_governor::{self, Governor, Verdict};
use crate::events::{
    OPERATOR_TASK_APPROVAL as APPROVAL_EVENT, OPERATOR_TASK_CHECKIN as CHECKIN_EVENT,
    OPERATOR_TASK_STATUS as STATUS_EVENT,
};
use crate::native_ui::{self, NativeUi, Snapshot, UiAction, WindowEntry};
use crate::security::{self, Operation};
use guard::{Action, Gate};
use store::TraceEntry;

/// Mirrors `API_BASE_URL` in `src/lib/api.ts`, for the same reason
/// agent_browser carries its own copy.
const API_BASE_URL: &str = "https://juno-backend-620715294422.us-central1.run.app";

const APPROVAL_WAIT: Duration = Duration::from_secs(60);
/// How long a spend check-in, or a pause for the user's own input, waits.
const CHECKIN_WAIT: Duration = Duration::from_secs(30 * 60);
/// Mirrors the backend's desktop PER_STEP_ESTIMATE_MICROUSD, for a step whose
/// response carries no cost.
const PER_STEP_ESTIMATE_MICROUSD: u64 = 70_000;
const MAX_CONSECUTIVE_DENIALS: u32 = 2;
const HISTORY_KEEP: usize = 10;
const MAX_BRIEF_CHARS: usize = 500;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A step can be a done answer carrying a full report, which the backend gives
/// its model up to 60 s to write.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
/// Mirrors the backend's desktop MAX_NOTES_CHARS.
const MAX_NOTES_CHARS: usize = 8000;
/// The longest origin a Swarm hand-off can carry: "swarm:" and a message id.
const MAX_ORIGIN_CHARS: usize = 134;
/// How long a launched app has to show a window before the model is told it
/// opened without one.
const LAUNCH_WINDOW_WAIT: Duration = Duration::from_secs(10);
/// A window screenshot larger than this is not sent.
const MAX_IMAGE_BYTES: usize = 900_000;
/// Characters of the window tree per step; read_more pages through the rest.
const TREE_PAGE_CHARS: usize = 60_000;

pub enum RuntimeCommand {
    Stop,
    Approve(bool),
}

struct Active {
    epoch: u64,
    task_id: String,
    brief: String,
    origin: String,
    phase: String,
    steps: u32,
    app: String,
    commands: mpsc::Sender<RuntimeCommand>,
}

#[derive(Default)]
pub struct OperatorHandle(Mutex<Option<Active>>, AtomicU64);

/// Same shape as the browser task's status payload, so the webview renders
/// both with one card. `url` is always empty here; `app` says where it is.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorStatusPayload {
    pub phase: String,
    pub task_id: Option<String>,
    pub epoch: Option<u64>,
    pub origin: Option<String>,
    pub brief: Option<String>,
    pub steps: u32,
    pub url: Option<String>,
    pub app: Option<String>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckinPayload {
    task_id: String,
    epoch: u64,
    spent_microusd: u64,
    steps: u32,
    url: String,
    /// "spend" for the $1 check-in, "user_input" when the person touched the
    /// mouse or keyboard mid-task.
    reason: String,
}

fn status(
    phase: &str,
    active: Option<(&str, u64, &str, &str)>,
    steps: u32,
    app: &str,
) -> OperatorStatusPayload {
    OperatorStatusPayload {
        phase: phase.to_string(),
        task_id: active.map(|a| a.0.to_string()),
        epoch: active.map(|a| a.1),
        origin: active.map(|a| a.2.to_string()),
        brief: active.map(|a| a.3.to_string()),
        steps,
        url: None,
        app: (!app.is_empty()).then(|| app.to_string()),
        reason: None,
        answer: None,
        sources: Vec::new(),
        partial: false,
    }
}

fn idle_status() -> OperatorStatusPayload {
    status("idle", None, 0, "")
}

fn snapshot_status(handle: &OperatorHandle) -> OperatorStatusPayload {
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    match state.as_ref() {
        Some(a) => status(&a.phase, Some((&a.task_id, a.epoch, &a.origin, &a.brief)), a.steps, &a.app),
        None => idle_status(),
    }
}

fn emit_progress(app: &AppHandle, epoch: u64, phase: &str, steps: u32, target_app: &str) {
    let Some(handle) = app.try_state::<OperatorHandle>() else { return };
    let payload = {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(active) = state.as_mut().filter(|a| a.epoch == epoch) else { return };
        active.phase = phase.to_string();
        active.steps = steps;
        active.app = target_app.to_string();
        status(phase, Some((&active.task_id, epoch, &active.origin, &active.brief)), steps, target_app)
    };
    let _ = app.emit(STATUS_EVENT, payload);
}

pub fn is_active(app: &AppHandle) -> bool {
    app.try_state::<OperatorHandle>()
        .map(|handle| handle.0.lock().unwrap_or_else(|e| e.into_inner()).is_some())
        .unwrap_or(false)
}

pub fn active_task_id(app: &AppHandle) -> Option<String> {
    let handle = app.try_state::<OperatorHandle>()?;
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    state.as_ref().map(|active| active.task_id.clone())
}

/// Asks the worker to stop and tells the webview at once.
pub fn request_stop(app: &AppHandle, reason: &str) {
    let Some(handle) = app.try_state::<OperatorHandle>() else { return };
    handle.1.fetch_add(1, Ordering::Relaxed);
    let active = handle.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(active) = active {
        let _ = active.commands.send(RuntimeCommand::Stop);
        let mut payload = status(
            "stopped",
            Some((&active.task_id, active.epoch, &active.origin, &active.brief)),
            active.steps,
            &active.app,
        );
        payload.reason = Some(reason.to_string());
        payload.partial = true;
        let _ = app.emit(STATUS_EVENT, payload);
    }
}

/// Startup: mirror the persisted opt-in into the security state.
pub fn on_startup(app: &AppHandle) {
    security::set_operator_task_consent(app, consent::is_accepted(app));
}

pub fn kill_for_shutdown(app: &AppHandle) {
    if !is_active(app) {
        return;
    }
    request_stop(app, "exit");
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && WORKERS.load(Ordering::Relaxed) > 0 {
        std::thread::sleep(Duration::from_millis(50));
    }
}

static WORKERS: AtomicU64 = AtomicU64::new(0);

/// Starts a task. The only entry point, and the only place
/// `Operation::OperatorTask` is asked for.
pub fn start(app: &AppHandle, brief: &str, origin: &str) -> Result<OperatorStatusPayload, String> {
    let brief = brief.trim();
    if brief.is_empty() {
        return Err("Tell Buddy what to do first.".to_string());
    }
    if brief.chars().count() > MAX_BRIEF_CHARS {
        return Err("That request is too long. Keep it to a sentence or two.".to_string());
    }
    if !cfg!(windows) {
        return Err("Desktop tasks work on Windows for now. Mac support is on the way.".to_string());
    }
    // "dashboard", or "swarm:<message id>" from a Swarm Start card, which is how
    // the channel finds this task again. Anything else is recorded as dashboard.
    let swarm_origin = origin.strip_prefix("swarm:").is_some_and(|id| {
        !id.is_empty()
            && origin.len() <= MAX_ORIGIN_CHARS
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    });
    let origin = if swarm_origin { origin } else { "dashboard" };
    let handle = app
        .try_state::<OperatorHandle>()
        .ok_or_else(|| "desktop agent unavailable".to_string())?;
    let cancel_generation = handle.1.load(Ordering::Relaxed);
    let ticket = security::authorize(app, Operation::OperatorTask)?;
    let uid = security::current_uid(app).ok_or_else(|| "denied: signed out".to_string())?;
    if crate::agent_browser::usable_credential().is_none() {
        return Err("Buddy is not signed in for desktop tasks yet. Try again in a moment.".to_string());
    }

    let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if handle.1.load(Ordering::Relaxed) != cancel_generation {
        return Err("The desktop task start was cancelled.".to_string());
    }
    if state.is_some() {
        return Err("Buddy is already working on a desktop task.".to_string());
    }
    static NEXT_EPOCH: AtomicU64 = AtomicU64::new(0);
    let epoch = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    let task_id = format!("dt-{}-{epoch}", crate::util::now_ms());
    let (command_tx, command_rx) = mpsc::channel();
    *state = Some(Active {
        epoch,
        task_id: task_id.clone(),
        brief: brief.to_string(),
        origin: origin.to_string(),
        phase: "starting".to_string(),
        steps: 0,
        app: String::new(),
        commands: command_tx,
    });
    drop(state);
    emit_progress(app, epoch, "starting", 0, "");

    let spec = TaskSpec { task_id, brief: brief.to_string(), origin: origin.to_string(), epoch, uid, ticket };
    let worker_app = app.clone();
    WORKERS.fetch_add(1, Ordering::Relaxed);
    std::thread::Builder::new()
        .name("aura-desktop-agent".to_string())
        .spawn(move || {
            run_worker(worker_app, spec, command_rx);
            WORKERS.fetch_sub(1, Ordering::Relaxed);
        })
        .map_err(|error| {
            WORKERS.fetch_sub(1, Ordering::Relaxed);
            *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
            format!("could not start the desktop task: {error}")
        })?;
    Ok(snapshot_status(&handle))
}

fn send_command(app: &AppHandle, command: RuntimeCommand) -> Result<(), String> {
    let handle = app
        .try_state::<OperatorHandle>()
        .ok_or_else(|| "desktop agent unavailable".to_string())?;
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    let active = state.as_ref().ok_or_else(|| "no desktop task is running".to_string())?;
    active
        .commands
        .send(command)
        .map_err(|_| "the desktop task has already ended".to_string())
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn desktop_task_start(
    app: AppHandle,
    brief: String,
    origin: Option<String>,
) -> Result<OperatorStatusPayload, String> {
    start(&app, &brief, origin.as_deref().unwrap_or("dashboard"))
}

#[tauri::command]
pub fn desktop_task_stop(app: AppHandle) -> OperatorStatusPayload {
    request_stop(&app, "user");
    idle_status()
}

#[tauri::command]
pub fn desktop_task_approve(app: AppHandle, allow: bool) -> Result<(), String> {
    send_command(&app, RuntimeCommand::Approve(allow))
}

#[tauri::command]
pub fn desktop_task_status(app: AppHandle) -> OperatorStatusPayload {
    app.try_state::<OperatorHandle>()
        .map(|handle| snapshot_status(&handle))
        .unwrap_or_else(idle_status)
}

#[tauri::command]
pub fn desktop_task_consent(app: AppHandle) -> bool {
    consent::is_accepted(&app)
}

#[tauri::command]
pub async fn set_desktop_task_consent(app: AppHandle, accepted: bool) -> Result<bool, String> {
    let accepted = consent::set_accepted(&app, accepted)?;
    if !accepted {
        // Withdrawing the opt-in mid-task stops it now, not at the next recheck.
        request_stop(&app, "consent_withdrawn");
    }
    Ok(accepted)
}

#[tauri::command]
pub async fn desktop_tasks_list(app: AppHandle, uid: String) -> Result<Vec<store::TaskSummary>, String> {
    if uid.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || store::list(&app, &uid))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn desktop_task_load(app: AppHandle, uid: String, task_id: String) -> Result<Option<store::TaskDetail>, String> {
    if uid.is_empty() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || store::load(&app, &uid, &task_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn desktop_task_delete(app: AppHandle, uid: String, task_id: String) -> Result<(), String> {
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
    partial: bool,
}

impl Outcome {
    fn failed(code: impl Into<String>) -> Self {
        Self { state: "failed", reason: Some(code.into()), answer: String::new(), partial: false }
    }

    fn stopped() -> Self {
        Self { state: "stopped", reason: Some("user".to_string()), answer: String::new(), partial: true }
    }

    fn partial(code: impl Into<String>, answer: String) -> Self {
        Self { state: "partial", reason: Some(code.into()), answer, partial: true }
    }
}

fn run_worker(app: AppHandle, spec: TaskSpec, commands: mpsc::Receiver<RuntimeCommand>) {
    if let Err(error) = store::open_task(&app, &spec.uid, &spec.task_id, &spec.origin, &spec.brief) {
        warn!("agent_operator: open_task failed: {error}");
    }
    let mut trace: Vec<TraceEntry> = Vec::new();
    let mut last_app = String::new();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        drive(&app, &spec, &commands, &mut trace, &mut last_app)
    }));
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(_) => {
            log::error!("agent_operator: worker panicked epoch={}", spec.epoch);
            Outcome::failed("worker_panic")
        }
    };
    if let Err(error) = store::finish(
        &app,
        &spec.uid,
        &spec.task_id,
        store::Finish {
            state: outcome.state,
            failure_code: outcome.reason.as_deref(),
            partial: outcome.partial,
            answer: &outcome.answer,
            sources: &[],
            trace: &trace,
        },
    ) {
        warn!("agent_operator: finish failed: {error}");
    }
    info!(
        "agent_operator: task ended state={} reason={} steps={} cost_microusd={}",
        outcome.state,
        outcome.reason.as_deref().unwrap_or("-"),
        trace.len(),
        trace.iter().map(|t| t.cost_microusd).sum::<u64>()
    );

    let Some(handle) = app.try_state::<OperatorHandle>() else { return };
    let owned = {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let owned = state.as_ref().is_some_and(|active| active.epoch == spec.epoch);
        if owned {
            *state = None;
        }
        owned
    };
    if owned {
        let mut payload = status(
            outcome.state,
            Some((&spec.task_id, spec.epoch, &spec.origin, &spec.brief)),
            trace.len() as u32,
            &last_app,
        );
        payload.reason = outcome.reason.clone();
        payload.answer = Some(outcome.answer.clone());
        payload.partial = outcome.partial;
        let _ = app.emit(STATUS_EVENT, payload);
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
            .expect("desktop agent http client")
    })
}

async fn request_step(token: String, body: Value) -> Result<Value, StepError> {
    let response = client()
        .post(format!("{API_BASE_URL}/agent/desktop-step"))
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

fn parse_action(value: &Value) -> Option<Action> {
    let action = value.get("action")?;
    let string = |key: &str| action.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    Some(Action {
        kind: string("type"),
        why: string("why"),
        command: string("command"),
        query: string("query"),
        url: string("url"),
        ref_id: string("ref"),
        text: string("text"),
        submit: action.get("submit").and_then(Value::as_bool).unwrap_or(false),
        direction: string("direction"),
        app: string("app"),
        window: string("window"),
        keys: string("keys"),
        ms: action.get("ms").and_then(Value::as_u64).unwrap_or(0),
        answer: string("answer"),
        reason: string("reason"),
        detail: string("detail"),
    })
}

/// Waits on a card the user answers: an approval (60 s, default no), a spend
/// check-in or an input pause (30 min). `Some(true)` is yes, `Some(false)` is
/// no, `None` means Stop or the task ended.
fn wait_for_answer(commands: &mpsc::Receiver<RuntimeCommand>, wait: Duration) -> Option<bool> {
    match commands.recv_timeout(wait) {
        Ok(RuntimeCommand::Approve(allow)) => Some(allow),
        Ok(RuntimeCommand::Stop) => None,
        Err(mpsc::RecvTimeoutError::Timeout) => Some(false),
        Err(mpsc::RecvTimeoutError::Disconnected) => None,
    }
}

/// The window list the model sees, as `[wN] app: "title"` lines, with the map
/// the next `focus_window` resolves against.
fn windows_block(windows: &[WindowEntry]) -> (String, HashMap<String, WindowEntry>) {
    let mut map = HashMap::new();
    let mut lines = Vec::new();
    for (index, window) in windows.iter().enumerate() {
        let id = format!("w{}", index + 1);
        let title: String = window.title.chars().take(100).collect();
        lines.push(format!("[{id}] {}: \"{title}\"", window.app));
        map.insert(id, window.clone());
    }
    (lines.join("\n"), map)
}

/// The window, cut from a frozen frame of its display, as base64 JPEG.
fn capture_window(hwnd: isize) -> Result<String, String> {
    let (x, y, width, height) = native_ui::window_rect(hwnd).ok_or("no_window_rect")?;
    let center = (x + width as i32 / 2, y + height as i32 / 2);
    let (frozen, _still) = crate::screenshot::freeze_display_blocking(center)?;
    let frame = crate::screenshot::crop_frozen_display(
        frozen,
        Some(crate::screenshot::CropRect { x, y, width, height }),
    )?;
    let jpeg = frame.into_jpeg();
    if jpeg.len() > MAX_IMAGE_BYTES {
        return Err("image_too_large".to_string());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(jpeg))
}

/// The handles of every listed window, owned ones included, of one process.
fn windows_of_process(pid: u32) -> HashSet<isize> {
    native_ui::list_windows_with_owned(pid)
        .into_iter()
        .filter(|window| native_ui::window_pid(window.hwnd) == pid)
        .map(|window| window.hwnd)
        .collect()
}

/// Launches a catalog entry and waits for a window that was not there before.
fn launch_and_find(entry: &crate::app_catalog::AppEntry) -> Result<Option<isize>, String> {
    let before: std::collections::HashSet<isize> =
        native_ui::list_windows().into_iter().map(|w| w.hwnd).collect();
    crate::app_catalog::launch(&entry.launch)?;
    let deadline = Instant::now() + LAUNCH_WINDOW_WAIT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(400));
        let fresh: Vec<WindowEntry> = native_ui::list_windows()
            .into_iter()
            .filter(|w| !before.contains(&w.hwnd))
            .collect();
        if fresh.is_empty() {
            continue;
        }
        // The new window in front, if any; otherwise the first new one.
        let foreground = native_ui::foreground_window();
        let chosen = fresh.iter().find(|w| w.hwnd == foreground).unwrap_or(&fresh[0]);
        // Give it a moment to finish drawing its first screen.
        std::thread::sleep(Duration::from_millis(800));
        return Ok(Some(chosen.hwnd));
    }
    Ok(None)
}

fn drive(
    app: &AppHandle,
    spec: &TaskSpec,
    commands: &mpsc::Receiver<RuntimeCommand>,
    trace: &mut Vec<TraceEntry>,
    last_app: &mut String,
) -> Outcome {
    let Some(ui) = app.try_state::<NativeUi>() else {
        return Outcome::failed("ui_unavailable");
    };
    let catalog = crate::app_catalog::enumerate_apps();
    let catalog_line = catalog.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>().join(", ");

    let mut notes = String::new();
    let mut history: Vec<Value> = Vec::new();
    let mut target: Option<isize> = None;
    let mut snapshot = Snapshot::default();
    let mut full_text = String::new();
    let mut page_offset = 0usize;
    let mut reuse_tree = false;
    let mut look_next = false;
    let mut last_action_line = String::from("(none)");
    let mut consecutive_denials = 0u32;
    let mut step: u32 = 0;
    let mut retried = false;
    let mut governor = Governor::default();
    let mut observed_step: Option<u32> = None;
    // What the last command, page or search printed, with its heading. It is
    // that step's observation in place of the window tree.
    let mut output_block: Option<(&'static str, String)> = None;
    // Websites the user allowed in this task; a new one asks again.
    let mut allowed_hosts: HashSet<String> = HashSet::new();
    // Input ticks Aura itself caused end here; anything after is the person.
    let mut input_mark = native_ui::last_input_tick();

    loop {
        while let Ok(command) = commands.try_recv() {
            if matches!(command, RuntimeCommand::Stop) {
                return Outcome::stopped();
            }
        }
        let step_started = Instant::now();

        // The world as it is now: open windows, and the one being worked in.
        if let Some(hwnd) = target {
            if !native_ui::window_exists(hwnd) {
                target = None;
                last_action_line = format!("{last_action_line} (the window it was working in closed)");
            }
        }
        // Per step: the model answers against the list it was just shown. The
        // target's own secondary windows (its Settings, its dialogs) are owned
        // by its main window and would otherwise be left out.
        let target_pid = target.map(native_ui::window_pid).unwrap_or(0);
        let (windows_text, windows_map) = windows_block(&native_ui::list_windows_with_owned(target_pid));
        let (target_app, target_title) = match target {
            Some(hwnd) => (native_ui::app_stem(hwnd), native_ui::window_title(hwnd)),
            None => (String::new(), String::new()),
        };
        *last_app = target_app.clone();
        if let Some(hwnd) = target {
            if !reuse_tree {
                match ui.snapshot(hwnd) {
                    Ok(fresh) => {
                        full_text = fresh.text.clone();
                        snapshot = fresh;
                        page_offset = 0;
                    }
                    Err(code) => {
                        warn!("agent_operator: snapshot failed: {code}");
                        if code == "unsupported_platform" {
                            return Outcome::failed(code);
                        }
                        snapshot = Snapshot::default();
                        full_text = format!("(This window could not be read: {code}.)");
                        page_offset = 0;
                    }
                }
            }
        } else {
            snapshot = Snapshot::default();
            full_text = String::new();
            page_offset = 0;
        }
        reuse_tree = false;
        let chunk: String = full_text.chars().skip(page_offset).take(TREE_PAGE_CHARS).collect();
        let truncated = full_text.chars().count() > page_offset + TREE_PAGE_CHARS;

        // Progress is a state this task has not seen before.
        if observed_step != Some(step) {
            observed_step = Some(step);
            let state = agent_governor::fingerprint(&(
                target,
                &target_title,
                &full_text,
                page_offset,
                &windows_text,
                output_block.as_ref().map(|(_, text)| text.as_str()),
            ));
            if governor.observe(state) == Verdict::Stuck {
                info!("agent_operator: stuck after {} actions with nothing new", governor.stall());
                return Outcome::partial("stuck", notes.clone());
            }
        }
        let progressed = governor.stall() == 0;
        let stall_note = if governor.needs_nudge() {
            let recent: Vec<String> = history
                .iter()
                .rev()
                .take(governor.stall() as usize)
                .rev()
                .map(|entry| {
                    format!(
                        "{} {} -> {}",
                        entry.get("action").and_then(Value::as_str).unwrap_or("?"),
                        entry.get("ref").and_then(Value::as_str).unwrap_or(""),
                        entry.get("result").and_then(Value::as_str).unwrap_or(""),
                    )
                })
                .collect();
            format!(
                "your last {} actions reached nothing new ({}). Try a different approach, or finish with done or blocked.",
                governor.stall(),
                recent.join("; ")
            )
        } else {
            String::new()
        };

        let target_line = match target {
            Some(hwnd) => {
                let id = windows_map
                    .iter()
                    .find(|(_, w)| w.hwnd == hwnd)
                    .map(|(id, _)| id.clone())
                    .unwrap_or_default();
                format!("WORKING IN: [{id}] {target_app}: \"{target_title}\"")
            }
            None => "WORKING IN: no window yet. Use launch_app or focus_window first.".to_string(),
        };
        let mut observation = format!(
            "OPEN WINDOWS (focus_window takes one of these ids):\n{windows_text}\n\n{target_line}\nLAST_ACTION: {last_action_line}\n"
        );
        if target.is_none() {
            observation.push_str(&format!(
                "\nINSTALLED APPS (launch_app takes one of these names exactly):\n{catalog_line}\n"
            ));
        }
        if let Some((heading, text)) = &output_block {
            observation.push_str(&format!("\n{heading}:\n{text}\n"));
        } else if !chunk.is_empty() {
            observation.push_str("\nWINDOW CONTENTS:\n");
            observation.push_str(&chunk);
        }

        let mut image: Option<String> = None;
        if look_next {
            look_next = false;
            if let Some(hwnd) = target {
                if security::screen_sight_off(app) {
                    observation.push_str("\n\n(No screenshot: the user has Screen Sight switched off. Work from the control tree.)");
                } else {
                    match capture_window(hwnd) {
                        Ok(b64) => image = Some(b64),
                        Err(code) => observation.push_str(&format!("\n\n(The screenshot failed: {code}.)")),
                    }
                }
            }
        }

        let Some(token) = crate::agent_browser::usable_credential() else {
            return Outcome::failed("no_credential");
        };
        let mut body = json!({
            "task_id": spec.task_id,
            "step": step,
            "brief": spec.brief,
            "observation": observation,
            "truncated": truncated,
            "history": history.iter().rev().take(HISTORY_KEEP).rev().collect::<Vec<_>>(),
            "notes": notes,
            "stall_note": stall_note,
        });
        if let Some(image) = image {
            body["image"] = json!({ "media_type": "image/jpeg", "data": image });
        }
        let model_started = Instant::now();
        let response = match tauri::async_runtime::block_on(request_step(token, body)) {
            Ok(response) => response,
            Err(StepError::Auth) => {
                crate::agent_browser::clear_credential();
                return Outcome::failed("no_credential");
            }
            Err(StepError::Terminal(code)) => return Outcome::failed(code),
            Err(StepError::Malformed(shape)) => {
                step += 1;
                governor.add_spend(PER_STEP_ESTIMATE_MICROUSD);
                history.push(json!({ "step": step, "action": "invalid", "result": format!("malformed:{shape}") }));
                last_action_line = format!("your last action was malformed ({shape}); choose again");
                reuse_tree = true;
                continue;
            }
            Err(StepError::Retry(code)) => {
                if retried {
                    return Outcome::failed(format!("backend_{code}"));
                }
                retried = true;
                std::thread::sleep(Duration::from_secs(2));
                reuse_tree = true;
                continue;
            }
        };
        retried = false;
        let model_ms = model_started.elapsed().as_millis() as u64;
        let Some(action) = parse_action(&response) else {
            return Outcome::failed("backend_invalid");
        };
        notes = response.get("notes").and_then(Value::as_str).unwrap_or("").chars().take(MAX_NOTES_CHARS).collect();
        let tokens_in = response.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0);
        let tokens_out = response.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0);
        let model = response.pointer("/usage/model").and_then(Value::as_str).unwrap_or("").to_string();
        let cost = response
            .pointer("/usage/cost_microusd")
            .and_then(Value::as_u64)
            .unwrap_or(PER_STEP_ESTIMATE_MICROUSD);
        let checkin_due = governor.add_spend(cost);
        step += 1;

        // The person touched the mouse or keyboard while the model was
        // thinking. Their input wins: pause, and act on a fresh view after.
        // Only an action that takes the screen can collide with them; a
        // command, a fetch or a search runs fine while they type (dictation
        // into a terminal paused a command-only task, 2026-10-10).
        let takes_screen = matches!(
            action.kind.as_str(),
            "click" | "type" | "key" | "scroll" | "focus_window" | "launch_app"
        );
        if !takes_screen {
            input_mark = native_ui::last_input_tick();
        } else if native_ui::last_input_tick() != input_mark {
            emit_progress(app, spec.epoch, "awaiting_checkin", step, &target_app);
            let _ = app.emit(
                CHECKIN_EVENT,
                CheckinPayload {
                    task_id: spec.task_id.clone(),
                    epoch: spec.epoch,
                    spent_microusd: governor.spent_microusd(),
                    steps: step,
                    url: target_app.clone(),
                    reason: "user_input".to_string(),
                },
            );
            match wait_for_answer(commands, CHECKIN_WAIT) {
                Some(true) => {}
                Some(false) => return Outcome::partial("paused_timeout", notes.clone()),
                None => return Outcome::stopped(),
            }
            input_mark = native_ui::last_input_tick();
            emit_progress(app, spec.epoch, "running", step, &target_app);
            last_action_line = "(paused while you used the computer; this is a fresh view)".to_string();
            continue;
        }

        // Every action is re-authorized: a sign-out or a withdrawn opt-in
        // stops the very next step.
        if let Err(error) = security::recheck(app, Operation::OperatorTask, &spec.ticket) {
            warn!("agent_operator: {error}");
            return Outcome::failed("stale_auth");
        }

        let mut result = String::from("ok");
        // Parsed (never run) before the guard reads it. Only a command the
        // guard could accept is worth the extra PowerShell start.
        let command_scan = (action.kind == "run_command"
            && !action.command.trim().is_empty()
            && action.command.chars().count() <= shell::MAX_COMMAND_CHARS)
            .then(|| shell::scan(action.command.trim()));
        let gate = guard::check(
            &action,
            &guard::Context {
                refs: &snapshot.refs,
                windows: &windows_map,
                target_app: &target_app,
                target_title: &target_title,
                catalog: &catalog,
                command_scan: command_scan.as_ref(),
                allowed_hosts: &allowed_hosts,
            },
        );
        let allowed = match gate {
            Gate::Allow => true,
            Gate::Refuse(code) => {
                result = code.to_string();
                false
            }
            Gate::NeedsApproval { description } => {
                emit_progress(app, spec.epoch, "awaiting_approval", step, &target_app);
                let _ = app.emit(
                    APPROVAL_EVENT,
                    ApprovalPayload {
                        task_id: spec.task_id.clone(),
                        epoch: spec.epoch,
                        description,
                        url: target_app.clone(),
                    },
                );
                let decision = match wait_for_answer(commands, APPROVAL_WAIT) {
                    Some(decision) => decision,
                    None => return Outcome::stopped(),
                };
                // Clicking the card is input too; it is not the person
                // taking over the computer.
                input_mark = native_ui::last_input_tick();
                emit_progress(app, spec.epoch, "running", step, &target_app);
                if decision {
                    consecutive_denials = 0;
                    // A website is allowed once for the rest of the task.
                    if action.kind == "fetch_url" {
                        if let Ok(host) = web::host_of(&action.url) {
                            allowed_hosts.insert(host);
                        }
                    }
                } else {
                    consecutive_denials += 1;
                    result = "denied_by_user".to_string();
                    if consecutive_denials >= MAX_CONSECUTIVE_DENIALS {
                        trace.push(TraceEntry {
                            step,
                            action: action.kind.clone(),
                            ref_id: action.ref_id.clone(),
                            app: target_app.clone(),
                            ms: step_started.elapsed().as_millis() as u64,
                            tokens_in,
                            tokens_out,
                            cost_microusd: cost,
                            result: result.clone(),
                            model: model.clone(),
                            progressed,
                        });
                        return Outcome::partial("approval_denied", notes.clone());
                    }
                }
                decision
            }
        };

        // A click, a key or an Enter can open a new window of the same app (a
        // Settings window, a dialog). Its windows before the action, to diff.
        let opens_windows = allowed
            && (matches!(action.kind.as_str(), "click" | "key") || (action.kind == "type" && action.submit));
        let windows_before: HashSet<isize> = match target {
            Some(hwnd) if opens_windows => windows_of_process(native_ui::window_pid(hwnd)),
            _ => HashSet::new(),
        };
        if allowed {
            output_block = None;
            let outcome: Result<String, String> = match action.kind.as_str() {
                "run_command" => shell::run(action.command.trim()).map(|text| {
                    output_block = Some(("COMMAND OUTPUT", text));
                    "ok".to_string()
                }),
                "fetch_url" => tauri::async_runtime::block_on(web::fetch(&action.url)).map(|text| {
                    output_block = Some(("PAGE TEXT", text));
                    "ok".to_string()
                }),
                "web_search" => match crate::agent_browser::usable_credential() {
                    Some(token) => tauri::async_runtime::block_on(web::search(token, &spec.task_id, action.query.trim()))
                        .map(|text| {
                            output_block = Some(("SEARCH RESULTS", text));
                            "ok".to_string()
                        }),
                    None => Err("no_credential".to_string()),
                },
                "click" => target
                    .ok_or_else(|| "no_window".to_string())
                    .and_then(|hwnd| ui.act(hwnd, UiAction::Click { ref_id: action.ref_id.clone() })),
                "type" => target.ok_or_else(|| "no_window".to_string()).and_then(|hwnd| {
                    ui.act(
                        hwnd,
                        UiAction::Type { ref_id: action.ref_id.clone(), text: action.text.clone(), submit: action.submit },
                    )
                }),
                "key" => target
                    .ok_or_else(|| "no_window".to_string())
                    .and_then(|hwnd| ui.act(hwnd, UiAction::Key { chord: action.keys.trim().to_ascii_lowercase() })),
                "scroll" => target.ok_or_else(|| "no_window".to_string()).and_then(|hwnd| {
                    ui.act(
                        hwnd,
                        UiAction::Scroll {
                            ref_id: (!action.ref_id.is_empty()).then(|| action.ref_id.clone()),
                            down: action.direction != "up",
                        },
                    )
                }),
                "launch_app" => match guard::catalog_match(&catalog, &action.app) {
                    Some(entry) => match launch_and_find(entry) {
                        Ok(Some(hwnd)) => {
                            target = Some(hwnd);
                            Ok("launched".to_string())
                        }
                        Ok(None) => Ok("launched_no_new_window".to_string()),
                        Err(e) => Err(e),
                    },
                    None => Err("app_not_found".to_string()),
                },
                "focus_window" => match windows_map.get(&action.window) {
                    Some(window) => {
                        target = Some(window.hwnd);
                        if native_ui::bring_to_front(window.hwnd) {
                            Ok("focused".to_string())
                        } else {
                            Ok("selected_not_foreground".to_string())
                        }
                    }
                    None => Err("window_not_found".to_string()),
                },
                "look" => {
                    look_next = true;
                    Ok("screenshot_next".to_string())
                }
                "read_more" => {
                    page_offset += TREE_PAGE_CHARS;
                    reuse_tree = true;
                    Ok("ok".to_string())
                }
                "wait" => {
                    std::thread::sleep(Duration::from_millis(action.ms.min(3000)));
                    Ok("ok".to_string())
                }
                "done" => {
                    trace.push(TraceEntry {
                        step,
                        action: "done".to_string(),
                        ref_id: String::new(),
                        app: target_app.clone(),
                        ms: step_started.elapsed().as_millis() as u64,
                        tokens_in,
                        tokens_out,
                        cost_microusd: cost,
                        result: "ok".to_string(),
                        model,
                        progressed,
                    });
                    return Outcome { state: "done", reason: None, answer: action.answer.clone(), partial: false };
                }
                "blocked" => {
                    trace.push(TraceEntry {
                        step,
                        action: "blocked".to_string(),
                        ref_id: String::new(),
                        app: target_app.clone(),
                        ms: step_started.elapsed().as_millis() as u64,
                        tokens_in,
                        tokens_out,
                        cost_microusd: cost,
                        result: action.reason.clone(),
                        model,
                        progressed,
                    });
                    let answer = if action.detail.is_empty() { notes.clone() } else { action.detail.clone() };
                    return Outcome::partial(format!("blocked:{}", action.reason), answer);
                }
                other => Err(format!("unknown action {other}")),
            };
            match outcome {
                Ok(how) => result = how,
                Err(code) => {
                    warn!("agent_operator: action {} failed: {code}", action.kind);
                    result = code;
                }
            }
            if matches!(action.kind.as_str(), "click" | "type" | "key" | "scroll" | "focus_window") {
                // Let the app draw what the action did before the next read.
                std::thread::sleep(Duration::from_millis(500));
            }
            // The action opened a window of the same app: work in it next, and
            // say so, rather than re-reading the window it was opened from.
            if let Some(hwnd) = target.filter(|_| opens_windows && !windows_before.is_empty()) {
                let pid = native_ui::window_pid(hwnd);
                let opened = native_ui::list_windows_with_owned(pid)
                    .into_iter()
                    .find(|window| native_ui::window_pid(window.hwnd) == pid && !windows_before.contains(&window.hwnd));
                if let Some(window) = opened {
                    target = Some(window.hwnd);
                    result = format!(
                        "{result}; opened \"{}\", now working in it",
                        window.title.chars().take(80).collect::<String>()
                    );
                }
            }
            // Everything Aura injected for this action is now behind the mark.
            input_mark = native_ui::last_input_tick();
        }

        let acted_app = target.map(native_ui::app_stem).unwrap_or_default();
        trace.push(TraceEntry {
            step,
            action: action.kind.clone(),
            ref_id: action.ref_id.clone(),
            app: acted_app.clone(),
            ms: step_started.elapsed().as_millis() as u64,
            tokens_in,
            tokens_out,
            cost_microusd: cost,
            result: result.clone(),
            model,
            progressed,
        });
        // `why` is the model's one-line rationale, never window text.
        info!(
            "agent_operator: step={step} action={} result={result} model_ms={model_ms} cost_microusd={cost} why={:?}",
            action.kind,
            action.why.chars().take(120).collect::<String>()
        );
        history.push(json!({
            "step": step,
            "action": action.kind,
            "ref": if action.kind == "focus_window" { action.window.clone() } else { action.ref_id.clone() },
            "text": match action.kind.as_str() {
                "launch_app" => action.app.chars().take(60).collect::<String>(),
                "run_command" => action.command.chars().take(60).collect::<String>(),
                "fetch_url" => action.url.chars().take(60).collect::<String>(),
                "web_search" => action.query.chars().take(60).collect::<String>(),
                _ => action.text.chars().take(60).collect::<String>(),
            },
            "result": result,
            "app": acted_app,
        }));
        if history.len() > HISTORY_KEEP {
            history.remove(0);
        }
        let target_of = if action.kind == "focus_window" { &action.window } else { &action.ref_id };
        last_action_line = format!("{} {target_of} -> {result}", action.kind);
        if let Err(error) = store::checkpoint(app, &spec.uid, &spec.task_id, "running", trace) {
            warn!("agent_operator: checkpoint failed: {error}");
        }
        emit_progress(app, spec.epoch, "running", step, &acted_app);

        if checkin_due {
            info!("agent_operator: spend check-in step={step} spent_microusd={}", governor.spent_microusd());
            emit_progress(app, spec.epoch, "awaiting_checkin", step, &acted_app);
            let _ = app.emit(
                CHECKIN_EVENT,
                CheckinPayload {
                    task_id: spec.task_id.clone(),
                    epoch: spec.epoch,
                    spent_microusd: governor.spent_microusd(),
                    steps: step,
                    url: acted_app.clone(),
                    reason: "spend".to_string(),
                },
            );
            match wait_for_answer(commands, CHECKIN_WAIT) {
                Some(true) => {}
                Some(false) => return Outcome::partial("checkin_timeout", notes.clone()),
                None => return Outcome::stopped(),
            }
            governor.extend();
            input_mark = native_ui::last_input_tick();
            emit_progress(app, spec.epoch, "running", step, &acted_app);
        }
    }
}
