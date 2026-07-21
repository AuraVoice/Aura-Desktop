use std::sync::Mutex;
use std::time::Instant;

use log::{error, info};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::win_focus;

const MAIN_WINDOW: &str = "main";
const OVERLAY_STORE: &str = "overlay-window.json";
const CENTER_X_KEY: &str = "overlay_center_x";
const CENTER_Y_KEY: &str = "overlay_center_y";
const NOTCH_EDGE_KEY: &str = "notch_edge";

// The signed-in window stays wide enough for the existing cards while the owl
// itself is centered in the transparent base area. Opening a surface adds
// height above this base; the persisted center is the owl anchor.
const COMPANION_WIDTH: f64 = 480.0;
const COMPANION_HEIGHT: f64 = 400.0;
// The notch is a compact waveform-only pill (subtitle removed). It docks to any
// of four screen edges; NOTCH_MAIN is its length ALONG that edge and NOTCH_CROSS
// its thickness perpendicular to it. On Top/Bottom the pill is horizontal
// (NOTCH_MAIN wide x NOTCH_CROSS tall); on Left/Right it renders rotated, so its
// on-screen footprint is NOTCH_CROSS wide x NOTCH_MAIN tall. 184x29 is 40% of the
// old 460x72 bar.
const NOTCH_MAIN: f64 = 184.0;
const NOTCH_CROSS: f64 = 29.0;
// The card that fills the below/beside-notch slot keeps a fixed readable size in
// its natural orientation regardless of edge: CARD_CROSS wide, and as tall as the
// slot extent React passes (draft 270 / inbox 300 / callback 180, via
// set_slot_height). On Top/Bottom the card grows the window along its height; on
// Left/Right it sits beside the notch and grows the window along its width.
const CARD_CROSS: f64 = 380.0;
// Gap between the notch and an open card (matches the CSS grid gap).
const NOTCH_GAP: f64 = 6.0;
const SETUP_WIDTH: f64 = 600.0;
// Tall enough for the first-run question steps (heading + up to six choices +
// optional freetext + button). Sign-in and consent fit comfortably within this
// with extra whitespace. A single global constant keeps the panel one fixed
// size across all setup steps rather than resizing per step.
const SETUP_HEIGHT: f64 = 460.0;
const TOP_MARGIN: f64 = 48.0;
const COMPANION_SURFACE_RESERVE: f64 = 340.0;
// The single below-bar slot's extra window height is owned by React, not Rust:
// whichever surface wins the slot (draft > callback > calendar agenda > kebab
// menu, resolved in OverlayRoot.tsx) passes its own fixed height via
// set_slot_height, and Rust just grows the window by that much below the bar.
// One `slot_height` replaces the former per-card booleans + their applied
// caches, so there's no multi-place tiebreak to keep in sync and no way to
// forget writing one card's applied cache (the old callback-card apply bug).

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlayPresentation {
    Hidden,
    Panel,
    Bar,
    Companion,
    Pointing,
    // Fullscreen, cursor-live (NOT click-through) takeover of the active display
    // while the user long-press-drags the notch to a new edge. Handled by
    // begin/commit/cancel_notch_move with direct window ops, so it never flows
    // through apply()'s per-presentation geometry.
    MovingNotch,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelVariant {
    Setup,
    Companion,
}

/// Which screen edge the notch is docked to. Persisted as a stable lowercase
/// string in the overlay store. The default is Top (the historical position);
/// an unknown/corrupt stored value falls back to it. We persist the EDGE, not an
/// absolute position, so geometry always recomputes from the live display work
/// area - robust across monitor changes, resolution changes, and undocking.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NotchEdge {
    #[default]
    Top,
    Bottom,
    Left,
    Right,
}

impl NotchEdge {
    fn from_stored(value: &str) -> Option<Self> {
        match value {
            "top" => Some(Self::Top),
            "bottom" => Some(Self::Bottom),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            _ => None,
        }
    }

    fn as_stored(self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Bottom => "bottom",
            Self::Left => "left",
            Self::Right => "right",
        }
    }

    /// Left/Right dock the pill rotated to vertical, so its footprint's long axis
    /// is vertical and a card grows horizontally beside it.
    fn is_vertical(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnboardingStep {
    Welcome,
    GetApp,
    WhereHeard,
    Role,
    Link,
    HotkeyTour,
    AgentDemo,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySnapshot {
    pub presentation: OverlayPresentation,
    pub panel_variant: PanelVariant,
    pub notch_edge: NotchEdge,
}

/// All the mutable overlay bookkeeping that used to be split across Flutter's
/// `OverlayController` (presentation/variant/step/voice) and
/// `DesktopWindowService` (applied-state cache/position), merged into one
/// Mutex-guarded struct since Tauri's window calls are synchronous, so there's
/// no async-interleaving hazard requiring two cooperating classes.
pub struct OverlayState {
    presentation: OverlayPresentation,
    panel_variant: PanelVariant,
    onboarding_step: OnboardingStep,
    voice_active: bool,
    // Extra height (logical px) of the one above-companion slot.
    // React owns which surface fills the slot and its content; it passes the
    // height via set_slot_height, and Rust only grows/shrinks the window for it
    // (Companion only). The former per-card draft_card_open/callback_card_open
    // booleans collapsed into this single field once the priority tiebreak
    // moved entirely into OverlayRoot.tsx.
    slot_height: Option<f64>,
    user_center: Option<(f64, f64)>,
    notch_edge: NotchEdge,
    applied_presentation: Option<OverlayPresentation>,
    applied_variant: Option<PanelVariant>,
    applied_slot_height: Option<Option<f64>>,
    // The edge that was last applied to the window, so an edge change forces a
    // reposition even when presentation/variant/slot are unchanged.
    applied_notch_edge: Option<NotchEdge>,
    applying_bounds: bool,
    pre_pointing: Option<(OverlayPresentation, PanelVariant)>,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            presentation: OverlayPresentation::Hidden,
            panel_variant: PanelVariant::Setup,
            onboarding_step: OnboardingStep::Welcome,
            voice_active: false,
            slot_height: None,
            user_center: None,
            notch_edge: NotchEdge::default(),
            applied_presentation: None,
            applied_variant: None,
            applied_slot_height: None,
            applied_notch_edge: None,
            applying_bounds: false,
            pre_pointing: None,
        }
    }
}

/// Every `.lock()` on this recovers from poisoning via `unwrap_or_else(|e|
/// e.into_inner())` rather than `.unwrap()`: a `std::sync::Mutex` stays
/// poisoned forever once any critical section panics while holding it, so a
/// single panic anywhere in this file would otherwise brick every future
/// overlay operation for the rest of the process's life.
pub struct OverlayStateHandle(pub Mutex<OverlayState>);

impl Default for OverlayStateHandle {
    fn default() -> Self {
        Self(Mutex::new(OverlayState::default()))
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn state_handle(app: &AppHandle) -> Option<tauri::State<'_, OverlayStateHandle>> {
    app.try_state::<OverlayStateHandle>()
}

/// Loads the persisted drag-center once at startup; discarded if it no longer
/// falls on any currently-connected monitor (arrangement changed since the
/// last drag - laptop undocked, monitor unplugged, etc).
pub fn load_persisted_center(app: &AppHandle) {
    let (Some(handle), Some(window)) = (state_handle(app), main_window(app)) else {
        return;
    };
    let store = match app.store(OVERLAY_STORE) {
        Ok(store) => store,
        Err(e) => {
            error!("load_persisted_center: failed to open store: {e}");
            return;
        }
    };

    // The notch edge is independent of the companion drag-center: restore it
    // first so a fresh install (no center yet) still honors a saved edge. An
    // unknown/corrupt value silently keeps the Top default.
    if let Some(edge) = store
        .get(NOTCH_EDGE_KEY)
        .and_then(|v| v.as_str().and_then(NotchEdge::from_stored))
    {
        handle
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .notch_edge = edge;
    }

    let (Some(x), Some(y)) = (
        store.get(CENTER_X_KEY).and_then(|v| v.as_f64()),
        store.get(CENTER_Y_KEY).and_then(|v| v.as_f64()),
    ) else {
        return;
    };

    let on_screen = window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|m| {
                let scale = m.scale_factor();
                let pos = m.position().to_logical::<f64>(scale);
                let size = m.size().to_logical::<f64>(scale);
                x >= pos.x && x <= pos.x + size.width && y >= pos.y && y <= pos.y + size.height
            })
        })
        .unwrap_or(false);

    if on_screen {
        handle
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .user_center = Some((x, y));
    }
}

fn persist_center(app: &AppHandle, x: f64, y: f64) {
    match app.store(OVERLAY_STORE) {
        Ok(store) => {
            store.set(CENTER_X_KEY, serde_json::json!(x));
            store.set(CENTER_Y_KEY, serde_json::json!(y));
        }
        // Silently no-ops today beyond this log line - reported to Sentry too so
        // a real-world occurrence during beta is visible without a tester
        // happening to also check their log file.
        Err(e) => {
            error!("persist_center: failed to open store: {e}");
            sentry::capture_message(
                &format!("persist_center: failed to open store: {e}"),
                sentry::Level::Error,
            );
        }
    }
}

fn persist_edge(app: &AppHandle, edge: NotchEdge) {
    match app.store(OVERLAY_STORE) {
        Ok(store) => store.set(NOTCH_EDGE_KEY, serde_json::json!(edge.as_stored())),
        Err(e) => {
            error!("persist_edge: failed to open store: {e}");
            sentry::capture_message(
                &format!("persist_edge: failed to open store: {e}"),
                sentry::Level::Error,
            );
        }
    }
}

/// The display the cursor currently sits on (logical position + size),
/// falling back to the primary monitor, then to a hardcoded 1920x1080 rect if
/// neither can be read.
fn active_display_bounds(window: &WebviewWindow) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|cursor| window.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());

    match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            (
                m.position().to_logical::<f64>(scale),
                m.size().to_logical::<f64>(scale),
            )
        }
        None => (
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1920.0, 1080.0),
        ),
    }
}

/// The active display's WORK AREA (full bounds minus the taskbar and any docked
/// appbars), in logical pixels. Bottom- and side-docked notches use this so they
/// never hide under the taskbar. Falls back to full display bounds if the Win32
/// query fails (and on non-Windows targets).
#[cfg(target_os = "windows")]
fn active_display_work_area(
    window: &WebviewWindow,
) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };

    let (full_pos, full_size) = active_display_bounds(window);
    let scale = window
        .cursor_position()
        .ok()
        .and_then(|cursor| window.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    // Sample a physical point just inside the display's top-left to resolve its
    // HMONITOR, then read rcMonitor/rcWork (both physical device pixels). The
    // taskbar/appbar insets are the difference, converted back to logical px.
    let sample = POINT {
        x: (full_pos.x * scale).round() as i32 + 2,
        y: (full_pos.y * scale).round() as i32 + 2,
    };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe {
        let monitor = MonitorFromPoint(sample, MONITOR_DEFAULTTOPRIMARY);
        GetMonitorInfoW(monitor, &mut info).as_bool()
    };
    if !ok {
        return (full_pos, full_size);
    }

    let mon = info.rcMonitor;
    let work = info.rcWork;
    let left_inset = (work.left - mon.left) as f64 / scale;
    let top_inset = (work.top - mon.top) as f64 / scale;
    let right_inset = (mon.right - work.right) as f64 / scale;
    let bottom_inset = (mon.bottom - work.bottom) as f64 / scale;
    (
        LogicalPosition::new(full_pos.x + left_inset, full_pos.y + top_inset),
        LogicalSize::new(
            (full_size.width - left_inset - right_inset).max(0.0),
            (full_size.height - top_inset - bottom_inset).max(0.0),
        ),
    )
}

#[cfg(not(target_os = "windows"))]
fn active_display_work_area(
    window: &WebviewWindow,
) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    active_display_bounds(window)
}

/// The Bar window's size for the current edge and open card. On Top/Bottom the
/// pill is horizontal and a card grows the window's height; on Left/Right the
/// pill is vertical (footprint NOTCH_CROSS wide x NOTCH_MAIN tall) and a card
/// grows the window's width beside it. `slot` is the card's height extent React
/// passes via set_slot_height (None when no card is open).
fn bar_size(edge: NotchEdge, slot: Option<f64>) -> LogicalSize<f64> {
    if edge.is_vertical() {
        let width = NOTCH_CROSS + slot.map_or(0.0, |_| NOTCH_GAP + CARD_CROSS);
        let height = slot.map_or(NOTCH_MAIN, |extent| NOTCH_MAIN.max(extent));
        LogicalSize::new(width, height)
    } else {
        let width = if slot.is_some() { CARD_CROSS } else { NOTCH_MAIN };
        let height = NOTCH_CROSS + slot.map_or(0.0, |extent| NOTCH_GAP + extent);
        LogicalSize::new(width, height)
    }
}

/// Anchors the Bar window to its edge within the work area. The window contains
/// the notch (centered on the edge's cross-axis) plus any card growing inward,
/// so anchoring the whole window flush to the edge keeps the pill centered on it.
fn bar_position(
    edge: NotchEdge,
    work_pos: LogicalPosition<f64>,
    work_size: LogicalSize<f64>,
    size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    let centered_x = work_pos.x + (work_size.width - size.width) / 2.0;
    let centered_y = work_pos.y + (work_size.height - size.height) / 2.0;
    match edge {
        NotchEdge::Top => LogicalPosition::new(centered_x, work_pos.y),
        NotchEdge::Bottom => {
            LogicalPosition::new(centered_x, work_pos.y + work_size.height - size.height)
        }
        NotchEdge::Left => LogicalPosition::new(work_pos.x, centered_y),
        NotchEdge::Right => {
            LogicalPosition::new(work_pos.x + work_size.width - size.width, centered_y)
        }
    }
}

fn default_position(window: &WebviewWindow, size: LogicalSize<f64>) -> LogicalPosition<f64> {
    let (display_pos, display_size) = active_display_bounds(window);
    LogicalPosition::new(
        display_pos.x + (display_size.width - size.width) / 2.0,
        display_pos.y + TOP_MARGIN,
    )
}

/// Whether the draft slot is showing. Setup and Pointing ignore its remembered
/// height.
fn slot_showing(state: &OverlayState) -> bool {
    state.slot_height.is_some()
        && matches!(
            state.presentation,
            OverlayPresentation::Bar | OverlayPresentation::Companion
        )
}

fn default_companion_position(window: &WebviewWindow) -> LogicalPosition<f64> {
    let (display_pos, display_size) = active_display_bounds(window);
    let available_above = (display_size.height - COMPANION_HEIGHT - TOP_MARGIN).max(0.0);
    LogicalPosition::new(
        display_pos.x + (display_size.width - COMPANION_WIDTH) / 2.0,
        display_pos.y + TOP_MARGIN + COMPANION_SURFACE_RESERVE.min(available_above),
    )
}

fn position_for(
    state: &OverlayState,
    window: &WebviewWindow,
    size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    // The notch docks to one of four screen edges (persisted as an edge, not a
    // position). A card grows the window inward from that edge. The notch ignores
    // the companion's persisted drag center entirely.
    if state.presentation == OverlayPresentation::Bar {
        let (work_pos, work_size) = active_display_work_area(window);
        return bar_position(state.notch_edge, work_pos, work_size, size);
    }

    match state.user_center {
        // user_center always means the OWL BASE's center. Moving the window's
        // top upward by the slot height keeps that base pinned in place.
        Some((cx, cy)) if slot_showing(state) => LogicalPosition::new(
            cx - size.width / 2.0,
            cy - COMPANION_HEIGHT / 2.0 - state.slot_height.unwrap_or(0.0),
        ),
        Some((cx, cy)) => LogicalPosition::new(cx - size.width / 2.0, cy - size.height / 2.0),
        None if slot_showing(state) => {
            let base = default_companion_position(window);
            LogicalPosition::new(base.x, base.y - state.slot_height.unwrap_or(0.0))
        }
        None if state.presentation == OverlayPresentation::Companion => {
            default_companion_position(window)
        }
        None => default_position(window, size),
    }
}

fn size_for(state: &OverlayState) -> LogicalSize<f64> {
    match (state.presentation, state.panel_variant) {
        (OverlayPresentation::Bar, _) => bar_size(state.notch_edge, state.slot_height),
        (OverlayPresentation::Companion, _) => LogicalSize::new(
            COMPANION_WIDTH,
            COMPANION_HEIGHT + state.slot_height.unwrap_or(0.0),
        ),
        (OverlayPresentation::Panel, PanelVariant::Setup) => {
            LogicalSize::new(SETUP_WIDTH, SETUP_HEIGHT)
        }
        _ => LogicalSize::new(COMPANION_WIDTH, COMPANION_HEIGHT),
    }
}

pub fn snapshot(app: &AppHandle) -> OverlaySnapshot {
    let Some(handle) = state_handle(app) else {
        return OverlaySnapshot {
            presentation: OverlayPresentation::Hidden,
            panel_variant: PanelVariant::Setup,
            notch_edge: NotchEdge::default(),
        };
    };
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    OverlaySnapshot {
        presentation: state.presentation,
        panel_variant: state.panel_variant,
        notch_edge: state.notch_edge,
    }
}

fn emit_overlay_changed(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        if let Err(e) = window.emit("overlay-changed", snapshot(app)) {
            error!("overlay: failed to emit overlay-changed: {e}");
        }
    }
}

/// Applies the current state to the real window: resizes/repositions/shows or
/// hides it, then notifies the frontend. No-ops if presentation/variant are
/// unchanged from what's already applied.
///
/// Never holds the state lock across a `window.*` call below. `set_position`
/// can synchronously re-enter this same mutex on this same thread (Windows
/// delivers `WM_MOVE` to the window procedure before `SetWindowPos` returns,
/// and that's wired to `capture_user_position`, which locks this mutex too) -
/// `std::sync::Mutex` isn't reentrant, so holding the guard across it
/// self-deadlocks the thread permanently. Every state read/write here is its
/// own short-lived lock instead.
fn apply_result(app: &AppHandle) -> Result<(), String> {
    let (Some(handle), Some(window)) = (state_handle(app), main_window(app)) else {
        return Err("overlay state or main window unavailable".to_string());
    };

    let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());

    let unchanged = state.applied_presentation == Some(state.presentation)
        && state.applied_variant == Some(state.panel_variant)
        && state.applied_slot_height == Some(state.slot_height)
        && state.applied_notch_edge == Some(state.notch_edge);
    if unchanged {
        return Ok(());
    }

    let started_at = Instant::now();

    if state.presentation == OverlayPresentation::Hidden {
        let from = (state.applied_presentation, state.applied_variant);
        let presentation = state.presentation;
        let panel_variant = state.panel_variant;
        let slot_height = state.slot_height;
        let notch_edge = state.notch_edge;
        drop(state);
        info!("overlay::apply: hiding (from {from:?})");
        window
            .hide()
            .map_err(|e| format!("failed to hide window: {e}"))?;
        {
            let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            state.applied_presentation = Some(presentation);
            state.applied_variant = Some(panel_variant);
            state.applied_slot_height = Some(slot_height);
            state.applied_notch_edge = Some(notch_edge);
        }
        emit_overlay_changed(app);
        info!(
            "overlay::apply: hide complete in {:?}",
            started_at.elapsed()
        );
        return Ok(());
    }

    let presentation = state.presentation;
    let panel_variant = state.panel_variant;
    let slot_height = state.slot_height;
    let notch_edge = state.notch_edge;
    // A "fresh show" is a real presentation/variant transition (summon from
    // hidden, setup<->bar). A slot-height-only change (opening/closing the kebab
    // menu or a card) or an edge re-dock is NOT one - it must not re-steal OS
    // foreground, which flickers focus and costs ~100ms per click on every
    // dropdown toggle.
    let is_fresh_show = state.applied_presentation != Some(presentation)
        || state.applied_variant != Some(panel_variant);
    let size = size_for(&state);
    let position = position_for(&state, &window, size);
    state.applying_bounds = true;
    drop(state);

    info!("overlay::apply: applying presentation={presentation:?} variant={panel_variant:?}");

    let result = window
        .set_size(size)
        .and_then(|_| window.set_position(position))
        .and_then(|_| window.show())
        .and_then(|_| window.set_ignore_cursor_events(false));

    handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .applying_bounds = false;

    result.map_err(|e| format!("failed to resize/reposition/show window: {e}"))?;
    // apply() is the sole path back to a normal presentation. The chained
    // result above includes restoring cursor input after a pointing takeover,
    // so the applied cache is written only once every window operation worked.
    // Only the Setup panel has real inputs (sign-in) that need keyboard focus.
    // The notch/Bar is a passive, hotkey-controlled HUD, and forcing our overlay
    // to the foreground for it does active harm: the Alt tap win_focus injects to
    // win SetForegroundWindow pushes the newly-foreground window into Windows'
    // keyboard menu mode, which then swallows the next Left Ctrl double-tap until
    // the user clicks another window (the documented "fail to dismiss" bug).
    // Always-on-top already keeps the notch visible without stealing focus.
    if matches!(presentation, OverlayPresentation::Panel) && is_fresh_show {
        win_focus::force_foreground(app, &window);
    }

    {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.applied_presentation = Some(presentation);
        state.applied_variant = Some(panel_variant);
        state.applied_slot_height = Some(slot_height);
        state.applied_notch_edge = Some(notch_edge);
    }
    emit_overlay_changed(app);
    info!(
        "overlay::apply: presentation={presentation:?} variant={panel_variant:?} applied in {:?}",
        started_at.elapsed()
    );
    Ok(())
}

pub fn apply(app: &AppHandle) {
    if let Err(e) = apply_result(app) {
        error!("overlay::apply: {e}");
    }
}

fn set_presentation(app: &AppHandle, presentation: OverlayPresentation) {
    if let Some(handle) = state_handle(app) {
        handle
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .presentation = presentation;
    }
    apply(app);
}

/// Whether a voice call is currently live - used by the updater to avoid
/// ever installing a downloaded update out from under an active call.
pub fn is_voice_active(app: &AppHandle) -> bool {
    state_handle(app)
        .map(|h| h.0.lock().unwrap_or_else(|e| e.into_inner()).voice_active)
        .unwrap_or(false)
}

/// Docks the notch to `edge`, persists it, and repositions. The applied-edge
/// cache in apply() makes this reposition even when nothing else changed.
pub fn set_notch_edge(app: &AppHandle, edge: NotchEdge) {
    if let Some(handle) = state_handle(app) {
        handle
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .notch_edge = edge;
    }
    persist_edge(app, edge);
    apply(app);
}

/// Long-press drag-to-dock, step 1: take the active display fullscreen and
/// cursor-live (NOT click-through) so the frontend can render a drag surface
/// with edge drop-zones. Mirrors `point_at`'s direct window ops, bypassing
/// apply()'s per-presentation geometry. No foreground forcing: the same injected
/// Alt tap that would trap the Ctrl double-tap must not fire (see apply()).
pub fn begin_notch_move(app: &AppHandle) -> Result<(), String> {
    let (Some(handle), Some(window)) = (state_handle(app), main_window(app)) else {
        return Err("overlay state or main window unavailable".to_string());
    };
    {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.presentation != OverlayPresentation::Bar {
            return Err("notch move can only start from the bar".to_string());
        }
        state.presentation = OverlayPresentation::MovingNotch;
        state.applying_bounds = true;
    }

    let (pos, size) = active_display_bounds(&window);
    let result = window
        .set_size(size)
        .and_then(|_| window.set_position(pos))
        .and_then(|_| window.set_ignore_cursor_events(false))
        .and_then(|_| window.show());

    handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .applying_bounds = false;

    if let Err(e) = result {
        // Roll back to the bar so a failed takeover never strands the window.
        {
            let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            state.presentation = OverlayPresentation::Bar;
            state.applied_presentation = None;
        }
        apply(app);
        return Err(format!("failed to take over display for notch move: {e}"));
    }

    handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .applied_presentation = Some(OverlayPresentation::MovingNotch);
    emit_overlay_changed(app);
    Ok(())
}

/// Step 2 (release on an edge): dock to `edge` and restore the bar there.
pub fn commit_notch_move(app: &AppHandle, edge: NotchEdge) {
    if let Some(handle) = state_handle(app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.presentation != OverlayPresentation::MovingNotch {
            return;
        }
        state.presentation = OverlayPresentation::Bar;
        state.notch_edge = edge;
    }
    persist_edge(app, edge);
    // applied_presentation is still MovingNotch here, so apply() repositions.
    apply(app);
}

/// Step 2 (cancel / Escape / release in the dead zone): restore the bar at its
/// current edge without changing it.
pub fn cancel_notch_move(app: &AppHandle) {
    if let Some(handle) = state_handle(app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.presentation != OverlayPresentation::MovingNotch {
            return;
        }
        state.presentation = OverlayPresentation::Bar;
    }
    apply(app);
}

/// Ctrl+Alt+B reveals and focuses the persistent companion/setup window.
pub fn hotkey_pressed(app: &AppHandle) {
    summon(app);
}

/// Tray "Open Buddy" / second-instance launch: reveal the correct persistent
/// presentation, or just refocus it if it is already showing.
pub fn summon(app: &AppHandle) {
    let desired = state_handle(app).map(|h| {
        let state = h.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.panel_variant == PanelVariant::Companion {
            OverlayPresentation::Bar
        } else {
            OverlayPresentation::Panel
        }
    });
    let Some(desired) = desired else {
        return;
    };
    if desired == OverlayPresentation::Panel {
        // First-run and signed-out flows live exclusively in the dashboard
        // window. Keep the overlay panel as a fallback if that window fails.
        if crate::dashboard::open_dashboard_window(app).is_ok() {
            return;
        }
        error!("overlay::summon: dashboard open failed; falling back to setup panel");
    }
    let already_visible = state_handle(app)
        .map(|h| h.0.lock().unwrap_or_else(|e| e.into_inner()).presentation == desired)
        .unwrap_or(false);
    // Only the focus-bearing Setup panel forces foreground; the notch/Bar must
    // not, or the injected Alt tap traps the next Ctrl double-tap in menu mode
    // (see apply() above).
    let wants_focus = desired == OverlayPresentation::Panel;
    if already_visible {
        if let Some(window) = main_window(app) {
            let _ = window.show();
            if wants_focus {
                win_focus::force_foreground(app, &window);
            }
        }
        return;
    }
    set_presentation(app, desired);
    if wants_focus {
        if let Some(window) = main_window(app) {
            win_focus::force_foreground(app, &window);
        }
    }
}

pub fn summon_bar(app: &AppHandle) -> Result<(), String> {
    let Some(handle) = state_handle(app) else {
        return Err("overlay state unavailable".to_string());
    };
    {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(
            state.presentation,
            OverlayPresentation::Pointing | OverlayPresentation::MovingNotch
        ) {
            return Err("cannot show voice notch while pointing or moving".to_string());
        }
        state.presentation = OverlayPresentation::Bar;
    }
    // No force_foreground here: the notch is summon-on-demand and always-on-top,
    // so it appears without stealing focus. Forcing foreground would inject the
    // Alt tap that traps the dismiss double-tap in menu mode (see apply()).
    apply_result(app)
}

/// Shows the window as a panel-sized surface for the post-sign-in onboarding
/// tail (hotkey tour + live demo). Sign-in flips the variant to Companion and
/// hides the window (set_panel_variant); the tail calls this to re-reveal it.
/// Unlike `summon`, which routes a signed-in user to the notch Bar, this forces
/// the Panel presentation so the tail's full-size UI is visible. No foreground
/// forcing: the tail's buttons are clickable without it, and forcing it would
/// inject the Alt tap that traps the next Ctrl double-tap (see apply()).
pub fn summon_onboarding_panel(app: &AppHandle) -> Result<(), String> {
    let Some(handle) = state_handle(app) else {
        return Err("overlay state unavailable".to_string());
    };
    {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(
            state.presentation,
            OverlayPresentation::Pointing | OverlayPresentation::MovingNotch
        ) {
            return Err("cannot show onboarding panel while pointing or moving".to_string());
        }
        state.presentation = OverlayPresentation::Panel;
    }
    apply_result(app)
}

pub fn dismiss_bar(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        if let Err(e) = window.emit("end-voice-session", ()) {
            error!("overlay::dismiss_bar: failed to emit end-voice-session: {e}");
        }
    }
    if let Some(handle) = state_handle(app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.presentation = OverlayPresentation::Hidden;
        state.pre_pointing = None;
    }
    apply(app);
}

pub fn esc_pressed(app: &AppHandle) {
    // React consumes Escape to close the active menu/card first. Once the
    // companion itself is resting there is nothing to collapse.
    let _ = app;
}

/// Ctrl+Shift+D: a deliberate, non-Flutter-parity power-user shortcut. Tells
/// the frontend to sign out immediately (bypassing its usual confirm step)
/// and brings the panel up so the result is visible.
pub fn sign_out_requested(app: &AppHandle) {
    // Revoke native authorization (and stop any live meeting capture) BEFORE
    // asking the webview to sign out - if the JS leg stalls or never runs,
    // the sensitive command surface is already locked.
    crate::security::clear_for_sign_out(app);
    if let Some(window) = main_window(app) {
        if let Err(e) = window.emit("sign-out-requested", ()) {
            error!("overlay::sign_out_requested: failed to emit: {e}");
        }
    }
    summon(app);
}

pub fn set_voice_active(app: &AppHandle, active: bool) {
    let Some(handle) = state_handle(app) else {
        return;
    };
    handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .voice_active = active;
}

pub fn set_panel_variant(app: &AppHandle, variant: PanelVariant) {
    if let Some(handle) = state_handle(app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let changed = state.panel_variant != variant;
        state.panel_variant = variant;
        // Auth changes update future summon routing without making the window
        // visible. If setup was open while sign-in completed, hide it so the
        // signed-in resting state is tray-only.
        if changed && state.presentation != OverlayPresentation::Pointing {
            state.presentation = OverlayPresentation::Hidden;
        }
    }
    apply(app);
}

/// The draft slot's extra height, driven by React. The height is remembered
/// across a temporary pointing takeover.
pub fn set_slot_height(app: &AppHandle, height: Option<f64>) {
    if let Some(handle) = state_handle(app) {
        handle
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .slot_height = height;
    }
    apply(app);
}

pub fn set_onboarding_step(app: &AppHandle, step: OnboardingStep) {
    if let Some(handle) = state_handle(app) {
        handle
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .onboarding_step = step;
    }
}

/// Called from the main window's `WindowEvent::Moved` handler. Ignored while
/// a programmatic resize/reposition is in flight, so the app's own moves
/// never get mistaken for (and overwrite) a real user drag.
pub fn capture_user_position(app: &AppHandle, x: f64, y: f64) {
    let Some(handle) = state_handle(app) else {
        return;
    };
    let center = {
        let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.applying_bounds
            || matches!(
                state.presentation,
                OverlayPresentation::Hidden
                    | OverlayPresentation::Bar
                    | OverlayPresentation::MovingNotch
            )
        {
            return;
        }
        let size = size_for(&state);
        // With the slot open, user_center keeps meaning the owl base center,
        // so dragging while a card shows cannot shift the owl when it closes.
        if slot_showing(&state) {
            (
                x + size.width / 2.0,
                y + state.slot_height.unwrap_or(0.0) + COMPANION_HEIGHT / 2.0,
            )
        } else {
            (x + size.width / 2.0, y + size.height / 2.0)
        }
    };
    handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .user_center = Some(center);
    persist_center(app, center.0, center.1);
}

/// Takes the window fullscreen over the target monitor and click-through, for
/// the PointerBuddy flight animation the frontend renders. Direct port of
/// `pointing_overlay_service.dart`'s `pointAt`.
pub fn point_at(
    app: &AppHandle,
    target_x: f64,
    target_y: f64,
    monitor_x: f64,
    monitor_y: f64,
    monitor_w: f64,
    monitor_h: f64,
    label: &str,
) {
    let (Some(handle), Some(window)) = (state_handle(app), main_window(app)) else {
        return;
    };

    {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.pre_pointing.is_none() {
            state.pre_pointing = Some((state.presentation, state.panel_variant));
        }
        state.presentation = OverlayPresentation::Pointing;
        state.applying_bounds = true;
    }

    let result = window
        .set_size(LogicalSize::new(monitor_w, monitor_h))
        .and_then(|_| window.set_position(LogicalPosition::new(monitor_x, monitor_y)))
        .and_then(|_| window.set_ignore_cursor_events(true))
        .and_then(|_| window.show());

    handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .applying_bounds = false;

    if let Err(e) = result {
        error!("overlay::point_at: failed to take over monitor: {e}");
        {
            let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            let (presentation, variant) = state
                .pre_pointing
                .take()
                .unwrap_or((OverlayPresentation::Bar, PanelVariant::Companion));
            state.presentation = presentation;
            state.panel_variant = variant;
            state.applied_presentation = None;
        }
        apply(app);
        return;
    }

    handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .applied_presentation = Some(OverlayPresentation::Pointing);

    // Without this, the frontend's own `presentation` state (only ever
    // updated by this event) never becomes "pointing", so OverlayRoot never
    // mounts PointingOverlay - which means its listener for "pointing-target"
    // below is never attached, and more importantly, the setTimeout inside it
    // that calls cancel_pointing after TOTAL_HOLD_MS never gets scheduled.
    // With no other call site for cancel_pointing anywhere in the app, that
    // left this fullscreen, click-through takeover with no way to ever end -
    // unclickable (by design, for the flight animation) and unrecoverable via
    // any hotkey (hotkey_pressed's match has a bare `_ => {}` for Pointing).
    emit_overlay_changed(app);

    // Window-relative: the window now exactly covers the target monitor, so
    // the frontend just needs where within its own bounds to fly to.
    if let Err(e) = window.emit(
        "pointing-target",
        serde_json::json!({
            "x": target_x - monitor_x,
            "y": target_y - monitor_y,
            "label": label,
        }),
    ) {
        error!("overlay::point_at: failed to emit pointing-target: {e}");
    }
}

/// Ends the flight and hands the window back to whatever it was showing
/// before `point_at` took over.
pub fn cancel_pointing(app: &AppHandle) {
    let (Some(handle), Some(window)) = (state_handle(app), main_window(app)) else {
        return;
    };

    {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.presentation != OverlayPresentation::Pointing {
            return;
        }
        let (presentation, variant) = state.pre_pointing.take().unwrap_or_else(|| {
            error!(
                "overlay::cancel_pointing: pre_pointing was None, falling back to Companion \
                 - point_at should always populate this first, so this indicates a regression \
                 in point_at's call sites"
            );
            (OverlayPresentation::Bar, PanelVariant::Companion)
        });
        state.presentation = presentation;
        state.panel_variant = variant;
    }

    if let Err(e) = window.set_ignore_cursor_events(false) {
        error!("overlay::cancel_pointing: failed to restore cursor events: {e}");
    }
    apply(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_round_trips_through_stored_string() {
        for edge in [
            NotchEdge::Top,
            NotchEdge::Bottom,
            NotchEdge::Left,
            NotchEdge::Right,
        ] {
            assert_eq!(NotchEdge::from_stored(edge.as_stored()), Some(edge));
        }
        assert_eq!(NotchEdge::from_stored("garbage"), None);
    }

    #[test]
    fn bar_size_horizontal_edges_grow_height_for_a_card() {
        // At rest the window is exactly the pill.
        assert_eq!(bar_size(NotchEdge::Top, None), LogicalSize::new(184.0, 29.0));
        assert_eq!(
            bar_size(NotchEdge::Bottom, None),
            LogicalSize::new(184.0, 29.0)
        );
        // A card widens to CARD_CROSS and grows the height by gap + extent.
        assert_eq!(
            bar_size(NotchEdge::Top, Some(270.0)),
            LogicalSize::new(380.0, 29.0 + 6.0 + 270.0)
        );
    }

    #[test]
    fn bar_size_vertical_edges_grow_width_beside_the_pill() {
        // At rest the vertical pill's footprint is NOTCH_CROSS x NOTCH_MAIN.
        assert_eq!(
            bar_size(NotchEdge::Left, None),
            LogicalSize::new(29.0, 184.0)
        );
        // A card grows the width by gap + CARD_CROSS; the height fits the taller
        // of the pill and the card.
        assert_eq!(
            bar_size(NotchEdge::Right, Some(270.0)),
            LogicalSize::new(29.0 + 6.0 + 380.0, 270.0)
        );
        assert_eq!(
            bar_size(NotchEdge::Left, Some(100.0)),
            LogicalSize::new(29.0 + 6.0 + 380.0, 184.0)
        );
    }

    #[test]
    fn bar_position_anchors_flush_to_each_edge() {
        let work_pos = LogicalPosition::new(0.0, 0.0);
        let work_size = LogicalSize::new(1000.0, 800.0);
        let horizontal = LogicalSize::new(184.0, 29.0);
        let vertical = LogicalSize::new(29.0, 184.0);

        // Top: flush to the top, centered horizontally.
        assert_eq!(
            bar_position(NotchEdge::Top, work_pos, work_size, horizontal),
            LogicalPosition::new(408.0, 0.0)
        );
        // Bottom: flush to the bottom (work area, so above the taskbar).
        assert_eq!(
            bar_position(NotchEdge::Bottom, work_pos, work_size, horizontal),
            LogicalPosition::new(408.0, 771.0)
        );
        // Left: flush to the left, centered vertically.
        assert_eq!(
            bar_position(NotchEdge::Left, work_pos, work_size, vertical),
            LogicalPosition::new(0.0, 308.0)
        );
        // Right: flush to the right.
        assert_eq!(
            bar_position(NotchEdge::Right, work_pos, work_size, vertical),
            LogicalPosition::new(971.0, 308.0)
        );
    }
}
