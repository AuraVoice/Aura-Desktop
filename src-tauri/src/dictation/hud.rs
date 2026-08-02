//! The dictation HUD: a small always-on-top caption strip that shows streaming
//! partials while the chord is held.
//!
//! This is its OWN window (label "dictation"), not an overlay.rs presentation,
//! for two reasons. Any path into the overlay can reach
//! `win_focus::force_foreground`, which both steals focus (killing insertion,
//! whose whole contract is that the target window keeps it) and taps Alt,
//! dropping the target into keyboard menu mode. And
//! `OverlayPresentation::Bar` is already in use whenever a voice session is
//! live, so the two surfaces would fight over `applied_presentation`.
//!
//! main.tsx routes on the window label, and "dictation" is listed in
//! capabilities/default.json's `windows` array. Without that entry the label
//! gets ZERO permissions, including core:default, so it could not even listen
//! for its own events.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DICTATION_WINDOW: &str = "dictation";

const HUD_WIDTH: f64 = 460.0;
const HUD_HEIGHT: f64 = 104.0;
/// Distance from the bottom of the work area. High enough to clear the taskbar
/// on a default Windows setup without covering the app the user is typing into.
const HUD_BOTTOM_MARGIN: f64 = 120.0;

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
}

impl HudUpdate {
    pub fn new(phase: HudPhase) -> Self {
        Self {
            phase,
            text: String::new(),
            message: None,
            chord_label: super::chord::DICTATION_CHORD.label(),
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
    .inner_size(HUD_WIDTH, HUD_HEIGHT)
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

    // Click-through: the HUD is a caption, never a target. It must not take a
    // click away from the app the user is dictating into.
    let _ = window.set_ignore_cursor_events(true);
    // Same display-affinity treatment the overlay gets: partial transcript text
    // should not land in a screen share or a screenshot.
    let _ = crate::overlay::exclude_main_window_from_capture(&window);
    apply_no_activate(&window);
    position_window(&window);
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

fn position_window(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);
    let x = origin.x + (size.width - HUD_WIDTH) / 2.0;
    let y = origin.y + size.height - HUD_HEIGHT - HUD_BOTTOM_MARGIN;
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

/// Builds the window on first use. Called on prewarm so the first dictation
/// does not pay for a cold webview, and skipped entirely for users who never
/// dictate.
pub fn ensure(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = build_window(&handle) {
            log::error!("dictation.hud: failed to create the HUD window: {e}");
        }
    });
}

pub fn show(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if build_window(&handle).is_err() {
            return;
        }
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            position_window(&window);
            let _ = window.show();
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
pub fn publish(app: &AppHandle, update: HudUpdate) {
    if let Some(window) = app.get_webview_window(DICTATION_WINDOW) {
        let _ = window.emit("dictation-update", update);
    }
}
