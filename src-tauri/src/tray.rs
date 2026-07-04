use log::error;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle,
};

use crate::window_mode::{self, WindowMode};

const SHOW_DASHBOARD: &str = "show_dashboard";
const QUIT: &str = "quit";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show_dashboard = MenuItem::with_id(app, SHOW_DASHBOARD, "Show Dashboard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_dashboard, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_DASHBOARD => window_mode::apply_mode(app, WindowMode::Dashboard),
            QUIT => app.exit(0),
            other => error!("tray: unknown menu event id {other}"),
        })
        .build(app)?;

    Ok(())
}
