use log::{error, info};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

use crate::{autostart, overlay, updater};

const OPEN_BUDDY: &str = "open_buddy";
const OPEN_DASHBOARD: &str = "open_dashboard";
const AUTOSTART: &str = "autostart";
const VERSION: &str = "version";
const UPDATE: &str = "update";
const QUIT: &str = "quit";

/// Handle to the dynamic "update ready" menu item, so `mark_update_ready`
/// (called from updater.rs once a download finishes) can relabel/enable it
/// without rebuilding the whole menu. Starts disabled with a neutral label -
/// this is the notice itself: no unannounced install, just a menu item the
/// user has to actually click.
pub struct UpdateMenuItem(pub MenuItem<Wry>);

/// Handle to the "Start with Windows" checkbox, so `sync_autostart_item`
/// (called from autostart.rs after every enable/disable attempt) can keep the
/// check mark matched to the real registry state without rebuilding the menu.
pub struct AutostartMenuItem(pub CheckMenuItem<Wry>);

/// Handle to the tray icon itself, so `set_recording` (called from
/// meeting/mod.rs on capture start/stop) can flip the tooltip - part of the
/// "visible capture indicator" commitment: even with the overlay hidden, the
/// tray still says a recording is running.
pub struct TrayHandle(pub tauri::tray::TrayIcon<Wry>);

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open_buddy = MenuItem::with_id(app, OPEN_BUDDY, "Open Buddy", true, None::<&str>)?;
    let open_dashboard = MenuItem::with_id(app, OPEN_DASHBOARD, "Open Dashboard", true, None::<&str>)?;
    // Checked from the real launch-at-login state, not the persisted intent -
    // build runs right after apply_startup_policy, and reality is what the
    // user needs to see if that policy application failed.
    let autostart_item = CheckMenuItem::with_id(
        app,
        AUTOSTART,
        "Start with Windows",
        true,
        autostart::is_enabled(app),
        None::<&str>,
    )?;
    // A beta tester otherwise has no way to tell you which build they're
    // running without checking file properties manually - env!() bakes in
    // Cargo.toml's version at compile time, so this can never drift from the
    // actual build like a hand-copied string could.
    let version_item = MenuItem::with_id(
        app,
        VERSION,
        format!("Aura Desktop v{}", env!("CARGO_PKG_VERSION")),
        false,
        None::<&str>,
    )?;
    let update_item = MenuItem::with_id(app, UPDATE, "Up to date", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_buddy,
            &open_dashboard,
            &autostart_item,
            &version_item,
            &update_item,
            &separator,
            &quit,
        ],
    )?;
    app.manage(UpdateMenuItem(update_item));
    app.manage(AutostartMenuItem(autostart_item));

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    let tray = TrayIconBuilder::new()
        .icon(icon)
        // No-op on Windows/Linux; on macOS this tells the menu bar to treat the
        // icon as a monochrome mask (alpha channel only) so it auto-adapts to
        // light/dark mode instead of rendering as a fixed-color square. Only
        // correct if the tray icon asset is itself alpha-masked artwork - a
        // full-color icon would render as a solid silhouette under this flag.
        .icon_as_template(true)
        .menu(&menu)
        // Menu only on right-click; left-click summons the overlay directly,
        // matching the Flutter tray's onTrayIconMouseDown/RightMouseDown split.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                overlay::summon(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_BUDDY => overlay::summon(app),
            // Opens a browser tab, not an overlay state change, so this just
            // emits an event for the frontend to handle - no window
            // resize/focus needed, unlike every other tray action here.
            OPEN_DASHBOARD => {
                if let Err(e) = app.emit("open-dashboard-requested", ()) {
                    error!("tray: failed to emit open-dashboard-requested: {e}");
                }
            }
            AUTOSTART => autostart::toggle(app),
            VERSION => {} // disabled label item, not clickable
            UPDATE => match updater::install_pending_update(app) {
                Ok(true) => app.request_restart(),
                Ok(false) => info!("tray: update install deferred (call active or nothing pending)"),
                Err(e) => error!("tray: update install failed: {e}"),
            },
            QUIT => app.exit(0),
            other => error!("tray: unknown menu event id {other}"),
        })
        .build(app)?;
    app.manage(TrayHandle(tray));

    Ok(())
}

/// Meeting capture started/stopped: the tray tooltip is the always-there
/// capture indicator (the bar's recording dot only exists while the overlay
/// is visible). No tooltip when idle, matching the tray's default state.
pub fn set_recording(app: &AppHandle, active: bool) {
    let Some(handle) = app.try_state::<TrayHandle>() else {
        return;
    };
    let tooltip = if active { Some("Recording meeting...") } else { None };
    if let Err(e) = handle.0.set_tooltip(tooltip) {
        error!("tray: failed to set recording tooltip: {e}");
    }
}

/// Called from autostart.rs after every enable/disable attempt so the
/// checkbox always shows the real resulting state - including when the
/// underlying registry write failed and the state did not actually change.
pub fn sync_autostart_item(app: &AppHandle, enabled: bool) {
    let Some(item) = app.try_state::<AutostartMenuItem>() else {
        return; // startup policy runs before the tray exists - build() reads the state itself
    };
    if let Err(e) = item.0.set_checked(enabled) {
        error!("tray: failed to sync autostart item: {e}");
    }
}

/// Called once a background download finishes (see updater.rs) - flips the
/// tray's "update" item from a disabled placeholder into something the user
/// can actually click, instead of installing unannounced.
pub fn mark_update_ready(app: &AppHandle, version: &str) {
    let Some(item) = app.try_state::<UpdateMenuItem>() else {
        return;
    };
    if let Err(e) = item.0.set_text(format!("Restart to install v{version}")) {
        error!("tray: failed to relabel update item: {e}");
    }
    if let Err(e) = item.0.set_enabled(true) {
        error!("tray: failed to enable update item: {e}");
    }
}
