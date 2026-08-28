//! Actionable Windows toasts. The JS broker (desktopNotifications.ts) owns
//! ALL policy (dedup, toast-once, permission, privacy-safe generic copy) and
//! calls `show_actionable_toast` only after a toast is already allowed. This
//! module's job is the part the notification plugin cannot do on Windows:
//! deliver the toast under the app's identity into Action Center and route a
//! CLICK back into the app - open/focus the dashboard window and hand the
//! `{notificationId, action}` payload to its webview.
//!
//! Delivery of the click payload has two paths, because the click itself may
//! be what opens the dashboard window:
//! - live: `emit("notification-toast-activated", ...)` for an already-open
//!   webview,
//! - handoff: the payload is parked in `PendingToastActivation` and the
//!   dashboard's TopBar collects it via `take_pending_toast_activation` on
//!   mount, covering the emit-before-listener race.
//!
//! Scope: in-process activation only. A click while the app is not running is
//! inert (no COM activator); acceptable because Aura is a persistent tray app.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastActivation {
    pub notification_id: String,
    pub action: Option<String>,
}

/// Managed state parking unclaimed toast clicks until a dashboard listener
/// atomically claims them. Bounded so abandoned activations cannot grow for
/// the lifetime of the tray process.
#[derive(Default)]
pub struct PendingToastActivation(Mutex<VecDeque<ToastActivation>>);

const MAX_PENDING_ACTIVATIONS: usize = 16;

/// Shows a Windows toast whose click opens the dashboard to the responsible
/// action. Errors bubble to JS, which falls back to the plugin's plain toast
/// so delivery is never lost.
#[tauri::command]
pub async fn show_actionable_toast(
    app: AppHandle,
    notification_id: String,
    action: Option<String>,
    title: String,
    body: String,
    silent: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Sound, Toast};

        let activation = ToastActivation {
            notification_id,
            action,
        };
        let handle = app.clone();
        // The AUMID must match the installed Start Menu shortcut's for the
        // toast to carry Aura's name and icon; dev runs without a registered
        // shortcut fall back to a generic identity but still deliver.
        Toast::new(&app.config().identifier)
            .title(&title)
            .text1(&body)
            // Settings > System > Sound. `None` silences the toast; the toast
            // itself still appears in Action Center, only the chime is dropped.
            .sound(if silent { None } else { Some(Sound::Default) })
            .on_activated(move |_arg| {
                let payload = activation.clone();
                let app = handle.clone();
                // The WinRT Activated event fires on a COM thread; window
                // creation must happen on the main thread.
                let _ = handle.run_on_main_thread(move || {
                    on_toast_clicked(&app, payload);
                });
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, notification_id, action, title, body, silent);
        Err("actionable toasts are Windows-only".into())
    }
}

#[cfg(windows)]
fn on_toast_clicked(app: &AppHandle, payload: ToastActivation) {
    use tauri::{Emitter, Manager};

    if let Some(state) = app.try_state::<PendingToastActivation>() {
        if let Ok(mut pending) = state.0.lock() {
            pending.retain(|item| item.notification_id != payload.notification_id);
            pending.push_back(payload.clone());
            while pending.len() > MAX_PENDING_ACTIVATIONS {
                pending.pop_front();
            }
        }
    }
    if let Err(e) = crate::dashboard::open_dashboard_window(app) {
        log::error!("toast activation: open dashboard failed: {e}");
    }
    // Live path for an already-loaded dashboard. A freshly-created webview
    // can miss this emit and collects the parked payload on mount instead.
    if let Err(e) = app.emit_to(
        crate::dashboard::DASHBOARD_WINDOW,
        crate::events::NOTIFICATION_TOAST_ACTIVATED,
        payload,
    ) {
        log::error!("toast activation: emit failed: {e}");
    }
}

/// Atomically claims one parked toast click (see module docs). A live listener
/// passes its notification id; startup draining passes null for the oldest
/// queued activation. Returns null when no matching activation is pending.
#[tauri::command]
pub fn take_pending_toast_activation(
    state: tauri::State<'_, PendingToastActivation>,
    notification_id: Option<String>,
) -> Option<ToastActivation> {
    let mut pending = state.0.lock().ok()?;
    match notification_id {
        Some(id) => pending
            .iter()
            .position(|item| item.notification_id == id)
            .and_then(|index| pending.remove(index)),
        None => pending.pop_front(),
    }
}
