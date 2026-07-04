use log::error;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::overlay;

const OPEN_BUDDY: &str = "open_buddy";
const QUIT: &str = "quit";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open_buddy = MenuItem::with_id(app, OPEN_BUDDY, "Open Buddy", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_buddy, &quit])?;

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
            QUIT => app.exit(0),
            other => error!("tray: unknown menu event id {other}"),
        })
        .build(app)?;

    Ok(())
}
