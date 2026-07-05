mod auth_cache;
mod hotkeys;
mod logging;
mod overlay;
mod screenshot;
mod tray;
mod updater;
mod win_focus;

use log::error;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use overlay::{OnboardingStep, OverlaySnapshot, OverlayStateHandle, PanelVariant};
use win_focus::ForegroundGeneration;

#[tauri::command]
fn current_overlay_state(app: AppHandle) -> OverlaySnapshot {
    overlay::snapshot(&app)
}

#[tauri::command]
fn esc_pressed(app: AppHandle) {
    overlay::esc_pressed(&app);
}

#[tauri::command]
fn set_voice_active(app: AppHandle, active: bool) {
    overlay::set_voice_active(&app, active);
}

#[tauri::command]
fn set_panel_variant(app: AppHandle, variant: PanelVariant) {
    overlay::set_panel_variant(&app, variant);
}

#[tauri::command]
fn set_onboarding_step(app: AppHandle, step: OnboardingStep) {
    overlay::set_onboarding_step(&app, step);
}

#[tauri::command]
fn pill_activated(app: AppHandle) {
    overlay::pill_activated(&app);
}

#[tauri::command]
fn minimize_to_pill(app: AppHandle) {
    overlay::minimize_to_pill(&app);
}

#[tauri::command]
fn set_session_cached(app: AppHandle, has_session: bool) {
    auth_cache::set_cached_session(&app, has_session);
}

/// Called when an authenticated request finds the session gone (expired/
/// revoked token). Rust-side callers (tray, second-instance) call
/// `overlay::summon` directly; this is the JS-callable equivalent for that
/// one case where the frontend itself needs to force the panel visible.
#[tauri::command]
fn summon(app: AppHandle) {
    overlay::summon(&app);
}

#[tauri::command]
fn point_at(
    app: AppHandle,
    target_x: f64,
    target_y: f64,
    monitor_x: f64,
    monitor_y: f64,
    monitor_w: f64,
    monitor_h: f64,
    label: String,
) {
    overlay::point_at(&app, target_x, target_y, monitor_x, monitor_y, monitor_w, monitor_h, &label);
}

#[tauri::command]
fn cancel_pointing(app: AppHandle) {
    overlay::cancel_pointing(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(logging::plugin())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            overlay::summon(app);
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
        .manage(OverlayStateHandle::default())
        .manage(ForegroundGeneration::default())
        .invoke_handler(tauri::generate_handler![
            current_overlay_state,
            esc_pressed,
            set_voice_active,
            set_panel_variant,
            set_onboarding_step,
            pill_activated,
            minimize_to_pill,
            set_session_cached,
            summon,
            point_at,
            cancel_pointing,
            screenshot::capture_cursor_display_with_geometry
        ])
        .setup(|app| {
            logging::install_panic_hook();

            let handle = app.handle().clone();
            app.global_shortcut().register(hotkeys::summon_shortcut())?;
            app.global_shortcut().register(hotkeys::sign_out_shortcut())?;
            app.global_shortcut().register(hotkeys::screen_sight_shortcut())?;

            tray::build(app.handle())?;

            if let Some(window) = app.get_webview_window("main") {
                let moved_handle = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Moved(position) = event {
                        if let Some(win) = moved_handle.get_webview_window("main") {
                            match win.scale_factor() {
                                Ok(scale) => {
                                    let logical = position.to_logical::<f64>(scale);
                                    overlay::capture_user_position(&moved_handle, logical.x, logical.y);
                                }
                                Err(e) => error!("failed to read window scale factor: {e}"),
                            }
                        }
                    }
                });
            }

            // Pre-seed panel_variant from the last-known auth state so the
            // very first summon sizes/shows the right panel immediately,
            // rather than booting into Setup and flashing to Bar a frame
            // later once the webview's own auth listener resolves.
            let initial_variant = if auth_cache::has_cached_session(app.handle()) {
                PanelVariant::Bar
            } else {
                PanelVariant::Setup
            };
            overlay::load_persisted_center(app.handle());
            overlay::set_panel_variant(app.handle(), initial_variant);
            overlay::summon(app.handle());

            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(updater::check_for_updates(updater_handle));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
