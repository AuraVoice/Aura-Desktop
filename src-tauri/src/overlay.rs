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

// The signed-in window stays wide enough for the existing cards while the owl
// itself is centered in the transparent base area. Opening a surface adds
// height above this base; the persisted center is the owl anchor.
const COMPANION_WIDTH: f64 = 480.0;
const COMPANION_HEIGHT: f64 = 400.0;
const BAR_WIDTH: f64 = 460.0;
const BAR_HEIGHT: f64 = 72.0;
const BAR_TOP_OFFSET: f64 = 0.0;
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
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelVariant {
    Setup,
    Companion,
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
    applied_presentation: Option<OverlayPresentation>,
    applied_variant: Option<PanelVariant>,
    applied_slot_height: Option<Option<f64>>,
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
            applied_presentation: None,
            applied_variant: None,
            applied_slot_height: None,
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
    // The notch stays fixed at the display's top edge. Adding a draft only grows the
    // window downward, and v1 deliberately ignores the persisted drag center.
    if state.presentation == OverlayPresentation::Bar {
        let (display_pos, display_size) = active_display_bounds(window);
        return LogicalPosition::new(
            display_pos.x + (display_size.width - size.width) / 2.0,
            display_pos.y + BAR_TOP_OFFSET,
        );
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
        (OverlayPresentation::Bar, _) => {
            LogicalSize::new(BAR_WIDTH, BAR_HEIGHT + state.slot_height.unwrap_or(0.0))
        }
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
        };
    };
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    OverlaySnapshot {
        presentation: state.presentation,
        panel_variant: state.panel_variant,
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
        && state.applied_slot_height == Some(state.slot_height);
    if unchanged {
        return Ok(());
    }

    let started_at = Instant::now();

    if state.presentation == OverlayPresentation::Hidden {
        let from = (state.applied_presentation, state.applied_variant);
        let presentation = state.presentation;
        let panel_variant = state.panel_variant;
        let slot_height = state.slot_height;
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
    // A "fresh show" is a real presentation/variant transition (summon from
    // hidden, setup<->bar). A slot-height-only change (opening/closing the kebab
    // menu or a card) is NOT one - it must not re-steal OS foreground, which
    // flickers focus and costs ~100ms per click on every dropdown toggle.
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
        if state.presentation == OverlayPresentation::Pointing {
            return Err("cannot show voice notch while pointing".to_string());
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
        if state.presentation == OverlayPresentation::Pointing {
            return Err("cannot show onboarding panel while pointing".to_string());
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
                OverlayPresentation::Hidden | OverlayPresentation::Bar
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
