mod audio_ducking;
mod auth_cache;
mod autostart;
mod chat_cache;
mod connector_oauth;
mod dashboard;
mod dictation;
mod entitlement;
mod guide;
mod hotkeys;
mod logging;
mod meeting;
mod overlay;
mod redact;
mod saved_images;
mod screenshot;
#[cfg(windows)]
mod screenshot_store;
mod security;
mod sentry_setup;
mod system_control;
mod toast;
mod tray;
mod uia;
mod updater;
mod voice_toggle_key;
mod win_focus;

use log::{error, info};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use overlay::{NotchEdge, OnboardingStep, OverlaySnapshot, OverlayStateHandle, PanelVariant};
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
    // Security first (leaf lock, disarms screen sight on a true->false
    // transition), then the overlay's own window bookkeeping.
    security::note_voice_active(&app, active);
    overlay::set_voice_active(&app, active);
}

#[tauri::command]
fn set_panel_variant(app: AppHandle, variant: PanelVariant) {
    overlay::set_panel_variant(&app, variant);
}

/// Sets the below-bar slot's extra height (or clears it with null). React
/// (OverlayRoot) resolves which surface - draft, catch-up, calendar agenda, or
/// kebab menu - wins the single slot and passes its fixed height here.
#[tauri::command]
fn set_slot_height(app: AppHandle, height: Option<f64>) {
    overlay::set_slot_height(&app, height);
}

#[tauri::command]
fn set_chat_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.global_shortcut();
    if enabled {
        if manager.is_registered(hotkeys::chat_shortcut()) {
            return Ok(());
        }
        manager
            .register(hotkeys::chat_shortcut())
            .map_err(|e| format!("failed to register chat hotkey: {e}"))
    } else {
        if !manager.is_registered(hotkeys::chat_shortcut()) {
            return Ok(());
        }
        manager
            .unregister(hotkeys::chat_shortcut())
            .map_err(|e| format!("failed to unregister chat hotkey: {e}"))
    }
}

/// "Show the Aura bar at all times". Pushed from the dashboard's Settings page
/// on load and on every change; overlay.rs decides what "hidden" resolves to.
#[tauri::command]
fn set_always_show_bar(app: AppHandle, enabled: bool) {
    overlay::set_always_show_bar(&app, enabled);
}

#[tauri::command]
fn set_onboarding_step(app: AppHandle, step: OnboardingStep) {
    overlay::set_onboarding_step(&app, step);
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
fn summon_bar(app: AppHandle) -> Result<(), String> {
    overlay::summon_bar(&app)
}

#[tauri::command]
fn summon_chat(app: AppHandle) -> Result<(), String> {
    overlay::summon_chat(&app)
}

/// Shows the panel-sized onboarding surface for the post-sign-in tail (hotkey
/// tour + live demo), re-revealing the window that sign-in hid.
#[tauri::command]
fn summon_onboarding_panel(app: AppHandle) -> Result<(), String> {
    overlay::summon_onboarding_panel(&app)
}

/// Opens or focuses the in-app dashboard window (also bound to Ctrl+Alt+D).
#[tauri::command]
fn open_dashboard_window(app: AppHandle) -> Result<(), String> {
    dashboard::open_dashboard_window(&app)
}

#[tauri::command]
fn open_dashboard_route(app: AppHandle, route: String) -> Result<(), String> {
    dashboard::open_dashboard_route(&app, Some(&route))
}

fn should_summon_on_start<I, S>(args: I, just_updated: bool) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let is_boot_launch = args.into_iter().any(|arg| arg.as_ref() == "--autostart");
    !is_boot_launch || just_updated
}

#[tauri::command]
fn dismiss_bar(app: AppHandle) {
    overlay::dismiss_bar(&app);
}

/// Guarded natively: pointing takes the window fullscreen and click-through,
/// and its only legitimate trigger is the agent answering a frame this app
/// itself captured - so it requires a signed-in session, a live voice call,
/// and at least one authorized capture this session (security.rs). The check
/// completes (and its lock drops) before overlay::point_at touches any
/// window API.
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
) -> Result<(), String> {
    security::authorize(&app, security::Operation::PointAt)?;
    overlay::point_at(
        &app, target_x, target_y, monitor_x, monitor_y, monitor_w, monitor_h, &label,
    );
    Ok(())
}

#[tauri::command]
fn cancel_pointing(app: AppHandle) {
    overlay::cancel_pointing(&app);
}

/// Docks the notch to a screen edge (top/bottom/left/right) and persists it.
#[tauri::command]
fn set_notch_edge(app: AppHandle, edge: NotchEdge) {
    overlay::set_notch_edge(&app, edge);
}

/// Long-press drag-to-dock, step 1: takes the active display fullscreen and
/// cursor-live so the frontend can render the edge-picker drag surface.
#[tauri::command]
fn begin_notch_move(app: AppHandle) -> Result<(), String> {
    overlay::begin_notch_move(&app)
}

/// Step 2: release on `edge` docks the notch there and restores the bar.
#[tauri::command]
fn commit_notch_move(app: AppHandle, edge: NotchEdge) {
    overlay::commit_notch_move(&app, edge);
}

/// Step 2 (cancel/Escape): restores the bar at its current edge unchanged.
#[tauri::command]
fn cancel_notch_move(app: AppHandle) {
    overlay::cancel_notch_move(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Held for the whole process lifetime (run() doesn't return until the app
    // exits) - dropping it early would flush and disable the client.
    let _sentry_guard = sentry_setup::init();

    let mut builder = tauri::Builder::default();

    // Release-only: dev and installed builds share the same com.aura.desktop
    // single-instance key, and autostart keeps the installed app alive in the
    // tray. Registering this in a debug build makes `npm run tauri dev`
    // forward its launch to that old instance and exit - the panel that pops
    // up is the installed binary, not the code being worked on (cost a full
    // debugging cycle to spot; see lessons-learnt.txt 2026-07-08).
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|arg| arg.starts_with("aura://")) {
                return;
            }
            // Relaunching the installed app brings the full app window forward,
            // not the overlay notch; fall back to the overlay if it can't build.
            if let Err(e) = dashboard::open_dashboard_window(app) {
                error!("single-instance: open dashboard failed: {e}; falling back to overlay");
                overlay::summon(app);
            }
        }));
    }

    builder = builder
        .plugin(logging::plugin())
        .plugin(tauri_plugin_deep_link::init());

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
        .plugin(tauri_plugin_notification::init())
        .manage(OverlayStateHandle::default())
        .manage(security::SecurityHandle::default())
        .manage(guide::GuideRuntimeHandle::default())
        .manage(guide::GuideCaptureHandle::default())
        .manage(guide::GuideToggleHandle::default())
        .manage(ForegroundGeneration::default())
        .manage(updater::PendingUpdate::default())
        .manage(updater::UpdatedNotice::default())
        .manage(meeting::MeetingRuntimeLease::acquire())
        .manage(meeting::MeetingCaptureHandle::default())
        .manage(meeting::JoinWatchHandle::default())
        .manage(toast::PendingToastActivation::default())
        .manage(screenshot::ChatCaptureHandle::default())
        .invoke_handler(tauri::generate_handler![
            current_overlay_state,
            esc_pressed,
            set_voice_active,
            set_panel_variant,
            set_slot_height,
            set_chat_enabled,
            tray::set_tray_unread,
            set_onboarding_step,
            set_session_cached,
            summon,
            summon_bar,
            summon_chat,
            summon_onboarding_panel,
            open_dashboard_window,
            open_dashboard_route,
            connector_oauth::take_connector_oauth_completion,
            dismiss_bar,
            point_at,
            cancel_pointing,
            set_notch_edge,
            begin_notch_move,
            commit_notch_move,
            cancel_notch_move,
            system_control::run_desktop_capability,
            security::set_auth_state,
            security::toggle_screen_sight_armed,
            security::screen_sight_armed,
            guide::arm_guide,
            guide::disarm_guide,
            guide::guide_armed_state,
            guide::capture_guide_frame,
            guide::guide_observation_state,
            guide::commit_guide_frame,
            guide::ack_guide_response,
            updater::install_update,
            updater::pending_update_version,
            updater::just_updated_version,
            logging::read_recent_log_lines,
            screenshot::capture_cursor_display_with_geometry,
            screenshot::capture_turn_screen_with_geometry,
            screenshot::take_chat_capture,
            screenshot::refresh_chat_capture,
            screenshot::discard_chat_capture,
            entitlement::cache_entitlement,
            entitlement::cached_entitlement,
            entitlement::clear_entitlement_cache,
            chat_cache::chat_cache_replace,
            chat_cache::chat_cache_load,
            chat_cache::chat_cache_clear,
            saved_images::cache_saved_image,
            saved_images::read_saved_image,
            saved_images::prune_saved_images,
            meeting::start_meeting_capture,
            meeting::meeting_runtime_status,
            meeting::stop_meeting_capture,
            meeting::capture_status,
            meeting::queue_snapshot,
            meeting::read_segment,
            meeting::claim_next_upload_job,
            meeting::claim_next_completion_job,
            meeting::resolve_upload_job,
            meeting::resolve_completion_job,
            meeting::fail_queue_job,
            meeting::retry_capture_jobs,
            meeting::local_recordings,
            meeting::export_local_recording,
            meeting::delete_local_recording,
            meeting::start_join_watch,
            meeting::stop_join_watch,
            meeting::debug_force_join,
            voice_toggle_key::voice_toggle_key_status,
            dictation::dictation_status,
            dictation::dictation_consent_state,
            dictation::dictation_set_consent,
            dictation::dictation_set_credential,
            dictation::dictation_clear_credential,
            dictation::dictation_hud_state,
            dictation::dictation_set_hud_hovered,
            dictation::dictation_vocabulary,
            dictation::dictation_add_vocabulary,
            dictation::dictation_record_correction,
            dictation::trace_commands::dictation_trace_settings,
            dictation::trace_commands::dictation_set_trace_settings,
            dictation::trace_commands::dictation_trace_summary,
            dictation::trace_commands::dictation_trace_list,
            dictation::trace_commands::dictation_trace_audio,
            dictation::trace_commands::dictation_delete_trace,
            dictation::trace_commands::dictation_delete_all_traces,
            dictation::trace_commands::dictation_export_traces,
            dictation::trace_commands::dictation_share_pump_state,
            dictation::trace_commands::dictation_claim_trace_upload,
            dictation::trace_commands::dictation_trace_upload_audio,
            dictation::trace_commands::dictation_resolve_trace_upload,
            dictation::trace_commands::dictation_fail_trace_upload,
            dictation::trace_commands::dictation_claim_trace_deletion,
            dictation::trace_commands::dictation_resolve_trace_deletion,
            dictation::trace_commands::dictation_pause_trace_uploads,
            uia::capture_structured_context,
            toast::show_actionable_toast,
            toast::take_pending_toast_activation,
            autostart::autostart_enabled,
            autostart::set_autostart_enabled,
            set_always_show_bar,
            dashboard::set_dashboard_in_taskbar
        ])
        .setup(|app| {
            logging::install_panic_hook();
            app.manage(connector_oauth::ConnectorOAuthState::default());

            if let Ok(Some(urls)) = app.deep_link().get_current() {
                connector_oauth::ingest_urls(app.handle(), &urls);
            }
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                connector_oauth::ingest_urls(&deep_link_handle, &event.urls());
            });

            // The low-level keyboard callback only forwards an isolated
            // configured-key tap into a channel. Event emission happens outside
            // the hook on Tauri's async runtime, and the managed handle asks
            // the hook thread to unhook when the process exits.
            // Started BEFORE the keyboard listener so the hook's first chord
            // edge already has a worker to signal. Owns the "aura-dictation"
            // thread: WASAPI capture, the wait on the transcription socket,
            // and the SendInput burst all live there, never on the message
            // pump.
            app.manage(dictation::start(app.handle().clone()));

            // Opt-in training-trace capture. Started unconditionally because
            // starting it is cheap - it reads one small JSON file and then
            // parks on an empty channel - and because the settings page has to
            // be able to switch it on without a restart. With the setting off
            // (the default) it never reads a text field, never creates a
            // directory, and never receives a message.
            #[cfg(windows)]
            app.manage(dictation::trace::start(app.handle().clone()));

            // Owns the COM apartment for UI Automation. Started once here so
            // the first turn does not pay for CoCreateInstance, and so
            // dictation's insert path has a worker to ask before it types.
            app.manage(uia::UiaWorker::start());

            app.manage(voice_toggle_key::start(app.handle().clone()));

            // tauri.conf.json's `skipTaskbar: true` keeps this off the Windows
            // taskbar but has no macOS equivalent - Accessory is the matching
            // policy there, hiding the Dock icon and Cmd+Tab entry so presence
            // stays tray-icon-only on both platforms.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();

            // A failed registration means some other process already holds
            // the hotkey system-wide - during local dev that's the installed
            // release build sitting in the desktop tray (it autostarts), for an end
            // user it's any other app that claimed the combo first. Either
            // way it must not abort setup: the app is still fully usable
            // through the tray, while panicking here kills it at every boot
            // with nothing on screen (this exact panic reached Sentry from a real install).
            for (name, shortcut) in [
                ("summon", hotkeys::summon_shortcut()),
                ("open-dashboard", hotkeys::open_dashboard_shortcut()),
                ("sign-out", hotkeys::sign_out_shortcut()),
                ("screen-sight", hotkeys::screen_sight_shortcut()),
                ("guide-mode", hotkeys::guide_mode_shortcut()),
                ("output-mute", hotkeys::output_mute_shortcut()),
            ] {
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    error!("hotkeys: failed to register {name} ({e}) - another process holds it; continuing without it");
                    if !cfg!(debug_assertions) {
                        sentry::capture_message(
                            &format!("hotkeys: failed to register {name}: {e}"),
                            sentry::Level::Error,
                        );
                    }
                } else {
                    info!("hotkeys: registered {name}");
                }
            }

            // Before tray::build so the "Start with Windows" checkbox reads
            // the post-policy state. Release-only: a dev build would register
            // target\debug\aura-desktop.exe into the developer's own Windows
            // startup on every `tauri dev` run.
            if !cfg!(debug_assertions) {
                autostart::apply_startup_policy(app.handle());
            }

            // Repairs a previous run that was killed between muting other apps
            // for a dictation and unmuting them again. Cheap no-op when the
            // recorded list is empty, which is the normal case.
            audio_ducking::restore_stale_on_start(app.handle());

            tray::build(app.handle())?;

            if let Some(window) = app.get_webview_window("main") {
                overlay::exclude_main_window_from_capture(&window)?;
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

            // Pre-seed summon routing from the last-known auth state while
            // keeping the native window hidden until an explicit summon.
            let initial_variant = if auth_cache::has_cached_session(app.handle()) {
                PanelVariant::Companion
            } else {
                PanelVariant::Setup
            };
            overlay::load_persisted_center(app.handle());
            overlay::set_panel_variant(app.handle(), initial_variant);
            dictation::show_hud(app.handle());

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

            // A direct install or explicit app launch opens the full app window:
            // onboarding for a new/signed-out user, Home for a returning one. The
            // overlay notch stays a tray/Ctrl+Alt+B companion. Windows boot
            // launches stay tray-only so Aura does not interrupt login. If the
            // window fails to build, fall back to the overlay so the user is never
            // left with no surface at all.
            if should_summon_on_start(std::env::args(), just_updated.is_some()) {
                if let Err(e) = dashboard::open_dashboard_window(app.handle()) {
                    error!("failed to open dashboard window on start: {e}; falling back to overlay");
                    overlay::summon(app.handle());
                }
            }

            // Drop upload-queue entries whose captures went unsent past the
            // retention window (fs work, runs on a blocking thread inside).
            meeting::startup_maintenance(app.handle());
            // v0.3.0 briefly persisted every spoken-turn frame as plaintext.
            // Turn frames are memory-only now, so remove that legacy directory.
            screenshot::startup_maintenance(app.handle());
            #[cfg(windows)]
            screenshot_store::startup_maintenance(app.handle());
            // Owns the one background thread that encrypts and writes per-turn
            // captures, so the voice response never waits on disk.
            #[cfg(windows)]
            app.manage(screenshot_store::PersistenceQueue::start(app.handle()));
            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(updater::run_update_loop(updater_handle));

            info!("Aura Desktop is ready and running in the tray.");
            info!(
                "Double-tap {} to start voice, or left-click the Aura tray icon to show the bar.",
                voice_toggle_key::configured_key_label()
            );

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Give queued per-turn captures a brief chance to reach disk before
            // the process goes away. Best effort by design: a frame still in the
            // queue at exit is lost, which is the durability trade the queue
            // makes so a spoken turn never blocks on encryption.
            #[cfg(windows)]
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(queue) = app.try_state::<screenshot_store::PersistenceQueue>() {
                    queue.drain_for_shutdown();
                }
            }
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::should_summon_on_start;

    #[test]
    fn manual_launch_summons_the_app() {
        assert!(should_summon_on_start(["aura-desktop.exe"], false));
    }

    #[test]
    fn windows_autostart_stays_hidden() {
        assert!(!should_summon_on_start(
            ["aura-desktop.exe", "--autostart"],
            false,
        ));
    }

    #[test]
    fn update_restart_summons_even_with_autostart_args() {
        assert!(should_summon_on_start(
            ["aura-desktop.exe", "--autostart"],
            true,
        ));
    }
}
