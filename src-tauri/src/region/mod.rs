//! "Circle to ask": hold `REGION_CHORD`, stroke any shape over part of the
//! screen, release, and the bounding box of that stroke is cropped out of a
//! screenshot and handed to the frontend.
//!
//! Three things about this module are load bearing and easy to undo by
//! accident:
//!
//! - **Nothing is sampled before `authorize` passes.** A cursor path is a weak
//!   side channel in its own right, so a signed-out or Guide-armed hold records
//!   no points at all rather than recording them into a buffer that is later
//!   thrown away.
//! - **`ChordSignal::Prewarm` must stay a no-op.** `REGION_CHORD` (Win+Alt) and
//!   `DICTATION_CHORD` (Ctrl+Win) share the Win key, so pressing Win alone
//!   prewarms BOTH state machines and the second key then cancels the loser.
//!   Acting on `Prewarm` here would fire the gesture on a bare Win press.
//! - **There is no shape recognition.** Any stroke is accepted. A real user
//!   "circling" something draws an open arc of well under one full turn, so a
//!   closure or angular-travel test rejects the exact gesture people make. The
//!   only guards are point count, area, and a whole-display fallback.
//!
//! Threading mirrors `dictation`: the keyboard hook calls `signal()`, which
//! does nothing but send on an unbounded channel, and a single worker thread
//! owns every piece of state. The hook runs on the OS input-serialisation path
//! and is force-unhooked if it is slow, so it must never lock or allocate here.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use log::{error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::dictation::chord::ChordSignal;
use crate::screenshot::{CropRect, FrozenDisplay};
use crate::security::Operation;

pub use crate::dictation::chord::REGION_CHORD;

/// Sampling period. 60 Hz matches what a trackpad actually produces; anything
/// faster just stores duplicate points.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(16);
/// Ring capacity, about 17 seconds of stroke. Bounded so a chord left held by a
/// stuck key cannot grow memory without limit.
const MAX_POINTS: usize = 1024;
/// A hold longer than this self-cancels. A chord held this long is a stuck key
/// or a forgotten hand, not a gesture.
const MAX_HOLD: Duration = Duration::from_secs(30);
/// Emit one point batch every Nth sample, so the overlay redraws at ~20 Hz.
const POINTS_PER_BATCH: usize = 3;
/// How far the cursor must travel before the trail window is shown at all.
///
/// The chord engaging is NOT enough. `Win+Alt+<digit>` is the Windows taskbar
/// jump-list shortcut, so showing a full-screen window the moment both keys go
/// down would flash something over the user's screen on a combo they press for
/// entirely unrelated reasons. Below this threshold the gesture stays invisible.
const VEIL_REVEAL_PX: i32 = 24;
/// How long the veil waits for its window to say the frozen still has decoded.
/// Past this it is shown anyway: a slow decode must never leave a live gesture
/// invisible, and an unoptimized dev build encodes a 5 MP still slowly.
const VEIL_READY_TIMEOUT: Duration = Duration::from_millis(400);
/// How long the locked selection stays on screen before the veil hides. Kept
/// equal to the lock-in transition in RegionOverlay.css.
const LOCK_IN: Duration = Duration::from_millis(260);
/// How long a release waits for a freeze still in flight. An unoptimized dev
/// build has taken 3.8s to capture and encode a 2880x1800 display.
const FREEZE_WAIT: Duration = Duration::from_secs(8);

/// What the freeze thread hands back: the frozen display and the veil's still.
type FreezeResult = Result<(FrozenDisplay, Vec<u8>), String>;

/// Fewer points than this is a twitch, not a stroke.
const MIN_POINTS: usize = 8;
/// Below this a crop carries no more information than the cursor position.
const MIN_REGION_PX: u32 = 64;
/// Above this a crop buys nothing, so the whole display is sent instead.
const MAX_REGION_FRAC: f64 = 0.85;
/// Strokes hug the thing they circle, so the box is grown before cropping.
const REGION_PAD_FRAC: f64 = 0.15;
const REGION_PAD_MIN_PX: i32 = 12;

/// The fullscreen click-through veil. A separate accessory window rather than an
/// `OverlayPresentation`: the main window IS the answer surface, so taking it
/// fullscreen and then immediately re-laying it out as a notch would be the
/// worst possible sequencing, and `build_accessory_window` already produces
/// exactly the right window (transparent, shadowless, always-on-top, off the
/// taskbar, non-activating, excluded from capture).
///
/// This label MUST be listed in `capabilities/default.json`'s `windows` array,
/// the same way `dictation` and `status-pill` are. Tauri scopes permissions per
/// label, so an unlisted window gets ZERO permissions including
/// `core:event:default`, and its React root silently never receives an event.
/// Nothing fails loudly: the window builds, `Emitter::emit` succeeds, and the
/// overlay just draws nothing forever. That cost two rounds of manual testing.
const VEIL_WINDOW: &str = "region";

enum Message {
    Chord(ChordSignal),
    /// Abandon any in-flight selection. Carries the reason code the caption
    /// shows. Sent from sign-out, voice start, and Escape.
    Cancel(&'static str),
    /// The veil window has decoded the frozen still for this generation.
    VeilReady(u64),
    Shutdown,
}

/// Set once at startup and read from the keyboard hook, exactly like
/// dictation's. A `OnceLock` read is one relaxed load with no lock.
static CHORD_TX: OnceLock<Sender<Message>> = OnceLock::new();
/// Read by the hook's Escape branch so the common case costs one atomic load
/// and no channel traffic.
static SELECTING: AtomicBool = AtomicBool::new(false);
/// Bumped on every entry to SELECTING and on every cancel. A capture that
/// completes carrying a stale generation is dropped, which is what makes a
/// second hold started before the first resolves safe.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static WORKER_LOST: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SelectionStarted {
    generation: u64,
    display_x: i32,
    display_y: i32,
    display_width: u32,
    display_height: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SelectionPoints {
    generation: u64,
    /// Flat [x, y, x, y, ...] in the same space the display rect above uses.
    points: Vec<i32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CaptureReady {
    generation: u64,
    width_px: u32,
    height_px: u32,
    /// True when the stroke covered most of the screen and the whole display
    /// was sent instead of a crop. The frontend says so in the user bubble.
    whole_display: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Cancelled {
    generation: u64,
    reason: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FreezeReady {
    generation: u64,
    width_px: u32,
    height_px: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SelectionLocked {
    generation: u64,
    /// The padded crop, in the same space as SelectionStarted's display rect.
    crop_x: i32,
    crop_y: i32,
    crop_width: u32,
    crop_height: u32,
    whole_display: bool,
}

/// What Settings > System shows beside the fixed chord.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegionStatus {
    available: bool,
    /// Rendered verbatim; nothing in the frontend may hardcode the chord.
    chord_label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// Set when `reason` is an OS grant the UI could act on.
    #[serde(skip_serializing_if = "Option::is_none")]
    blocker: Option<&'static str>,
}

#[cfg(target_os = "macos")]
const INPUT_MONITORING_REASON: &str =
    "Aura needs Input Monitoring to hear these keys. Allow it under Privacy & Security > Input Monitoring, then restart Aura.";
#[cfg(target_os = "macos")]
const RELAUNCH_REASON: &str =
    "Input Monitoring is allowed. Restart Aura so it can start listening for these keys.";

/// Read only, never prompts: this runs every time the System page renders.
/// Both chords share one keyboard listener, so its health is this gesture's
/// health too; dictation consent has nothing to do with it.
#[tauri::command]
pub fn region_status(app: AppHandle) -> RegionStatus {
    use tauri::Manager as _;

    let unavailable = |reason: String, blocker: Option<&'static str>| RegionStatus {
        available: false,
        chord_label: REGION_CHORD.label(),
        reason: Some(reason),
        blocker,
    };
    #[cfg(target_os = "macos")]
    {
        if !crate::voice_toggle_key::input_monitoring_granted() {
            return unavailable(INPUT_MONITORING_REASON.to_string(), Some("inputMonitoring"));
        }
        let listener_down = app
            .try_state::<crate::voice_toggle_key::VoiceToggleKeyHandle>()
            .is_some_and(|listener| !listener.status().available);
        if listener_down {
            return unavailable(RELAUNCH_REASON.to_string(), Some("relaunch"));
        }
    }
    if CHORD_TX.get().is_none() || WORKER_LOST.load(Ordering::SeqCst) {
        return unavailable("Circle to ask did not start. Restart Aura.".to_string(), None);
    }
    if let Some(listener) = app.try_state::<crate::voice_toggle_key::VoiceToggleKeyHandle>() {
        let listener_status = listener.status();
        if !listener_status.available {
            let detail = listener_status
                .reason
                .filter(|detail| !detail.trim().is_empty())
                .map(|detail| format!(" (Details: {})", detail.trim()))
                .unwrap_or_default();
            return unavailable(format!("Keyboard listener unavailable. Restart Aura.{detail}"), None);
        }
    }
    if let Err(reason) = crate::screenshot::screen_capture_permitted() {
        let human = reason.strip_prefix("permission_denied: ").unwrap_or(&reason).to_string();
        return unavailable(human, Some("screenRecording"));
    }
    RegionStatus { available: true, chord_label: REGION_CHORD.label(), reason: None, blocker: None }
}

/// The veil window's answer to `region-freeze-ready`. A send on the worker's
/// channel and nothing else; a stale generation is ignored by the worker.
#[tauri::command]
pub fn region_veil_ready(generation: u64) {
    if let Some(tx) = CHORD_TX.get() {
        let _ = tx.send(Message::VeilReady(generation));
    }
}

/// Called from the low-level keyboard hook. Must stay allocation-light and
/// never block: a send on an unbounded channel is the whole body.
pub fn signal(chord_signal: ChordSignal) {
    let Some(tx) = CHORD_TX.get() else {
        return;
    };
    if tx.send(Message::Chord(chord_signal)).is_err() && !WORKER_LOST.swap(true, Ordering::SeqCst) {
        // Once only: the hook fires this on every press, and a dead worker
        // would otherwise fill the whole readable log tail.
        error!("region: worker thread is gone, the gesture is dead until restart");
    }
}

/// True while a stroke is being recorded. Read by the hook's Escape branch.
pub fn is_selecting() -> bool {
    SELECTING.load(Ordering::Relaxed)
}

/// Abandons any in-flight selection and invalidates any capture still in
/// flight. Safe to call when nothing is selecting.
///
/// Called from `security::session_changed` on every revoke, so one account's
/// half-finished gesture can never resolve into the next account's session, and
/// from `note_voice_active` when a call starts.
pub fn cancel(reason: &'static str) {
    // Bump here as well as in the worker: a capture already running between
    // threads must be invalidated even if the worker is busy and has not yet
    // drained this message.
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(tx) = CHORD_TX.get() {
        let _ = tx.send(Message::Cancel(reason));
    }
}

pub struct RegionHandle {
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Drop for RegionHandle {
    fn drop(&mut self) {
        if let Some(tx) = CHORD_TX.get() {
            let _ = tx.send(Message::Shutdown);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn start(app: AppHandle) -> RegionHandle {
    // Built hidden, now, rather than on the first gesture. Two reasons, and the
    // first one is a real bug rather than an optimization:
    //
    //   - `region-selection-started` fires on ARM, but the veil is only shown
    //     once the cursor has moved. If the window were created at that later
    //     point it would miss the started event entirely, so its React root
    //     would never learn the display rect and the FIRST gesture of every
    //     session would draw nothing while later ones worked.
    //   - creating a window loads the whole webview bundle, which is not work
    //     to do in the middle of a gesture.
    //
    // `setup` runs on the main thread, which is where Tauri builds windows, so
    // this needs no run_on_main_thread hop.
    if let Err(e) = crate::window_util::build_accessory_window(
        &app,
        VEIL_WINDOW,
        "Aura Region Select",
        tauri::LogicalSize::new(320.0, 200.0),
        true,
    ) {
        warn!("region: could not pre-build the trail window ({e})");
    }

    let (tx, rx) = channel::<Message>();
    if CHORD_TX.set(tx).is_err() {
        warn!("region: worker already started");
    }
    let worker = std::thread::Builder::new()
        .name("aura-region".to_string())
        .spawn(move || run(app, rx))
        .ok();
    if worker.is_none() {
        error!("region: could not spawn the worker thread, the gesture is unavailable");
    }
    RegionHandle { worker }
}

/// What the worker is doing. `Idle` holds nothing at all, which is the point:
/// an unauthorized hold leaves no cursor history anywhere.
enum State {
    Idle,
    Selecting {
        generation: u64,
        ticket: crate::security::Ticket,
        points: std::collections::VecDeque<(i32, i32)>,
        started: Instant,
        display: DisplayRect,
        /// Points gathered since the last batch emit.
        unsent: Vec<i32>,
        samples: usize,
        /// The display as it was when the hold became a stroke. NotStarted
        /// until then, so a stray Win+Alt+<digit> never captures anything.
        freeze: Freeze,
        veil: Veil,
    },
}

enum Freeze {
    NotStarted,
    /// Capturing and encoding on its own thread. The worker keeps sampling
    /// the cursor meanwhile: doing this inline once cost a debug build 3.8s of
    /// lost samples, and a real stroke was rejected as 3 points.
    Pending { rx: Receiver<FreezeResult>, started: Instant },
    /// Boxed so the state enum does not carry the size of a monitor handle.
    Done(Box<FrozenDisplay>),
}

enum Veil {
    Hidden,
    /// Frozen and announced; waiting for the window to decode the still.
    AwaitingStill { since: Instant },
    /// Written only AFTER `show_veil` returns Ok, never before. A failed show
    /// must not leave this believing the window is up, or the hide on release
    /// would be skipped and a fullscreen still would sit over the desktop.
    /// Same rule as `OverlayState.applied` in overlay.rs.
    Shown,
}

#[derive(Clone, Copy)]
struct DisplayRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// The state machine and the sampler share one loop rather than running as two
/// threads. That removes the shared buffer and every lock around it, and makes
/// a release wake the loop immediately instead of after the next tick.
fn run(app: AppHandle, rx: std::sync::mpsc::Receiver<Message>) {
    let mut state = State::Idle;
    loop {
        match rx.recv_timeout(SAMPLE_INTERVAL) {
            Ok(Message::Chord(ChordSignal::Arm)) => {
                info!("region: chord armed ({})", REGION_CHORD.label());
                on_arm(&app, &mut state)
            }
            Ok(Message::Chord(ChordSignal::Release)) => {
                info!("region: chord released");
                on_release(&app, &mut state)
            }
            Ok(Message::Chord(ChordSignal::Cancel | ChordSignal::CancelPending)) => {
                abandon(&app, &mut state, "cancelled")
            }
            // Deliberately nothing. See the module docs: the shared Win key
            // means a bare Win press prewarms this chord too.
            Ok(Message::Chord(ChordSignal::Prewarm)) => {}
            Ok(Message::Cancel(reason)) => abandon(&app, &mut state, reason),
            Ok(Message::VeilReady(generation)) => on_veil_ready(&app, &mut state, generation),
            Ok(Message::Shutdown) => break,
            Err(RecvTimeoutError::Timeout) => tick(&app, &mut state),
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn on_arm(app: &AppHandle, state: &mut State) {
    // A live call keeps its own screen context and its own voice. The gesture
    // is a captioned no-op there rather than a denial, which is why this is
    // checked here and not in security.rs.
    if crate::overlay::is_voice_active(app) {
        info!("region: hold ignored, a voice call is live");
        emit_cancelled(app, GENERATION.load(Ordering::SeqCst), "voice_active");
        return;
    }
    let ticket = match crate::security::authorize(app, Operation::CaptureRegion) {
        Ok(ticket) => ticket,
        Err(reason) => {
            info!("region: hold refused ({reason})");
            emit_cancelled(app, GENERATION.load(Ordering::SeqCst), "not_authorized");
            return;
        }
    };

    let Some(point) = cursor_point() else {
        emit_cancelled(app, GENERATION.load(Ordering::SeqCst), "no_cursor");
        return;
    };
    let Some(display) = display_at(point) else {
        emit_cancelled(app, GENERATION.load(Ordering::SeqCst), "no_display");
        return;
    };

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    SELECTING.store(true, Ordering::Relaxed);

    let mut points = std::collections::VecDeque::with_capacity(MAX_POINTS);
    points.push_back(point);
    *state = State::Selecting {
        generation,
        ticket,
        points,
        started: Instant::now(),
        display,
        unsent: vec![point.0, point.1],
        samples: 0,
        freeze: Freeze::NotStarted,
        veil: Veil::Hidden,
    };

    info!(
        "region: selecting gen={generation} on display {}x{} at ({}, {})",
        display.width, display.height, display.x, display.y
    );
    let _ = app.emit(
        crate::events::REGION_SELECTION_STARTED,
        SelectionStarted {
            generation,
            display_x: display.x,
            display_y: display.y,
            display_width: display.width,
            display_height: display.height,
        },
    );
}

fn on_veil_ready(app: &AppHandle, state: &mut State, ready_generation: u64) {
    let State::Selecting { generation, display, veil, .. } = state else {
        return;
    };
    if *generation == ready_generation && matches!(veil, Veil::AwaitingStill { .. }) {
        reveal_veil(app, *display, veil);
    }
}

fn reveal_veil(app: &AppHandle, display: DisplayRect, veil: &mut Veil) {
    match show_veil(app, display) {
        // Set AFTER the show succeeded, never before.
        Ok(()) => {
            *veil = Veil::Shown;
            info!("region: veil shown");
        }
        Err(e) => {
            // Not retried: a still over the desktop that cannot be hidden
            // reliably is worse than a gesture with no visual.
            *veil = Veil::Hidden;
            warn!("region: could not show the veil ({e})");
        }
    }
}

/// Runs the capture and the still's encode off the worker, so sampling never
/// pauses. If the spawn fails the sender is dropped with the closure, and the
/// next tick reads that as a failed freeze.
fn start_freeze(origin: (i32, i32)) -> Freeze {
    let (tx, rx) = channel::<FreezeResult>();
    if let Err(e) = std::thread::Builder::new()
        .name("aura-region-freeze".to_string())
        .spawn(move || {
            // A send error only means the gesture already ended; the frame is
            // dropped here with nothing stored anywhere.
            let _ = tx.send(crate::screenshot::freeze_display_blocking(origin));
        })
    {
        error!("region: could not spawn the freeze thread ({e})");
    }
    Freeze::Pending { rx, started: Instant::now() }
}

fn tick(app: &AppHandle, state: &mut State) {
    let State::Selecting {
        generation,
        points,
        started,
        unsent,
        samples,
        display,
        freeze,
        veil,
        ..
    } = state
    else {
        return;
    };
    if started.elapsed() > MAX_HOLD {
        abandon(app, state, "held_too_long");
        return;
    }
    // Collect a freeze that finished since the last tick. Checked before the
    // cursor read, which returns early whenever the cursor is still.
    let finished_freeze = match freeze {
        Freeze::Pending { rx, started: freeze_started } => match rx.try_recv() {
            Ok(result) => Some((result, freeze_started.elapsed())),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some((
                Err("the freeze thread exited without a result".to_string()),
                freeze_started.elapsed(),
            )),
        },
        _ => None,
    };
    if let Some((result, elapsed)) = finished_freeze {
        match result {
            Ok((still_display, still_jpeg)) => {
                let (width_px, height_px) = still_display.dimensions();
                info!(
                    "region: frozen {width_px}x{height_px} in {}ms, still {} KB",
                    elapsed.as_millis(),
                    still_jpeg.len() / 1024
                );
                crate::screenshot::store_region_freeze(app, *generation, width_px, height_px, still_jpeg);
                *freeze = Freeze::Done(Box::new(still_display));
                *veil = Veil::AwaitingStill { since: Instant::now() };
                let _ = app.emit(
                    crate::events::REGION_FREEZE_READY,
                    FreezeReady { generation: *generation, width_px, height_px },
                );
            }
            Err(e) => {
                warn!("region: could not freeze the display ({e})");
                abandon(app, state, "capture_failed");
                return;
            }
        }
    }
    if let Veil::AwaitingStill { since } = veil {
        if since.elapsed() >= VEIL_READY_TIMEOUT {
            warn!("region: still not decoded after {VEIL_READY_TIMEOUT:?}, showing the veil anyway");
            reveal_veil(app, *display, veil);
        }
    }
    let Some(point) = cursor_point() else {
        return;
    };
    // A stationary cursor produces the same point forever; storing it would
    // burn the ring for nothing and skew nothing else.
    if points.back() == Some(&point) {
        return;
    }
    if points.len() == MAX_POINTS {
        points.pop_front();
    }
    // Freeze only once this is unmistakably a stroke and not a stray modifier
    // combo. Measured from where the stroke began, not from the last sample,
    // so slow deliberate movement still crosses the threshold.
    if matches!(freeze, Freeze::NotStarted) {
        let origin = points.front().copied().unwrap_or(point);
        if (point.0 - origin.0).abs() >= VEIL_REVEAL_PX
            || (point.1 - origin.1).abs() >= VEIL_REVEAL_PX
        {
            // The veil is not up yet, so this photographs the real desktop.
            // The origin, not the current point: the stroke may already be
            // drifting toward another display.
            *freeze = start_freeze(origin);
        }
    }

    points.push_back(point);
    unsent.push(point.0);
    unsent.push(point.1);
    *samples += 1;
    if *samples % POINTS_PER_BATCH == 0 && !unsent.is_empty() {
        let _ = app.emit(
            crate::events::REGION_SELECTION_POINTS,
            SelectionPoints { generation: *generation, points: std::mem::take(unsent) },
        );
    }
}

fn on_release(app: &AppHandle, state: &mut State) {
    let State::Selecting { generation, ticket, points, display, freeze, veil, .. } =
        std::mem::replace(state, State::Idle)
    else {
        return;
    };
    SELECTING.store(false, Ordering::Relaxed);
    let veil_shown = matches!(veil, Veil::Shown);

    if points.len() < MIN_POINTS {
        info!("region: rejected, only {} points (need {MIN_POINTS})", points.len());
        reject(app, generation, veil_shown, "too_small");
        return;
    }
    let Some(bbox) = bounding_box(&points) else {
        reject(app, generation, veil_shown, "too_small");
        return;
    };
    if bbox.width < MIN_REGION_PX || bbox.height < MIN_REGION_PX {
        info!(
            "region: rejected, box {}x{} is under {MIN_REGION_PX}px",
            bbox.width, bbox.height
        );
        reject(app, generation, veil_shown, "too_small");
        return;
    }
    // A quick flick can release while the freeze is still running. Wait for
    // it rather than reject a stroke that was sampled fine. Any box this big
    // crossed the reveal threshold, so NotStarted means nothing to crop from.
    let frozen = match freeze {
        Freeze::Done(frozen) => frozen,
        Freeze::Pending { rx, .. } => match rx.recv_timeout(FREEZE_WAIT) {
            Ok(Ok((still_display, _still_jpeg))) => Box::new(still_display),
            Ok(Err(e)) => {
                warn!("region: could not freeze the display ({e})");
                reject(app, generation, veil_shown, "capture_failed");
                return;
            }
            Err(e) => {
                warn!("region: freeze did not finish ({e})");
                reject(app, generation, veil_shown, "capture_failed");
                return;
            }
        },
        Freeze::NotStarted => {
            reject(app, generation, veil_shown, "capture_failed");
            return;
        }
    };

    let display_area = f64::from(display.width) * f64::from(display.height);
    let bbox_area = f64::from(bbox.width) * f64::from(bbox.height);
    let whole_display = display_area > 0.0 && bbox_area / display_area > MAX_REGION_FRAC;
    let crop = if whole_display { None } else { Some(pad_and_clamp(bbox, display)) };

    let lock_started = Instant::now();
    if veil_shown {
        let shown = crop.unwrap_or(CropRect {
            x: display.x,
            y: display.y,
            width: display.width,
            height: display.height,
        });
        let _ = app.emit(
            crate::events::REGION_SELECTION_LOCKED,
            SelectionLocked {
                generation,
                crop_x: shown.x,
                crop_y: shown.y,
                crop_width: shown.width,
                crop_height: shown.height,
                whole_display,
            },
        );
    }

    // Cut from the still the user was looking at, not a second capture: the
    // screen may have changed under the veil, and the veil itself is on it.
    let frame = crate::screenshot::crop_frozen_display(*frozen, crop);

    // The lock-in plays while the crop encodes; only the remainder is waited.
    if veil_shown {
        if let Some(rest) = LOCK_IN.checked_sub(lock_started.elapsed()) {
            std::thread::sleep(rest);
        }
        hide_veil(app);
    }
    crate::screenshot::clear_region_freeze(app);

    let frame = match frame {
        Ok(frame) => frame,
        Err(e) => {
            warn!("region: crop failed ({e})");
            emit_cancelled(app, generation, "capture_failed");
            return;
        }
    };

    // Two independent staleness checks. The generation catches a second hold or
    // a cancel that landed while the capture ran; the recheck catches a
    // sign-out or account switch that straddled it, the same way every other
    // capture path in screenshot.rs does.
    if GENERATION.load(Ordering::SeqCst) != generation {
        info!("region: dropped a frame from a superseded gesture");
        return;
    }
    if let Err(e) = crate::security::recheck(app, Operation::CaptureRegion, &ticket) {
        info!("region: frame dropped after capture ({e})");
        return;
    }

    // The happy-path line. Dimensions, counts and byte sizes only, never pixel
    // content - and it is the only way to catch a crop that landed on the wrong
    // part of the screen, which fails by looking perfectly plausible.
    info!(
        "[Region] {{gen:{generation}, points:{}, bbox:{}x{}@({},{}), crop:{}, \
         whole_display:{whole_display}, jpeg:{}x{}}}",
        points.len(),
        bbox.width,
        bbox.height,
        bbox.x,
        bbox.y,
        crop.map(|c| format!("{}x{}@({},{})", c.width, c.height, c.x, c.y))
            .unwrap_or_else(|| "none".to_string()),
        frame.jpeg_width_px(),
        frame.jpeg_height_px(),
    );
    crate::screenshot::store_region_capture(app, &frame);
    let _ = app.emit(
        crate::events::REGION_CAPTURE_READY,
        CaptureReady {
            generation,
            width_px: frame.jpeg_width_px(),
            height_px: frame.jpeg_height_px(),
            whole_display,
        },
    );
}

/// A release that produced nothing usable. Hides the veil if it was up and
/// drops the parked still, which the window may never have collected.
fn reject(app: &AppHandle, generation: u64, veil_shown: bool, reason: &'static str) {
    if veil_shown {
        hide_veil(app);
    }
    crate::screenshot::clear_region_freeze(app);
    emit_cancelled(app, generation, reason);
}

fn abandon(app: &AppHandle, state: &mut State, reason: &'static str) {
    let generation = match std::mem::replace(state, State::Idle) {
        State::Selecting { generation, veil, .. } => {
            if matches!(veil, Veil::Shown) {
                hide_veil(app);
            }
            generation
        }
        State::Idle => {
            // Still clear any parked frame: a cancel that arrives after a
            // capture resolved (sign-out, a call starting) must not leave a
            // crop of the previous screen collectable.
            crate::screenshot::clear_region_capture(app);
            crate::screenshot::clear_region_freeze(app);
            return;
        }
    };
    SELECTING.store(false, Ordering::Relaxed);
    GENERATION.fetch_add(1, Ordering::SeqCst);
    crate::screenshot::clear_region_capture(app);
    crate::screenshot::clear_region_freeze(app);
    emit_cancelled(app, generation, reason);
}

fn emit_cancelled(app: &AppHandle, generation: u64, reason: &'static str) {
    let _ = app.emit(crate::events::REGION_CANCELLED, Cancelled { generation, reason });
}

#[derive(Clone, Copy)]
struct BoundingBox {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn bounding_box(points: &std::collections::VecDeque<(i32, i32)>) -> Option<BoundingBox> {
    let (first_x, first_y) = *points.front()?;
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (first_x, first_x, first_y, first_y);
    for (x, y) in points.iter() {
        min_x = min_x.min(*x);
        max_x = max_x.max(*x);
        min_y = min_y.min(*y);
        max_y = max_y.max(*y);
    }
    Some(BoundingBox {
        x: min_x,
        y: min_y,
        width: (max_x - min_x).max(0) as u32,
        height: (max_y - min_y).max(0) as u32,
    })
}

/// Grows the box so the thing the user drew around is inside it rather than on
/// its edge, then clamps back onto the display.
fn pad_and_clamp(bbox: BoundingBox, display: DisplayRect) -> CropRect {
    let pad_x = ((f64::from(bbox.width) * REGION_PAD_FRAC).round() as i32).max(REGION_PAD_MIN_PX);
    let pad_y = ((f64::from(bbox.height) * REGION_PAD_FRAC).round() as i32).max(REGION_PAD_MIN_PX);

    let left = (bbox.x - pad_x).max(display.x);
    let top = (bbox.y - pad_y).max(display.y);
    let right = (bbox.x + bbox.width as i32 + pad_x).min(display.x + display.width as i32);
    let bottom = (bbox.y + bbox.height as i32 + pad_y).min(display.y + display.height as i32);

    CropRect {
        x: left,
        y: top,
        width: (right - left).max(1) as u32,
        height: (bottom - top).max(1) as u32,
    }
}

fn display_at(point: (i32, i32)) -> Option<DisplayRect> {
    let monitor = xcap::Monitor::from_point(point.0, point.1).ok()?;
    Some(DisplayRect {
        x: monitor.x().ok()?,
        y: monitor.y().ok()?,
        width: monitor.width().ok()?,
        height: monitor.height().ok()?,
    })
}

/// Builds (if needed), sizes and shows the veil over `display`.
///
/// Windows are built and moved on the main thread, and this runs on the region
/// worker, so everything goes through `run_on_main_thread`. The result is waited
/// on rather than fired and forgotten: the veil must actually be up before the
/// first stroke points arrive, or the overlay draws nothing for the first frames.
fn show_veil(app: &AppHandle, display: DisplayRect) -> Result<(), String> {
    let (tx, rx) = channel::<Result<(), String>>();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(build_and_show_veil(&handle, display));
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|e| format!("veil show timed out: {e}"))?
}

fn build_and_show_veil(app: &AppHandle, display: DisplayRect) -> Result<(), String> {
    let window = crate::window_util::build_accessory_window(
        app,
        VEIL_WINDOW,
        "Aura Region Select",
        // Placeholder; the real geometry is applied below, in whichever space
        // the platform reports display bounds in.
        tauri::LogicalSize::new(320.0, 200.0),
        true,
    )?;

    // xcap reports monitor bounds in the platform's own space: physical pixels
    // on Windows, points on macOS. Using the matching Tauri type on each side
    // means no scale factor is applied twice, which is the same split the crop
    // math and the geometry header already live with.
    #[cfg(windows)]
    {
        window
            .set_position(tauri::PhysicalPosition::new(display.x, display.y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::PhysicalSize::new(display.width, display.height))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        window
            .set_position(tauri::LogicalPosition::new(
                f64::from(display.x),
                f64::from(display.y),
            ))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(
                f64::from(display.width),
                f64::from(display.height),
            ))
            .map_err(|e| e.to_string())?;
    }

    window.show().map_err(|e| e.to_string())?;
    // Re-asserted after every show: another always-on-top window that appeared
    // since the last gesture would otherwise sit above the veil.
    let _ = window.set_always_on_top(true);
    Ok(())
}

/// Hides the veil and BLOCKS until it is actually hidden.
///
/// The crop no longer depends on this (it is cut from the frozen still), but
/// the capture-ready event does: the preview chip must not appear while a
/// fullscreen still of the old screen is still covering the desktop.
fn hide_veil(app: &AppHandle) {
    let (tx, rx) = channel::<()>();
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            use tauri::Manager as _;
            if let Some(window) = handle.get_webview_window(VEIL_WINDOW) {
                let _ = window.hide();
            }
            let _ = tx.send(());
        })
        .is_ok()
    {
        let _ = rx.recv_timeout(Duration::from_secs(2));
    }
}

/// The cursor, in the same space `screenshot::crop_to_rect` expects: physical
/// pixels on Windows, points on macOS.
#[cfg(windows)]
fn cursor_point() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    // Read Win32 directly rather than through tao: this runs on the region
    // worker thread, and `WebviewWindow::cursor_position` is not a call to make
    // off the thread that owns the window.
    unsafe { GetCursorPos(&mut point).ok()? };
    Some((point.x, point.y))
}

/// CoreGraphics' own global space: top-left origin, points, every display. The
/// same reason `screenshot::cursor_point` reads it rather than going through
/// tao, which double-applies the primary display's backing scale.
#[cfg(target_os = "macos")]
fn cursor_point() -> Option<(i32, i32)> {
    use objc2_core_graphics::CGEvent;

    let event = CGEvent::new(None)?;
    let point = CGEvent::location(Some(&event));
    Some((point.x as i32, point.y as i32))
}
