mod auth_cache;
mod autostart;
mod hotkeys;
mod logging;
mod overlay;
mod screenshot;
mod sentry_setup;
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
fn set_draft_card_open(app: AppHandle, open: bool) {
    overlay::set_draft_card_open(&app, open);
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

/// Reads the last `count` lines of the durable app log, for the in-app
/// feedback button to attach - file IO, so this is async per this repo's own
/// main-thread-blocking rule rather than reading inline.
#[tauri::command]
async fn read_recent_log_lines(app: AppHandle, count: usize) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Matches tauri-plugin-log's own LogDir{file_name: None} naming:
        // <app_log_dir>/<product name>.log ("Aura Desktop.log" - see
        // logging.rs's plugin()). Derived from package_info() rather than
        // hardcoded so a productName change can't silently break this again.
        let file_name = format!("{}.log", app.package_info().name);
        let path = app
            .path()
            .app_log_dir()
            .map_err(|e| e.to_string())?
            .join(file_name);
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let lines: Vec<String> = content.lines().map(String::from).collect();
        let start = lines.len().saturating_sub(count);
        Ok(lines[start..].to_vec())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Held for the whole process lifetime (run() doesn't return until the app
    // exits) - dropping it early would flush and disable the client.
    let _sentry_guard = sentry_setup::init();

    let mut builder = tauri::Builder::default().plugin(logging::plugin());

    // Release-only: dev and installed builds share the same com.aura.desktop
    // single-instance key, and autostart keeps the installed app alive in the
    // tray. Registering this in a debug build makes `npm run tauri dev`
    // forward its launch to that old instance and exit - the panel that pops
    // up is the installed binary, not the code being worked on (cost a full
    // debugging cycle to spot; see lessons-learnt.txt 2026-07-08).
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            overlay::summon(app);
        }));
    }

    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        hotkeys::handle(app, shortcut);
                    }
                })
                .build(),
        )
        // The --autostart arg marks boot launches so setup below can skip the
        // initial summon (see autostart.rs for the enable/disable policy).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OverlayStateHandle::default())
        .manage(ForegroundGeneration::default())
        .manage(updater::PendingUpdate::default())
        .manage(updater::UpdatedNotice::default())
        .invoke_handler(tauri::generate_handler![
            current_overlay_state,
            esc_pressed,
            set_voice_active,
            set_panel_variant,
            set_draft_card_open,
            set_onboarding_step,
            pill_activated,
            minimize_to_pill,
            set_session_cached,
            summon,
            point_at,
            cancel_pointing,
            updater::install_update,
            updater::pending_update_version,
            updater::just_updated_version,
            read_recent_log_lines,
            screenshot::capture_cursor_display_with_geometry
        ])
        .setup(|app| {
            logging::install_panic_hook();

            // tauri.conf.json's `skipTaskbar: true` keeps this off the Windows
            // taskbar but has no macOS equivalent - Accessory is the matching
            // policy there, hiding the Dock icon and Cmd+Tab entry so presence
            // stays tray-icon-only on both platforms.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            app.global_shortcut().register(hotkeys::summon_shortcut())?;
            app.global_shortcut().register(hotkeys::sign_out_shortcut())?;
            app.global_shortcut().register(hotkeys::screen_sight_shortcut())?;

            // Before tray::build so the "Start with Windows" checkbox reads
            // the post-policy state. Release-only: a dev build would register
            // target\debug\aura-desktop.exe into the developer's own Windows
            // startup on every `tauri dev` run.
            if !cfg!(debug_assertions) {
                autostart::apply_startup_policy(app.handle());
            }

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

            // Present right after a user-initiated update restart. The update
            // relaunch reuses the original args, so a boot-launched instance
            // would otherwise come back hidden after the user clicked
            // "Restart now" - the marker overrides the --autostart quiet
            // start below. The caption only claims a version we're actually
            // running: a marker left by a failed install doesn't match.
            let just_updated = updater::take_just_updated_marker(app.handle());
            if just_updated.as_deref() == Some(env!("CARGO_PKG_VERSION")) {
                *app.state::<updater::UpdatedNotice>().0.lock().unwrap_or_else(|e| e.into_inner()) =
                    just_updated.clone();
            }

            // Launched by Windows at login (the autostart entry passes
            // --autostart): stay tray-only instead of popping the panel over
            // whatever the user is signing in to do. Manual launches keep the
            // summon-on-start behavior; the hotkey and tray still summon.
            let is_boot_launch = std::env::args().any(|arg| arg == "--autostart");
            if !is_boot_launch || just_updated.is_some() {
                overlay::summon(app.handle());
            }

            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(updater::run_update_loop(updater_handle));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
