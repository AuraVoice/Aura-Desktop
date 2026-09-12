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
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use log::{error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::dictation::chord::ChordSignal;
use crate::screenshot::CropRect;
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

/// Fewer points than this is a twitch, not a stroke.
const MIN_POINTS: usize = 8;
/// Below this a crop carries no more information than the cursor position.
const MIN_REGION_PX: u32 = 64;
/// Above this a crop buys nothing, so the whole display is sent instead.
const MAX_REGION_FRAC: f64 = 0.85;
/// Strokes hug the thing they circle, so the box is grown before cropping.
const REGION_PAD_FRAC: f64 = 0.15;
const REGION_PAD_MIN_PX: i32 = 12;

enum Message {
    Chord(ChordSignal),
    /// Abandon any in-flight selection. Carries the reason code the caption
    /// shows. Sent from sign-out, voice start, and Escape.
    Cancel(&'static str),
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
    },
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
            Ok(Message::Chord(ChordSignal::Arm)) => on_arm(&app, &mut state),
            Ok(Message::Chord(ChordSignal::Release)) => on_release(&app, &mut state),
            Ok(Message::Chord(ChordSignal::Cancel | ChordSignal::CancelPending)) => {
                abandon(&app, &mut state, "cancelled")
            }
            // Deliberately nothing. See the module docs: the shared Win key
            // means a bare Win press prewarms this chord too.
            Ok(Message::Chord(ChordSignal::Prewarm)) => {}
            Ok(Message::Cancel(reason)) => abandon(&app, &mut state, reason),
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
    };

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

fn tick(app: &AppHandle, state: &mut State) {
    let State::Selecting {
        generation,
        points,
        started,
        unsent,
        samples,
        ..
    } = state
    else {
        return;
    };
    if started.elapsed() > MAX_HOLD {
        abandon(app, state, "held_too_long");
        return;
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
    let State::Selecting { generation, ticket, points, display, .. } =
        std::mem::replace(state, State::Idle)
    else {
        return;
    };
    SELECTING.store(false, Ordering::Relaxed);

    if points.len() < MIN_POINTS {
        emit_cancelled(app, generation, "too_small");
        return;
    }
    let Some(bbox) = bounding_box(&points) else {
        emit_cancelled(app, generation, "too_small");
        return;
    };
    if bbox.width < MIN_REGION_PX || bbox.height < MIN_REGION_PX {
        emit_cancelled(app, generation, "too_small");
        return;
    }

    let display_area = f64::from(display.width) * f64::from(display.height);
    let bbox_area = f64::from(bbox.width) * f64::from(bbox.height);
    let whole_display = display_area > 0.0 && bbox_area / display_area > MAX_REGION_FRAC;
    let crop = if whole_display { None } else { Some(pad_and_clamp(bbox, display)) };

    // The bbox centre, not the release position: the cursor can leave the
    // display between the last sample and the key-up, and `Monitor::from_point`
    // would then resolve a different monitor than the one the stroke was on.
    let anchor = (
        bbox.x + (bbox.width / 2) as i32,
        bbox.y + (bbox.height / 2) as i32,
    );

    let frame = match crate::screenshot::capture_region_blocking(anchor, crop) {
        Ok(frame) => frame,
        Err(e) => {
            warn!("region: capture failed ({e})");
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

fn abandon(app: &AppHandle, state: &mut State, reason: &'static str) {
    let generation = match std::mem::replace(state, State::Idle) {
        State::Selecting { generation, .. } => generation,
        State::Idle => {
            // Still clear any parked frame: a cancel that arrives after a
            // capture resolved (sign-out, a call starting) must not leave a
            // crop of the previous screen collectable.
            crate::screenshot::clear_region_capture(app);
            return;
        }
    };
    SELECTING.store(false, Ordering::Relaxed);
    GENERATION.fetch_add(1, Ordering::SeqCst);
    crate::screenshot::clear_region_capture(app);
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
