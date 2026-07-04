mod auth_cache;
mod hotkeys;
mod logging;
mod screenshot;
mod tray;
mod updater;
mod window_mode;

use log::error;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use window_mode::{ModeState, WindowMode};

/// Lets the frontend pull the authoritative current mode on mount, in case it
/// missed the `mode-changed` event emitted during Rust-side startup.
#[tauri::command]
fn current_mode(state: State<ModeState>) -> WindowMode {
    *state.0.lock().unwrap()
}

/// Lets the frontend drive an explicit mode transition (e.g. after a
/// successful pairing, or when an authenticated call finds the session gone).
#[tauri::command]
fn switch_mode(app: AppHandle, mode: WindowMode) {
    window_mode::apply_mode(&app, mode);
}

/// Mirrors the frontend's Firebase auth state into Rust so the next hotkey
/// press or cold start can decide avatar-vs-dashboard without waiting on the
/// webview.
#[tauri::command]
fn set_session_cached(app: AppHandle, has_session: bool) {
    auth_cache::set_cached_session(&app, has_session);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(logging::plugin())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window instead of spawning a duplicate.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.show() {
                    error!("single-instance: failed to show window: {e}");
                }
                if let Err(e) = window.set_focus() {
                    error!("single-instance: failed to focus window: {e}");
                }
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        hotkeys::handle(app, shortcut);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .manage(ModeState::default())
        .invoke_handler(tauri::generate_handler![
            current_mode,
            switch_mode,
            set_session_cached,
            screenshot::capture_screenshot
        ])
        .setup(|app| {
            logging::install_panic_hook();

            let handle = app.handle().clone();
            app.global_shortcut()
                .register(hotkeys::smart_toggle_shortcut())?;
            app.global_shortcut()
                .register(hotkeys::open_dashboard_shortcut())?;

            tray::build(app.handle())?;

            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let WindowEvent::Moved(position) = event {
                        if let Some(win) = handle.get_webview_window("main") {
                            match win.scale_factor() {
                                Ok(scale) => {
                                    let logical = position.to_logical::<f64>(scale);
                                    window_mode::persist_avatar_position_if_avatar(
                                        &handle, logical.x, logical.y,
                                    );
                                }
                                Err(e) => error!("failed to read window scale factor: {e}"),
                            }
                        }
                    }
                });
            }

            let startup_mode = window_mode::resolve_startup_mode(app.handle());
            window_mode::apply_mode(app.handle(), startup_mode);

            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(updater::check_for_updates(updater_handle));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
