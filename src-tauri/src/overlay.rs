use std::sync::Mutex;

use log::error;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::win_focus;

const MAIN_WINDOW: &str = "main";
const OVERLAY_STORE: &str = "overlay-window.json";
const CENTER_X_KEY: &str = "overlay_center_x";
const CENTER_Y_KEY: &str = "overlay_center_y";

const BAR_WIDTH: f64 = 520.0;
const BAR_HEIGHT: f64 = 64.0;
const PILL_WIDTH: f64 = 280.0;
const PILL_HEIGHT: f64 = 400.0;
const SETUP_WIDTH: f64 = 600.0;
const SETUP_HEIGHT: f64 = 340.0;
const TOP_MARGIN: f64 = 48.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlayPresentation {
    Hidden,
    Panel,
    Pill,
    Pointing,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelVariant {
    Setup,
    Bar,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnboardingStep {
    Welcome,
    GetApp,
    Link,
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
    user_center: Option<(f64, f64)>,
    applied_presentation: Option<OverlayPresentation>,
    applied_variant: Option<PanelVariant>,
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
            user_center: None,
            applied_presentation: None,
            applied_variant: None,
            applying_bounds: false,
            pre_pointing: None,
        }
    }
}

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
    let Ok(store) = app.store(OVERLAY_STORE) else {
        return;
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
        handle.0.lock().unwrap().user_center = Some((x, y));
    }
}

fn persist_center(app: &AppHandle, x: f64, y: f64) {
    if let Ok(store) = app.store(OVERLAY_STORE) {
        store.set(CENTER_X_KEY, serde_json::json!(x));
        store.set(CENTER_Y_KEY, serde_json::json!(y));
    }
}

/// The display the cursor currently sits on (logical position + size),
/// falling back to the primary monitor, then to a hardcoded 1920x1080 rect if
/// neither can be read.
fn active_display_bounds(window: &WebviewWindow) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|cursor| {
            window
                .monitor_from_point(cursor.x, cursor.y)
                .ok()
                .flatten()
        })
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

fn position_for(
    state: &OverlayState,
    window: &WebviewWindow,
    size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    match state.user_center {
        Some((cx, cy)) => LogicalPosition::new(cx - size.width / 2.0, cy - size.height / 2.0),
        None => default_position(window, size),
    }
}

fn size_for(state: &OverlayState) -> LogicalSize<f64> {
    match (state.presentation, state.panel_variant) {
        (OverlayPresentation::Pill, _) => LogicalSize::new(PILL_WIDTH, PILL_HEIGHT),
        (OverlayPresentation::Panel, PanelVariant::Bar) => LogicalSize::new(BAR_WIDTH, BAR_HEIGHT),
        (OverlayPresentation::Panel, PanelVariant::Setup) => {
            LogicalSize::new(SETUP_WIDTH, SETUP_HEIGHT)
        }
        _ => LogicalSize::new(BAR_WIDTH, BAR_HEIGHT),
    }
}

pub fn snapshot(app: &AppHandle) -> OverlaySnapshot {
    let Some(handle) = state_handle(app) else {
        return OverlaySnapshot {
            presentation: OverlayPresentation::Hidden,
            panel_variant: PanelVariant::Setup,
        };
    };
    let state = handle.0.lock().unwrap();
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
pub fn apply(app: &AppHandle) {
    let (Some(handle), Some(window)) = (state_handle(app), main_window(app)) else {
        return;
    };
    let mut state = handle.0.lock().unwrap();

    let unchanged = state.applied_presentation == Some(state.presentation)
        && state.applied_variant == Some(state.panel_variant);
    if unchanged {
        return;
    }

    if state.presentation == OverlayPresentation::Hidden {
        if let Err(e) = window.hide() {
            error!("overlay::apply: failed to hide window: {e}");
        }
        state.applied_presentation = Some(state.presentation);
        state.applied_variant = Some(state.panel_variant);
        drop(state);
        emit_overlay_changed(app);
        return;
    }

    let size = size_for(&state);
    let position = position_for(&state, &window, size);

    state.applying_bounds = true;
    let result = window.set_size(size).and_then(|_| window.set_position(position));
    state.applying_bounds = false;

    if let Err(e) = result {
        error!("overlay::apply: failed to resize/reposition window: {e}");
        return;
    }

    if let Err(e) = window.show() {
        error!("overlay::apply: failed to show window: {e}");
    }
    if state.presentation == OverlayPresentation::Panel {
        win_focus::force_foreground(&window);
    }

    state.applied_presentation = Some(state.presentation);
    state.applied_variant = Some(state.panel_variant);
    drop(state);
    emit_overlay_changed(app);
}

fn set_presentation(app: &AppHandle, presentation: OverlayPresentation) {
    if let Some(handle) = state_handle(app) {
        handle.0.lock().unwrap().presentation = presentation;
    }
    apply(app);
}

fn hide_ending_voice(app: &AppHandle) {
    let voice_active = state_handle(app)
        .map(|h| h.0.lock().unwrap().voice_active)
        .unwrap_or(false);
    if voice_active {
        if let Some(window) = main_window(app) {
            let _ = window.emit("end-voice-session", ());
        }
    }
    if let Some(handle) = state_handle(app) {
        handle.0.lock().unwrap().voice_active = false;
    }
    set_presentation(app, OverlayPresentation::Hidden);
}

/// Ctrl+Alt+B: hidden/pill -> panel, panel -> hidden (ending any live voice
/// session first). Ignored mid-pointing-flight.
pub fn hotkey_pressed(app: &AppHandle) {
    let presentation = state_handle(app).map(|h| h.0.lock().unwrap().presentation);
    match presentation {
        Some(OverlayPresentation::Hidden) | Some(OverlayPresentation::Pill) => {
            set_presentation(app, OverlayPresentation::Panel)
        }
        Some(OverlayPresentation::Panel) => hide_ending_voice(app),
        _ => {}
    }
}

/// Tray "Open Buddy" / second-instance launch: bring the panel up, or just
/// refocus it if it's already showing.
pub fn summon(app: &AppHandle) {
    let already_panel = state_handle(app)
        .map(|h| h.0.lock().unwrap().presentation == OverlayPresentation::Panel)
        .unwrap_or(false);
    if already_panel {
        if let Some(window) = main_window(app) {
            let _ = window.show();
            win_focus::force_foreground(&window);
        }
        return;
    }
    set_presentation(app, OverlayPresentation::Panel);
}

pub fn esc_pressed(app: &AppHandle) {
    hide_ending_voice(app);
}

pub fn pill_activated(app: &AppHandle) {
    set_presentation(app, OverlayPresentation::Panel);
}

/// VoiceBar's minimize button: collapses the panel to the small pill without
/// ending the call. Only takes effect while a call is actually live and the
/// panel is showing - `Pill` is only ever meant to be reached while
/// `voice_active` is true, matching the `set_voice_active` guard that sends
/// Pill straight to Hidden once the call ends.
pub fn minimize_to_pill(app: &AppHandle) {
    let should_minimize = state_handle(app)
        .map(|h| {
            let state = h.0.lock().unwrap();
            state.voice_active && state.presentation == OverlayPresentation::Panel
        })
        .unwrap_or(false);
    if should_minimize {
        set_presentation(app, OverlayPresentation::Pill);
    }
}

/// Ctrl+Shift+D: a deliberate, non-Flutter-parity power-user shortcut. Tells
/// the frontend to sign out immediately (bypassing its usual confirm step)
/// and brings the panel up so the result is visible.
pub fn sign_out_requested(app: &AppHandle) {
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
    let presentation = {
        let mut state = handle.0.lock().unwrap();
        state.voice_active = active;
        state.presentation
    };
    if active && presentation == OverlayPresentation::Hidden {
        set_presentation(app, OverlayPresentation::Panel);
    } else if !active && presentation == OverlayPresentation::Pill {
        set_presentation(app, OverlayPresentation::Hidden);
    }
}

pub fn set_panel_variant(app: &AppHandle, variant: PanelVariant) {
    if let Some(handle) = state_handle(app) {
        handle.0.lock().unwrap().panel_variant = variant;
    }
    apply(app);
}

pub fn set_onboarding_step(app: &AppHandle, step: OnboardingStep) {
    if let Some(handle) = state_handle(app) {
        handle.0.lock().unwrap().onboarding_step = step;
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
        let state = handle.0.lock().unwrap();
        if state.applying_bounds || state.presentation == OverlayPresentation::Hidden {
            return;
        }
        let size = size_for(&state);
        (x + size.width / 2.0, y + size.height / 2.0)
    };
    handle.0.lock().unwrap().user_center = Some(center);
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
        let mut state = handle.0.lock().unwrap();
        if state.pre_pointing.is_none() {
            state.pre_pointing = Some((state.presentation, state.panel_variant));
        }
        state.presentation = OverlayPresentation::Pointing;
        // Byptrue apply()'s diffing here (this takeover isn't routed through
        // apply()), but keep its cache in sync so the eventual cancel_pointing
        // -> apply() call sees a real transition and actually restores.
        state.applied_presentation = Some(OverlayPresentation::Pointing);
        state.applying_bounds = true;
    }

    let result = window
        .set_size(LogicalSize::new(monitor_w, monitor_h))
        .and_then(|_| window.set_position(LogicalPosition::new(monitor_x, monitor_y)))
        .and_then(|_| window.set_ignore_cursor_events(true))
        .and_then(|_| window.show());

    handle.0.lock().unwrap().applying_bounds = false;

    if let Err(e) = result {
        error!("overlay::point_at: failed to take over monitor: {e}");
    }

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
        let mut state = handle.0.lock().unwrap();
        if state.presentation != OverlayPresentation::Pointing {
            return;
        }
        let (presentation, variant) = state
            .pre_pointing
            .take()
            .unwrap_or((OverlayPresentation::Hidden, PanelVariant::Setup));
        state.presentation = presentation;
        state.panel_variant = variant;
    }

    if let Err(e) = window.set_ignore_cursor_events(false) {
        error!("overlay::cancel_pointing: failed to restore cursor events: {e}");
    }
    apply(app);
}
