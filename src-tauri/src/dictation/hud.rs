//! The dictation HUD: a thin pill docked to the same screen edge as the voice
//! bar, enlarging while the chord is held.
//!
//! This is its OWN window (label "dictation"), not an overlay.rs presentation,
//! for two reasons. Any path into the overlay can reach
//! `win_focus::force_foreground`, which both steals focus (killing insertion,
//! whose whole contract is that the target window keeps it) and taps Alt,
//! dropping the target into keyboard menu mode. And
//! `OverlayPresentation::Bar` is already in use whenever a voice session is
//! live, so the two surfaces would fight over `applied_presentation`. Dictation
//! also has to work signed out, which the overlay's React root does not.
//!
//! It reuses overlay.rs's edge anchoring. The user docked their notch somewhere
//! on purpose; dictation appears there too.
//!
//! main.tsx routes on the window label, and "dictation" is listed in
//! capabilities/default.json's `windows` array. Without that entry the label
//! gets ZERO permissions, including core:default, so it could not even listen
//! for its own events.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

use crate::overlay::{self, NotchEdge, OverlayPresentation};

pub const DICTATION_WINDOW: &str = "dictation";

/// The resting pill stays visible between holds and expands only while
/// dictation is active.
const RESTING_WIDTH: f64 = 8.0;
const RESTING_HEIGHT: f64 = 40.0;
const ACTIVE_WIDTH: f64 = 12.0;
const ACTIVE_HEIGHT: f64 = 65.0;
const HOVER_SIDE_WIDTH: f64 = 196.0;
const HOVER_SIDE_HEIGHT: f64 = 46.0;
const HOVER_TOP_WIDTH: f64 = 164.0;
const HOVER_TOP_HEIGHT: f64 = 63.0;

/// The message pill. The active pill is wordless by design, but a blocked or
/// misdirected insert has to say so somewhere, and this window is the only
/// surface dictation owns. Used ONLY for `Error` and `Pending`, so the normal
/// path never grows past the pill. `Pending` is taller because it carries the
/// held transcript as well as the explanation.
const MESSAGE_WIDTH: f64 = 340.0;
const MESSAGE_HEIGHT: f64 = 44.0;
const PENDING_HEIGHT: f64 = 78.0;

/// The window the current hold is typing into, remembered so a later phase
/// change can re-place the HUD on the right display without the worker having
/// to thread the target through every publish.
static LAST_TARGET: AtomicIsize = AtomicIsize::new(0);
static IDLE_HOVERED: AtomicBool = AtomicBool::new(false);

/// True while the Buddy agent overlay is visible. The overlay and this HUD are
/// separate always-on-top windows that can otherwise both draw on screen at
/// once and collide. `overlay::apply_result` is the sole place any overlay
/// presentation change actually reaches the real window, and it is the sole
/// caller of `set_overlay_suppressed` - that single choke point is what makes
/// "at most one of the two is visible" a guarantee rather than two toggles
/// that merely happen to be called together.
static SUPPRESSED_BY_OVERLAY: AtomicBool = AtomicBool::new(false);

/// What the HUD is currently telling the user. Every caption is derived from
/// one of these; the chord itself is always rendered from
/// `DICTATION_CHORD.label()`, never a hardcoded string.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HudPhase {
    Idle,
    Listening,
    Transcribing,
    Inserted,
    Error,
    /// Decoded, but no text box had focus, so the words are being held until
    /// one does. The only phase that shows the transcript on screen, and it
    /// earns that: the user has to know something is waiting, and what.
    Pending,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HudUpdate {
    pub phase: HudPhase,
    /// The streaming partial, or the final text. Never logged anywhere.
    pub text: String,
    /// A short explanation shown under the text for a failure or a hold.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub chord_label: &'static str,
    /// Which edge the notch is docked to, so React renders the matching
    /// orientation. Stamped by `publish` from live overlay state rather than at
    /// construction, so no call site has to know about it.
    pub edge: &'static str,
}

/// The last update published, so a webview that was created moments ago can ask
/// for the current state instead of racing the first event. Without this the
/// HUD renders blank on the very first dictation, because the window is built
/// on arm and its listener is not registered yet when the first caption fires.
static LAST_UPDATE: Mutex<Option<HudUpdate>> = Mutex::new(None);

/// Backs the `dictation_hud_state` command.
pub fn last_update() -> HudUpdate {
    LAST_UPDATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| HudUpdate::new(HudPhase::Idle))
}

impl HudUpdate {
    pub fn new(phase: HudPhase) -> Self {
        Self {
            phase,
            text: String::new(),
            message: None,
            chord_label: super::chord::DICTATION_CHORD.label(),
            edge: NotchEdge::default().as_stored(),
        }
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = text.into();
        self
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

/// Creates the HUD window if it does not exist yet. Runs on the main thread
/// because that is where Tauri builds windows on Windows; callers on the
/// dictation worker thread go through `AppHandle::run_on_main_thread`.
fn build_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(DICTATION_WINDOW).is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        DICTATION_WINDOW,
        WebviewUrl::App("index.html".into()),
    )
    .title("Aura Dictation")
    .inner_size(RESTING_WIDTH, RESTING_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    // The resting surface receives hover so Windows can show its native hint.
    // WS_EX_NOACTIVATE below keeps it from taking focus, and the surface has no
    // click action. Active dictation switches back to click-through.
    let _ = window.set_ignore_cursor_events(false);
    // Same display-affinity treatment the overlay gets: partial transcript text
    // should not land in a screen share or a screenshot.
    let _ = crate::overlay::exclude_main_window_from_capture(&window);
    apply_no_activate(&window);
    Ok(())
}

/// WS_EX_NOACTIVATE on top of Tauri's `focused(false)`: the builder flag only
/// covers the first show, the style covers every later one. Without it the HUD
/// would steal focus from the target window and insertion would abort on its
/// own focus check.
#[cfg(windows)]
fn apply_no_activate(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            current | WS_EX_NOACTIVATE.0 as isize,
        );
    }
}

#[cfg(not(windows))]
fn apply_no_activate(_window: &tauri::WebviewWindow) {}

/// Centre of a window in PHYSICAL screen pixels, which is what
/// `monitor_from_point` expects. Used to put the HUD on the display the user is
/// actually typing into rather than always on the primary one.
#[cfg(windows)]
fn target_center(target: isize) -> Option<(f64, f64)> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    if target == 0 {
        return None;
    }
    let mut rect = RECT::default();
    unsafe {
        let hwnd = HWND(target as *mut core::ffi::c_void);
        GetWindowRect(hwnd, &mut rect).ok()?;
    }
    Some((
        (rect.left + rect.right) as f64 / 2.0,
        (rect.top + rect.bottom) as f64 / 2.0,
    ))
}

#[cfg(not(windows))]
fn target_center(_target: isize) -> Option<(f64, f64)> {
    None
}

fn resting_size(_edge: NotchEdge) -> LogicalSize<f64> {
    LogicalSize::new(RESTING_WIDTH, RESTING_HEIGHT)
}

/// The HUD's footprint for one phase. Idle is the compact persistent pill;
/// active phases enlarge it while keeping the same vertical silhouette.
fn surface_size(edge: NotchEdge, phase: HudPhase) -> LogicalSize<f64> {
    match phase {
        HudPhase::Idle if IDLE_HOVERED.load(Ordering::Relaxed) => match edge {
            NotchEdge::Top | NotchEdge::Bottom => {
                LogicalSize::new(HOVER_TOP_WIDTH, HOVER_TOP_HEIGHT)
            }
            NotchEdge::Left | NotchEdge::Right => {
                LogicalSize::new(HOVER_SIDE_WIDTH, HOVER_SIDE_HEIGHT)
            }
        },
        HudPhase::Idle => resting_size(edge),
        HudPhase::Error => LogicalSize::new(MESSAGE_WIDTH, MESSAGE_HEIGHT),
        HudPhase::Pending => LogicalSize::new(MESSAGE_WIDTH, PENDING_HEIGHT),
        _ => LogicalSize::new(ACTIVE_WIDTH, ACTIVE_HEIGHT),
    }
}

/// True when the voice bar is currently docked to this same edge ON THIS SAME
/// display. Both surfaces are always-on-top and both anchor flush to the edge,
/// so without this they would draw on the same pixels the moment someone
/// dictates into a chat box during a live call.
fn voice_notch_shares_display(
    app: &AppHandle,
    full_pos: LogicalPosition<f64>,
    full_size: LogicalSize<f64>,
    scale: f64,
) -> bool {
    if !matches!(overlay::snapshot(app).presentation, OverlayPresentation::Bar) {
        return false;
    }
    let Some(main) = overlay::main_window(app) else {
        return false;
    };
    let Ok(position) = main.outer_position() else {
        return false;
    };
    // Coarse containment on purpose: converting the main window's physical
    // origin with the TARGET display's scale is only approximate under mixed
    // DPI, and all this decides is whether to step out of the way.
    let origin = position.to_logical::<f64>(scale);
    origin.x >= full_pos.x
        && origin.x < full_pos.x + full_size.width
        && origin.y >= full_pos.y
        && origin.y < full_pos.y + full_size.height
}

/// Sizes and anchors the HUD for the current edge and phase. Called on every
/// show and on every transition into the failure pill, and it caches NOTHING:
/// the user can re-dock the notch between two holds, and an "already applied"
/// cache that outlives one failed resize is exactly the desync that froze the
/// sibling app's overlay (see CLAUDE.md).
fn place_window(app: &AppHandle, window: &tauri::WebviewWindow, target: isize, phase: HudPhase) {
    let edge = overlay::snapshot(app).notch_edge;
    let size = surface_size(edge, phase);
    let monitor = target_center(target)
        .and_then(|(x, y)| window.monitor_from_point(x, y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let full_size = monitor.size().to_logical::<f64>(scale);
    let full_pos = monitor.position().to_logical::<f64>(scale);
    let (work_pos, work_size) = overlay::work_area_within(full_pos, full_size, scale);
    let mut position = overlay::bar_position(edge, work_pos, work_size, size);

    if voice_notch_shares_display(app, full_pos, full_size, scale) {
        let inset = overlay::NOTCH_CROSS + overlay::NOTCH_GAP;
        match edge {
            NotchEdge::Top => position.y += inset,
            NotchEdge::Bottom => position.y -= inset,
            NotchEdge::Left => position.x += inset,
            NotchEdge::Right => position.x -= inset,
        }
    }

    let _ = window.set_size(size);
    let _ = window.set_position(position);
}

/// Builds the window if needed, positions it on the monitor that owns `target`,
/// and shows it. Called on arm, never on prewarm: a user who never dictates
/// never pays for a second webview, and ordinary Ctrl or Win presses do not
/// silently create one.
pub fn show(app: &AppHandle, target: isize) {
    LAST_TARGET.store(target, Ordering::Relaxed);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = build_window(&handle) {
            log::error!("dictation.hud: failed to create the HUD window: {e}");
            return;
        }
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, target, HudPhase::Listening);
            let _ = window.set_ignore_cursor_events(true);
            if !SUPPRESSED_BY_OVERLAY.load(Ordering::Relaxed) {
                let _ = window.show();
            }
        }
    });
}

/// Creates and shows the passive resting pill without starting capture or
/// loading the recognizer. The keyboard hook remains the only source of Arm.
pub fn show_idle(app: &AppHandle) {
    IDLE_HOVERED.store(false, Ordering::Relaxed);
    let mut update = HudUpdate::new(HudPhase::Idle);
    update.edge = overlay::snapshot(app).notch_edge.as_stored();
    *LAST_UPDATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(update.clone());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = build_window(&handle) {
            log::error!("dictation.hud: failed to create the HUD window: {e}");
            return;
        }
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, LAST_TARGET.load(Ordering::Relaxed), HudPhase::Idle);
            let _ = window.set_ignore_cursor_events(false);
            if !SUPPRESSED_BY_OVERLAY.load(Ordering::Relaxed) {
                let _ = window.show();
            }
            let _ = window.emit("dictation-update", update);
        }
    });
}

pub fn set_hovered(app: &AppHandle, hovered: bool) {
    if last_update().phase != HudPhase::Idle {
        return;
    }
    IDLE_HOVERED.store(hovered, Ordering::Relaxed);
    let handle = app.clone();
    let target = LAST_TARGET.load(Ordering::Relaxed);
    let _ = app.run_on_main_thread(move || {
        if last_update().phase != HudPhase::Idle {
            IDLE_HOVERED.store(false, Ordering::Relaxed);
            return;
        }
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, target, HudPhase::Idle);
        }
    });
}

/// Re-applies the current geometry after the main notch changes edge or state.
pub fn refresh_placement(app: &AppHandle) {
    let handle = app.clone();
    let mut update = last_update();
    update.edge = overlay::snapshot(app).notch_edge.as_stored();
    let phase = update.phase;
    *LAST_UPDATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(update.clone());
    let target = LAST_TARGET.load(Ordering::Relaxed);
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, target, phase);
            let _ = window.set_ignore_cursor_events(phase != HudPhase::Idle);
            let _ = window.emit("dictation-update", update);
        }
    });
}

pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            let _ = window.hide();
        }
    });
}

/// Pushes one state update at the HUD. Safe to call from the worker thread.
/// The update is recorded before it is emitted, so a webview that has not
/// finished registering its listener can still pull the current state.
pub fn publish(app: &AppHandle, mut update: HudUpdate) {
    IDLE_HOVERED.store(false, Ordering::Relaxed);
    update.edge = overlay::snapshot(app).notch_edge.as_stored();
    let phase = update.phase;
    *LAST_UPDATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(update.clone());
    if let Some(window) = app.get_webview_window(DICTATION_WINDOW) {
        let _ = window.emit("dictation-update", update);
    }
    let handle = app.clone();
    let target = LAST_TARGET.load(Ordering::Relaxed);
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, target, phase);
            let _ = window.set_ignore_cursor_events(phase != HudPhase::Idle);
            if !SUPPRESSED_BY_OVERLAY.load(Ordering::Relaxed) {
                let _ = window.show();
            }
        }
    });
}

/// Called from `overlay::apply_result` on every real presentation
/// transition. Hides the pill the instant the Buddy overlay becomes visible,
/// and restores it to whatever `LAST_UPDATE` says it should be showing the
/// instant the overlay goes back to Hidden - not forced on, since dictation
/// may not be running at all. No-ops if the HUD window was never built (the
/// user never armed dictation), so summoning the overlay never creates one.
pub fn set_overlay_suppressed(app: &AppHandle, suppressed: bool) {
    SUPPRESSED_BY_OVERLAY.store(suppressed, Ordering::Relaxed);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(DICTATION_WINDOW) else {
            return;
        };
        if suppressed {
            let _ = window.hide();
            return;
        }
        let update = last_update();
        place_window(&handle, &window, LAST_TARGET.load(Ordering::Relaxed), update.phase);
        let _ = window.set_ignore_cursor_events(update.phase != HudPhase::Idle);
        let _ = window.show();
    });
}

/// Pushes one microphone level (0..1) at the HUD's waveform, roughly 20 times a
/// second and only while a hold is live.
///
/// Deliberately NOT recorded in `LAST_UPDATE`: a level is a transient reading,
/// and a webview that misses one gets the next in 50ms. Only captions need the
/// pull-on-mount path, because a caption that arrives before the listener
/// exists would otherwise leave the HUD blank.
///
/// This carries no speech, only loudness, so it is subject to the same rule as
/// everything else here: never logged, at any level.
pub fn publish_level(app: &AppHandle, level: f32) {
    if let Some(window) = app.get_webview_window(DICTATION_WINDOW) {
        let _ = window.emit("dictation-level", level);
    }
}
