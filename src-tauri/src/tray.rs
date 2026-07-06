use log::{error, info};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

use crate::{overlay, updater};

const OPEN_BUDDY: &str = "open_buddy";
const VERSION: &str = "version";
const UPDATE: &str = "update";
const QUIT: &str = "quit";

/// Handle to the dynamic "update ready" menu item, so `mark_update_ready`
/// (called from updater.rs once a download finishes) can relabel/enable it
/// without rebuilding the whole menu. Starts disabled with a neutral label -
/// this is the notice itself: no unannounced install, just a menu item the
/// user has to actually click.
pub struct UpdateMenuItem(pub MenuItem<Wry>);

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open_buddy = MenuItem::with_id(app, OPEN_BUDDY, "Open Buddy", true, None::<&str>)?;
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
        &[&open_buddy, &version_item, &update_item, &separator, &quit],
    )?;
    app.manage(UpdateMenuItem(update_item));

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::new()
        .icon(icon)
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

    Ok(())
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
