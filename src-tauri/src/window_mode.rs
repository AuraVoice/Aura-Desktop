use std::sync::Mutex;

use log::error;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::auth_cache;

const AVATAR_WIDTH: f64 = 250.0;
const AVATAR_HEIGHT: f64 = 250.0;
const AVATAR_MARGIN: f64 = 32.0;
const DASHBOARD_WIDTH: f64 = 440.0;
const DASHBOARD_HEIGHT: f64 = 680.0;

const WINDOW_STATE_STORE: &str = "window-state.json";
const AVATAR_POSITION_KEY: &str = "avatar_position";

const MAIN_WINDOW: &str = "main";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    Avatar,
    Dashboard,
}

/// Tracks which mode the single shared window is currently in, so window-moved
/// events know whether a drag should be persisted as the avatar's position.
pub struct ModeState(pub Mutex<WindowMode>);

impl Default for ModeState {
    fn default() -> Self {
        Self(Mutex::new(WindowMode::Avatar))
    }
}

/// Missing/expired session (no cached Firebase auth state) always routes to
/// the dashboard/pairing screen, regardless of which hotkey fired.
pub fn resolve_smart_toggle_mode(app: &AppHandle) -> WindowMode {
    if auth_cache::has_cached_session(app) {
        WindowMode::Avatar
    } else {
        WindowMode::Dashboard
    }
}

pub fn resolve_startup_mode(app: &AppHandle) -> WindowMode {
    resolve_smart_toggle_mode(app)
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn default_avatar_position(window: &WebviewWindow) -> LogicalPosition<f64> {
    match window.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            LogicalPosition::new(
                size.width - AVATAR_WIDTH - AVATAR_MARGIN,
                size.height - AVATAR_HEIGHT - AVATAR_MARGIN,
            )
        }
        _ => LogicalPosition::new(AVATAR_MARGIN, AVATAR_MARGIN),
    }
}

fn avatar_position(app: &AppHandle, window: &WebviewWindow) -> LogicalPosition<f64> {
    if let Ok(store) = app.store(WINDOW_STATE_STORE) {
        if let Some(value) = store.get(AVATAR_POSITION_KEY) {
            if let Ok((x, y)) = serde_json::from_value::<(f64, f64)>(value) {
                return LogicalPosition::new(x, y);
            }
        }
    }
    default_avatar_position(window)
}

/// Resizes/repositions the single shared window into `mode`, shows it, and
/// notifies the frontend so it can swap between the avatar and dashboard views.
pub fn apply_mode(app: &AppHandle, mode: WindowMode) {
    let Some(window) = main_window(app) else {
        return;
    };

    if let Some(state) = app.try_state::<ModeState>() {
        *state.0.lock().unwrap() = mode;
    }

    let resize_result = match mode {
        WindowMode::Avatar => {
            let position = avatar_position(app, &window);
            window
                .set_size(LogicalSize::new(AVATAR_WIDTH, AVATAR_HEIGHT))
                .and_then(|_| window.set_position(position))
                .and_then(|_| window.set_skip_taskbar(true))
        }
        WindowMode::Dashboard => window
            .set_size(LogicalSize::new(DASHBOARD_WIDTH, DASHBOARD_HEIGHT))
            .and_then(|_| window.center())
            .and_then(|_| window.set_skip_taskbar(false)),
    };
    if let Err(e) = resize_result {
        error!("apply_mode({mode:?}): failed to resize/reposition window: {e}");
    }

    if let Err(e) = window.show() {
        error!("apply_mode({mode:?}): failed to show window: {e}");
    }
    if let Err(e) = window.set_focus() {
        error!("apply_mode({mode:?}): failed to focus window: {e}");
    }
    if let Err(e) = window.emit("mode-changed", mode) {
        error!("apply_mode({mode:?}): failed to emit mode-changed: {e}");
    }
}

/// Called from the main window's Moved event handler; only writes to disk
/// while the window is currently in avatar mode.
pub fn persist_avatar_position_if_avatar(app: &AppHandle, x: f64, y: f64) {
    let Some(state) = app.try_state::<ModeState>() else {
        return;
    };
    if *state.0.lock().unwrap() != WindowMode::Avatar {
        return;
    }
    match app.store(WINDOW_STATE_STORE) {
        Ok(store) => store.set(AVATAR_POSITION_KEY, serde_json::json!((x, y))),
        Err(e) => error!("persist_avatar_position_if_avatar: failed to open store: {e}"),
    }
}
