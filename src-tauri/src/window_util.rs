//! Shared construction for the small accessory webviews (status pill,
//! dictation HUD): hidden, transparent, shadowless, always on top, off the
//! taskbar, and never allowed to steal focus from the app the user is in.

use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

/// Builds (or returns the existing) accessory window. Callers must invoke on
/// the main thread; that is where Tauri builds windows on Windows.
pub(crate) fn build_accessory_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    size: LogicalSize<f64>,
    ignore_cursor_events: bool,
) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) {
        log::info!("{label}: reusing window");
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(size.width, size.height)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;

    let _ = window.set_ignore_cursor_events(ignore_cursor_events);
    // Same display-affinity treatment the overlay gets.
    let _ = crate::overlay::exclude_main_window_from_capture(&window);
    apply_no_activate(&window);
    log::info!("{label}: window created");
    Ok(window)
}

/// WS_EX_NOACTIVATE on top of the builder's `focused(false)`: the flag only
/// covers the first show, the style covers every later one. Without it an
/// accessory window would steal focus from the target app (for the dictation
/// HUD that would abort insertion on its own focus check).
#[cfg(windows)]
pub(crate) fn apply_no_activate(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            current | WS_EX_NOACTIVATE.0 as isize,
        );
    }
}

/// macOS has no window style that stops a click from activating the owning
/// application; only an NSPanel carrying `NonactivatingPanel` does. So the
/// equivalent of the ex-style above is a class swap plus that mask, in
/// macos_window.rs. The accessory class also answers NO to `canBecomeKeyWindow`
/// unless its owner grants it for a phase (`set_accessory_key_eligible`):
/// tao's `show()` is `makeKeyAndOrderFront:`, so an always-eligible panel would
/// take key on every show and swallow the keystrokes dictation posts.
#[cfg(target_os = "macos")]
pub(crate) fn apply_no_activate(window: &tauri::WebviewWindow) {
    crate::macos_window::make_non_activating_accessory_panel(window);
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn apply_no_activate(_window: &tauri::WebviewWindow) {}
