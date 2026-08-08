use log::{error, info};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

use crate::{autostart, dashboard, overlay, updater};

const OPEN_BUDDY: &str = "open_buddy";
const OPEN_DASHBOARD: &str = "open_dashboard";
const OPEN_NOTIFICATIONS: &str = "open_notifications";
const CAPTURE_NOW: &str = "capture_now";
const SIGN_OUT: &str = "sign_out";
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

/// Handle to the "Notifications" menu item, so `set_unread` (called via the
/// `set_tray_unread` command whenever the frontend's unread count changes) can
/// show the count in the label. The unread count lives on the LABEL, not the
/// tray tooltip, because the tooltip is already the recording indicator
/// (`set_recording`) and the two must not clobber each other.
pub struct NotificationsMenuItem(pub MenuItem<Wry>);

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open_buddy = MenuItem::with_id(app, OPEN_BUDDY, "Open Buddy", true, None::<&str>)?;
    let open_dashboard =
        MenuItem::with_id(app, OPEN_DASHBOARD, "Open Dashboard", true, None::<&str>)?;
    let notifications_item =
        MenuItem::with_id(app, OPEN_NOTIFICATIONS, "Notifications", true, None::<&str>)?;
    // The notch pill carries no controls any more, so the two menu actions that
    // had no other home moved here. Both are frontend concerns, so they follow
    // the OPEN_NOTIFICATIONS shape: Rust only fires the intent.
    let capture_now_item =
        MenuItem::with_id(app, CAPTURE_NOW, "Capture now", true, None::<&str>)?;
    let sign_out_item = MenuItem::with_id(app, SIGN_OUT, "Sign out", true, None::<&str>)?;
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
            &notifications_item,
            &capture_now_item,
            &autostart_item,
            &version_item,
            &update_item,
            &separator,
            &sign_out_item,
            &quit,
        ],
    )?;
    app.manage(UpdateMenuItem(update_item));
    app.manage(AutostartMenuItem(autostart_item));
    app.manage(NotificationsMenuItem(notifications_item));

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
            OPEN_DASHBOARD => {
                if let Err(e) = dashboard::open_dashboard_window(app) {
                    error!("tray: failed to open dashboard: {e}");
                }
            }
            // Summon the overlay AND ask the frontend to open the inbox slot,
            // mirroring how OPEN_DASHBOARD hands off to the frontend.
            OPEN_NOTIFICATIONS => {
                overlay::summon(app);
                if let Err(e) = app.emit("open-notifications-requested", ()) {
                    error!("tray: failed to emit open-notifications-requested: {e}");
                }
            }
            // useMeetingCapture owns the arm state and the upload queue, so the
            // capture itself has to start on the frontend. Summon first for the
            // same reason OPEN_NOTIFICATIONS does: the recording indicator lives
            // on the bar, and starting a capture with no visible surface would
            // break the "capture is always visible" commitment.
            CAPTURE_NOW => {
                overlay::summon(app);
                if let Err(e) = app.emit("capture-now-requested", ()) {
                    error!("tray: failed to emit capture-now-requested: {e}");
                }
            }
            // Same entry point Ctrl+Shift+D uses: it revokes the native command
            // surface BEFORE asking the webview to sign out, so a stalled JS leg
            // still leaves the sensitive commands locked.
            SIGN_OUT => overlay::sign_out_requested(app),
            AUTOSTART => autostart::toggle(app),
            VERSION => {} // disabled label item, not clickable
            UPDATE => match updater::install_pending_update(app) {
                Ok(true) => app.request_restart(),
                Ok(false) => {
                    info!("tray: update install deferred (call active or nothing pending)")
                }
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
    let tooltip = if active {
        Some("Recording meeting...")
    } else {
        None
    };
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

/// Reflect the frontend's unread notification count in the tray menu item
/// label ("Notifications" / "Notifications (N)" / "Notifications (9+)"). Label,
/// not tooltip, so it never fights the recording indicator (`set_recording`).
pub fn set_unread(app: &AppHandle, count: u32) {
    let Some(item) = app.try_state::<NotificationsMenuItem>() else {
        return;
    };
    let label = match count {
        0 => "Notifications".to_string(),
        1..=9 => format!("Notifications ({count})"),
        _ => "Notifications (9+)".to_string(),
    };
    if let Err(e) = item.0.set_text(label) {
        error!("tray: failed to set notifications unread label: {e}");
    }
}

/// Command surface for `set_unread`: the unread count is owned by the frontend
/// broker, which calls this whenever it changes.
#[tauri::command]
pub fn set_tray_unread(app: AppHandle, count: u32) {
    set_unread(&app, count);
}
