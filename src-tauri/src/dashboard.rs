use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

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
/// window (borderless, transparent, always-on-top, off the taskbar), this is a
/// normal decorated, opaque, resizable app window that shows in the taskbar.
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
