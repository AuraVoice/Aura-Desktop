use log::error;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

/// The dashboard's own settings store, written by src/lib/generalSettings.ts.
/// Read here (rather than waiting for the frontend to push) so the window is
/// built with the right taskbar posture on its very first frame - toggling it
/// after the fact makes the button visibly flicker in and out.
const OVERLAY_STORE: &str = "overlay-window.json";
const GENERAL_SETTINGS_KEY: &str = "dashboard_general_settings";

/// Label of the in-app dashboard window. Distinct from the "main" overlay
/// window, so every overlay/voice/meeting helper in overlay.rs (which all target
/// "main") is untouched by this second window.
pub const DASHBOARD_WINDOW: &str = "dashboard";

const DASHBOARD_ROUTES: &[&str] = &[
    "/home",
    "/conversations",
    "/drafts",
    "/saved",
    "/meetings",
    "/insights",
    "/general",
    "/connectors",
    "/account",
    "/billing",
    "/usage",
    "/mobile",
    "/help",
];

fn normalize_route(route: Option<&str>) -> &'static str {
    let requested = route.unwrap_or("/home");
    DASHBOARD_ROUTES
        .iter()
        .copied()
        .find(|candidate| *candidate == requested)
        .unwrap_or("/home")
}

/// Opens the in-app dashboard, or focuses it if it is already open. Created at
/// runtime (not declared in tauri.conf.json) so it only exists on demand rather
/// than fighting the hidden-at-startup posture of the overlay. Unlike the main
/// window (borderless, transparent, always-on-top, off the taskbar), this is an
/// opaque, resizable app window with frontend-owned chrome that shows in the taskbar.
/// It loads the same bundle as "main"; main.tsx routes on the window label.
pub fn open_dashboard_window(app: &AppHandle) -> Result<(), String> {
    open_dashboard_route(app, None)
}

/// Opens the dashboard at a validated in-app route. Existing windows receive
/// an event after they are visible; new windows boot with the route in the URL
/// hash so HashRouter can render the destination on its first frame.
pub fn open_dashboard_route(app: &AppHandle, route: Option<&str>) -> Result<(), String> {
    let route = normalize_route(route);
    if let Some(window) = app.get_webview_window(DASHBOARD_WINDOW) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        window
            .emit("dashboard-navigate", route)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = format!("index.html#{route}");
    let window = WebviewWindowBuilder::new(app, DASHBOARD_WINDOW, WebviewUrl::App(url.into()))
        .title("Aura")
        .inner_size(1000.0, 700.0)
        .min_inner_size(720.0, 520.0)
        .decorations(false)
        .transparent(false)
        .shadow(true)
        .always_on_top(false)
        .skip_taskbar(!show_in_taskbar(app))
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.set_focus();
    Ok(())
}

/// Whether the dashboard window should own a taskbar button. Defaults to true
/// on any read failure or missing key - a user who cannot find the window they
/// just opened is a far worse outcome than an unwanted taskbar button.
fn show_in_taskbar(app: &AppHandle) -> bool {
    let Ok(store) = app.store(OVERLAY_STORE) else {
        return true;
    };
    store
        .get(GENERAL_SETTINGS_KEY)
        .and_then(|settings| {
            settings
                .get("showInTaskbar")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(true)
}

/// Settings > System > "Show Aura in the taskbar". Windows analogue of macOS's
/// dock toggle; the "main" overlay window stays off the taskbar unconditionally
/// (tauri.conf.json) and is unaffected. No-op when the dashboard is closed -
/// the next open reads the stored value itself.
#[tauri::command]
pub async fn set_dashboard_in_taskbar(app: AppHandle, visible: bool) {
    let Some(window) = app.get_webview_window(DASHBOARD_WINDOW) else {
        return;
    };
    if let Err(e) = window.set_skip_taskbar(!visible) {
        error!("dashboard: failed to set taskbar visibility: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_routes_fail_closed_to_home() {
        assert_eq!(normalize_route(Some("/insights")), "/insights");
        assert_eq!(normalize_route(Some("javascript:alert(1)")), "/home");
        assert_eq!(normalize_route(None), "/home");
    }
}
