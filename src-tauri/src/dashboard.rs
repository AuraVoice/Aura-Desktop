use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Label of the in-app dashboard window. Distinct from the "main" overlay
/// window, so every overlay/voice/meeting helper in overlay.rs (which all target
/// "main") is untouched by this second window.
pub const DASHBOARD_WINDOW: &str = "dashboard";

/// Opens the in-app dashboard, or focuses it if it is already open. Created at
/// runtime (not declared in tauri.conf.json) so it only exists on demand rather
/// than fighting the hidden-at-startup posture of the overlay. Unlike the main
/// window (borderless, transparent, always-on-top, off the taskbar), this is a
/// normal decorated, opaque, resizable app window that shows in the taskbar.
/// It loads the same bundle as "main"; main.tsx routes on the window label.
pub fn open_dashboard_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DASHBOARD_WINDOW) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, DASHBOARD_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Aura Dashboard")
        .inner_size(1000.0, 700.0)
        .min_inner_size(720.0, 520.0)
        .decorations(true)
        .transparent(false)
        .shadow(true)
        .always_on_top(false)
        .skip_taskbar(false)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.set_focus();
    Ok(())
}
