//! macOS window behaviour: the AppKit half of the platform seams that Win32
//! fills on Windows.
//!
//! Three unrelated Windows tricks all land here because they are all "reach
//! past Tauri to the native window handle":
//!
//! - **Non-activating panel.** `WS_EX_NOACTIVATE` has no NSWindow equivalent.
//!   The only way a macOS window can be clicked without activating its
//!   application is to be an `NSPanel` carrying `NSWindowStyleMaskNonactivating
//!   Panel`. Tauri builds plain `NSWindow`s, so the class is swapped in place
//!   after creation. That matters far beyond tidiness: dictation aborts its own
//!   insert when the foreground app changes, so an overlay that activates Aura
//!   on click would break every dictation that started from the notch.
//! - **Work area.** `GetMonitorInfoW`'s `rcWork` is `NSScreen.visibleFrame`.
//!   Without it a Top-docked notch renders under the menu bar and a
//!   Bottom-docked one under the Dock.
//! - **Capture exclusion.** `WDA_EXCLUDEFROMCAPTURE` is `NSWindow.sharingType
//!   = .none`, so Screen Sight and Guide Mode do not photograph the overlay
//!   they were triggered from.
//!
//! Threading: every AppKit call below must run on the main thread. The mutating
//! entry points hop there themselves via `run_on_main_thread`, so callers do
//! not have to care. `work_area_insets` cannot hop (it has to return a value to
//! a caller that is usually on Tauri's async runtime), so it reads a cached
//! snapshot that `refresh_screen_cache` fills from the main thread.

#![cfg(target_os = "macos")]

use std::sync::Mutex;

use log::{error, warn};
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{ClassType, MainThreadMarker};
use objc2_app_kit::{
    NSPanel, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType,
    NSWindowStyleMask,
};
use tauri::{LogicalPosition, LogicalSize, WebviewWindow};

/// One screen's full and visible rectangles, already converted out of Cocoa's
/// bottom-left origin into the top-left logical space Tauri reports monitors
/// in. Stored rather than queried live because the callers that need it run on
/// Tauri's async runtime, and NSScreen is main-thread-only.
#[derive(Clone, Copy)]
struct ScreenRect {
    frame: (f64, f64, f64, f64),
    visible: (f64, f64, f64, f64),
}

static SCREENS: Mutex<Vec<ScreenRect>> = Mutex::new(Vec::new());

/// Runs `body` against the window's `NSWindow`, on the main thread, hopping
/// there first if we are not already on it. Silently does nothing when the
/// window has no native handle yet, which is the normal state between
/// `WebviewWindowBuilder::build` returning and the window being realized.
fn with_ns_window<F>(window: &WebviewWindow, what: &'static str, body: F)
where
    F: FnOnce(&NSWindow, MainThreadMarker) + Send + 'static,
{
    let cloned = window.clone();
    let run = move || {
        let Some(mtm) = MainThreadMarker::new() else {
            error!("macos_window::{what}: not on the main thread after the hop");
            return;
        };
        let ptr = match cloned.ns_window() {
            Ok(ptr) => ptr,
            Err(e) => {
                error!("macos_window::{what}: failed to get NSWindow: {e}");
                return;
            }
        };
        if ptr.is_null() {
            return;
        }
        // Borrowed, never retained: the window belongs to Tauri, and taking
        // ownership here would over-release it at the end of this scope.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        body(ns_window, mtm);
    };

    if MainThreadMarker::new().is_some() {
        run();
    } else if let Err(e) = window.run_on_main_thread(run) {
        error!("macos_window::{what}: failed to dispatch to the main thread: {e}");
    }
}

/// Turns a Tauri-built window into a non-activating panel: clickable, always
/// visible above other apps, present on every Space, and never the reason the
/// user's frontmost application loses focus.
///
/// The class swap is what makes the style mask mean anything - AppKit ignores
/// `NonactivatingPanel` on a window whose class is not an NSPanel. It is safe
/// because NSPanel declares no instance variables of its own over NSWindow, so
/// the two have identical instance sizes; that equality is checked here rather
/// than left to `set_class`'s debug assertion, so a future AppKit that broke it
/// would degrade to an ordinary window with a log line instead of panicking in
/// a debug build.
///
/// A non-activating panel can still become the KEY window, so the Setup panel's
/// sign-in fields keep receiving keystrokes. It just does not activate the
/// application to get them.
pub fn make_non_activating_panel(window: &WebviewWindow) {
    with_ns_window(window, "make_non_activating_panel", |ns_window, _mtm| {
        if !ensure_panel_class(ns_window) {
            return;
        }
        apply_panel_style(ns_window);
    });
}

/// Re-applies the panel style after Tauri window operations.
///
/// This is not belt-and-braces. tao caches its own window flags and rewrites
/// the native style from that cache on `set_ignore_cursor_events`, `show` and
/// level changes - the same hazard `dictation/hud.rs` documents for
/// `GWL_EXSTYLE` on Windows. `overlay::apply_result` performs exactly that
/// sequence on every presentation change, so anything set once at startup is
/// gone by the first transition.
pub fn reassert_panel_style(window: &WebviewWindow) {
    with_ns_window(window, "reassert_panel_style", |ns_window, _mtm| {
        if !ensure_panel_class(ns_window) {
            return;
        }
        apply_panel_style(ns_window);
    });
}

/// Swaps the object's class to NSPanel if it is not already one. Returns
/// whether the window can be treated as a panel afterwards.
fn ensure_panel_class(ns_window: &NSWindow) -> bool {
    let panel_class = NSPanel::class();
    let object: &AnyObject = unsafe { &*((ns_window as *const NSWindow) as *const AnyObject) };
    let current: &AnyClass = object.class();
    if is_kind_of(current, panel_class) {
        return true;
    }
    if current.instance_size() != panel_class.instance_size() {
        warn!(
            "macos_window: NSWindow and NSPanel instance sizes differ ({} vs {}), \
             leaving the window as an ordinary NSWindow",
            current.instance_size(),
            panel_class.instance_size(),
        );
        return false;
    }
    unsafe { AnyObject::set_class(object, panel_class) };
    true
}

/// Walks the superclass chain, the equivalent of `-isKindOfClass:` against a
/// class rather than an instance.
fn is_kind_of(mut current: &AnyClass, wanted: &AnyClass) -> bool {
    loop {
        if std::ptr::eq(current, wanted) {
            return true;
        }
        match current.superclass() {
            Some(parent) => current = parent,
            None => return false,
        }
    }
}

fn apply_panel_style(ns_window: &NSWindow) {
    let mask = ns_window.styleMask() | NSWindowStyleMask::NonactivatingPanel;
    ns_window.setStyleMask(mask);
    // Above normal windows and full-screen apps, matching the always-on-top
    // the Windows side gets from the builder.
    ns_window.setLevel(NSStatusWindowLevel);
    ns_window.setCollectionBehavior(
        ns_window.collectionBehavior()
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary,
    );
    // Panels hide themselves when their app deactivates by default, which for
    // an always-on-top companion means it vanishes the moment the user clicks
    // anything else - the exact opposite of what it is for.
    ns_window.setHidesOnDeactivate(false);
}

/// The `WDA_EXCLUDEFROMCAPTURE` analogue: when `shares` is false the window's
/// content is omitted from screen captures and screen sharing, so Screen Sight
/// and Guide Mode do not photograph the overlay that triggered them.
pub fn set_shares_screen_content(window: &WebviewWindow, shares: bool) {
    let sharing = if shares {
        NSWindowSharingType::ReadOnly
    } else {
        NSWindowSharingType::None
    };
    with_ns_window(window, "set_shares_screen_content", move |ns_window, _mtm| {
        ns_window.setSharingType(sharing);
    });
}

/// Brings the window forward and gives it keyboard focus WITHOUT activating
/// Aura. This is the hotkey/chat summon path: the notch is a passive HUD and
/// the app the user was working in must keep its foreground status.
pub fn make_key_without_activating(window: &WebviewWindow) {
    with_ns_window(window, "make_key_without_activating", |ns_window, _mtm| {
        ns_window.orderFrontRegardless();
        ns_window.makeKeyWindow();
    });
}

/// Full activation, Setup panel only. Sign-in is the one overlay surface the
/// user is deliberately switching INTO, so here taking the foreground is the
/// correct behaviour rather than theft.
pub fn activate_and_focus(window: &WebviewWindow) {
    with_ns_window(window, "activate_and_focus", |ns_window, mtm| {
        let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
        app.activate();
        ns_window.makeKeyAndOrderFront(None);
    });
}

/// Re-reads every screen's frame and visible frame into the cache. Must be
/// called on the main thread; `refresh_screen_cache_async` is the version that
/// hops there for callers that cannot.
fn refresh_screen_cache_now(mtm: MainThreadMarker) {
    let screens = objc2_app_kit::NSScreen::screens(mtm);
    // Cocoa measures from the bottom-left of the "zero" screen (always index 0)
    // with y growing upward; Tauri reports monitors from the top-left of that
    // same screen with y growing downward. Every rectangle below is flipped
    // through this one height.
    let Some(zero) = screens.iter().next() else {
        return;
    };
    let origin_height = zero.frame().size.height;

    let flip = |rect: objc2_foundation::NSRect| -> (f64, f64, f64, f64) {
        (
            rect.origin.x,
            origin_height - rect.origin.y - rect.size.height,
            rect.size.width,
            rect.size.height,
        )
    };

    let mapped: Vec<ScreenRect> = screens
        .iter()
        .map(|screen| ScreenRect {
            frame: flip(screen.frame()),
            visible: flip(screen.visibleFrame()),
        })
        .collect();

    *SCREENS.lock().unwrap_or_else(|e| e.into_inner()) = mapped;
}

/// Refreshes the screen cache, hopping to the main thread when necessary.
///
/// Callers on the async runtime get the PREVIOUS snapshot for the call they are
/// currently making and a fresh one for the next. That one-transition staleness
/// only shows up in the moment a display is plugged in or the Dock moves, and
/// it corrects itself on the very next overlay transition, which is also when
/// it would first be visible.
pub fn refresh_screen_cache(window: &WebviewWindow) {
    if let Some(mtm) = MainThreadMarker::new() {
        refresh_screen_cache_now(mtm);
        return;
    }
    if let Err(e) = window.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            refresh_screen_cache_now(mtm);
        }
    }) {
        error!("macos_window::refresh_screen_cache: failed to dispatch: {e}");
    }
}

/// The primary display's backing scale factor, for the one caller that has a
/// value in AppKit points and needs it in the physical pixels Tauri's
/// `monitor_from_point` expects. Falls back to 1.0 rather than guessing.
pub fn primary_backing_scale() -> f64 {
    let Some(mtm) = MainThreadMarker::new() else {
        return 1.0;
    };
    objc2_app_kit::NSScreen::mainScreen(mtm)
        .map(|screen| screen.backingScaleFactor())
        .unwrap_or(1.0)
}

/// The menu bar / Dock insets of the display containing `full_pos`, as
/// (left, top, right, bottom) in logical pixels. `None` when the cache has not
/// been filled yet or no screen matches, which leaves the caller on full
/// display bounds - the behaviour macOS had before this existed.
pub fn work_area_insets(
    full_pos: LogicalPosition<f64>,
    full_size: LogicalSize<f64>,
) -> Option<(f64, f64, f64, f64)> {
    // Sample just inside the top-left corner, the same trick the Windows path
    // uses to resolve an HMONITOR, so a display boundary never picks the
    // neighbour.
    let sample_x = full_pos.x + 2.0;
    let sample_y = full_pos.y + 2.0;

    let screens = SCREENS.lock().unwrap_or_else(|e| e.into_inner());
    let screen = screens.iter().find(|screen| {
        let (x, y, w, h) = screen.frame;
        sample_x >= x && sample_x < x + w && sample_y >= y && sample_y < y + h
    })?;

    let (fx, fy, fw, fh) = screen.frame;
    let (vx, vy, vw, vh) = screen.visible;
    let left = (vx - fx).max(0.0);
    let top = (vy - fy).max(0.0);
    let right = ((fx + fw) - (vx + vw)).max(0.0);
    let bottom = ((fy + fh) - (vy + vh)).max(0.0);

    // A screen whose visible frame somehow exceeds its own bounds would produce
    // a larger-than-full work area; refuse rather than move the notch offscreen.
    if left + right >= full_size.width || top + bottom >= full_size.height {
        return None;
    }
    Some((left, top, right, bottom))
}
