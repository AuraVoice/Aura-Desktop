use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

const STATUS_PILL_WINDOW: &str = "status-pill";
const STATUS_PILL_WIDTH: f64 = 220.0;
const STATUS_PILL_HEIGHT: f64 = 44.0;
const STATUS_PILL_BOTTOM_GAP: f64 = 70.0;
const STATUS_PILL_HOLD_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StatusPillKind {
    VoiceMuted,
    VoiceUnmuted,
    VoiceChangeUnconfirmed,
    ScreenSightOn,
    ScreenSightOff,
    GuideOn,
    GuideOff,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPillPayload {
    kind: StatusPillKind,
    sequence: u64,
}

#[derive(Default)]
struct StatusPillRuntime {
    current: Option<StatusPillPayload>,
    sequence: u64,
}

#[derive(Default)]
pub struct StatusPillHandle(Mutex<StatusPillRuntime>);

fn build_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(STATUS_PILL_WINDOW) {
        log::info!("status_pill: reusing window");
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        STATUS_PILL_WINDOW,
        WebviewUrl::App("index.html".into()),
    )
    .title("Aura Status")
    .inner_size(STATUS_PILL_WIDTH, STATUS_PILL_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;

    let _ = window.set_ignore_cursor_events(true);
    let _ = crate::overlay::exclude_main_window_from_capture(&window);
    apply_no_activate(&window);
    log::info!("status_pill: window created");
    Ok(window)
}

fn place_window(window: &tauri::WebviewWindow) {
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|cursor| window.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let full_position = monitor.position().to_logical::<f64>(scale);
    let full_size = monitor.size().to_logical::<f64>(scale);
    let (work_position, work_size) =
        crate::overlay::work_area_within(full_position, full_size, scale);
    let position = LogicalPosition::new(
        work_position.x + (work_size.width - STATUS_PILL_WIDTH) / 2.0,
        work_position.y + work_size.height - STATUS_PILL_HEIGHT - STATUS_PILL_BOTTOM_GAP,
    );
    let _ = window.set_size(LogicalSize::new(STATUS_PILL_WIDTH, STATUS_PILL_HEIGHT));
    let _ = window.set_position(position);
    log::info!(
        "status_pill: placed x={} y={} work={}x{}",
        position.x,
        position.y,
        work_size.width,
        work_size.height
    );
}

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

#[tauri::command]
pub async fn show_status_pill(app: AppHandle, kind: StatusPillKind) {
    log::info!("status_pill: request kind={kind:?}");
    let sequence = {
        let Some(state) = app.try_state::<StatusPillHandle>() else {
            log::error!("status_pill: state unavailable");
            return;
        };
        let mut runtime = state.0.lock().unwrap_or_else(|error| error.into_inner());
        runtime.sequence = runtime.sequence.wrapping_add(1);
        let sequence = runtime.sequence;
        runtime.current = Some(StatusPillPayload { kind, sequence });
        sequence
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let window = match build_window(&handle) {
            Ok(window) => window,
            Err(error) => {
                log::error!("status_pill: failed to create window: {error}");
                return;
            }
        };
        place_window(&window);
        if let Some(payload) = status_pill_state(handle.state::<StatusPillHandle>()) {
            let _ = window.emit("status-pill-update", payload);
        }
        if let Err(error) = window.show() {
            log::error!("status_pill: failed to show window: {error}");
        } else {
            log::info!("status_pill: shown sequence={sequence}");
        }
    });

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(STATUS_PILL_HOLD_MS)).await;
        let should_hide = app
            .try_state::<StatusPillHandle>()
            .map(|state| {
                state
                    .0
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .sequence
                    == sequence
            })
            .unwrap_or(false);
        if !should_hide {
            return;
        }
        let hide_handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = hide_handle.get_webview_window(STATUS_PILL_WINDOW) {
                let _ = window.hide();
            }
        });
    });
}

#[tauri::command]
pub fn status_pill_state(
    state: tauri::State<'_, StatusPillHandle>,
) -> Option<StatusPillPayload> {
    state
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .current
        .clone()
}
