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
//!   on click would break every dictation that started from the notch. There
//!   are two panel classes: the overlay's may always become key (its chat
//!   composer types), the accessory windows' only when granted for a phase,
//!   because tao's `show()` is `makeKeyAndOrderFront:` and a non-activating
//!   panel that takes key steals keystrokes without ever looking frontmost.
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

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use log::{error, warn};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{sel, ClassType, MainThreadMarker};
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

/// The one accessory panel (dictation HUD, status pill) currently allowed to
/// answer YES to `canBecomeKeyWindow`, stored as its NSWindow pointer; 0 means
/// none. tao's `set_visible(true)` is `makeKeyAndOrderFront:`, so a panel that
/// is always key-eligible becomes the key window on every show and, being
/// non-activating, does so while the user's app still looks frontmost. For the
/// dictation HUD that meant every CGEvent it posted landed in its own webview.
/// The HUD grants itself here for the two phases with buttons (Recovery,
/// Consent) and revokes otherwise: the macOS twin of toggling WS_EX_NOACTIVATE
/// per phase. A pointer rather than a bool so a status-pill show during a card
/// cannot make the PILL key and strip the card of its buttons.
static KEY_GRANTED_PANEL: AtomicUsize = AtomicUsize::new(0);

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
/// the two have identical instance sizes; that equality is checked in
/// `ensure_panel_class` rather than left to `set_class`'s debug assertion, so a
/// future AppKit that broke it would degrade to an ordinary window with a log
/// line instead of panicking in a debug build.
///
/// The window is swapped to `AuraOverlayPanel`, NOT to a bare `NSPanel`. A
/// borderless panel answers NO to `canBecomeKeyWindow`, so a bare swap leaves
/// every text field in the overlay showing a caret and receiving nothing; see
/// `aura_panel_class`. With the subclass it can take key input, and still does
/// not activate the application to get it. This is the MAIN overlay's variant;
/// accessory windows use `make_non_activating_accessory_panel`, whose key
/// eligibility is phase-gated.
pub fn make_non_activating_panel(window: &WebviewWindow) {
    with_ns_window(window, "make_non_activating_panel", |ns_window, _mtm| {
        if !ensure_panel_class(ns_window) {
            return;
        }
        apply_panel_style(ns_window);
    });
}

/// The accessory variant of `make_non_activating_panel`: same style, but the
/// class is `AuraAccessoryPanel`, so the window can only become key while
/// `set_accessory_key_eligible` says so. `window_util::apply_no_activate` uses
/// this; the main overlay keeps the unconditional class because its chat
/// composer must take keys in every presentation.
pub fn make_non_activating_accessory_panel(window: &WebviewWindow) {
    with_ns_window(window, "make_non_activating_accessory_panel", |ns_window, _mtm| {
        if !ensure_accessory_class(ns_window) {
            return;
        }
        apply_panel_style(ns_window);
    });
}

/// Grants or revokes this accessory panel's right to become key. MUST run
/// before the `window.show()` for the phase, because show is
/// `makeKeyAndOrderFront:` and consults `canBecomeKeyWindow` at that moment.
///
/// Revoking while the panel currently IS key also makes it resign: `orderOut:`
/// is the one public call that does so without closing the window
/// (`resignKeyWindow` must never be invoked directly). With no other
/// key-eligible window in an inactive app, the window server hands keyboard
/// routing back to the frontmost application, which is where the next
/// dictation has to land. Callers re-order the panel front with their own
/// `show()`, which is now a plain orderFront because the panel answers NO.
pub fn set_accessory_key_eligible(window: &WebviewWindow, eligible: bool) {
    with_ns_window(window, "set_accessory_key_eligible", move |ns_window, _mtm| {
        let ptr = ns_window as *const NSWindow as usize;
        if eligible {
            KEY_GRANTED_PANEL.store(ptr, Ordering::SeqCst);
            return;
        }
        let _ = KEY_GRANTED_PANEL.compare_exchange(ptr, 0, Ordering::SeqCst, Ordering::SeqCst);
        if ns_window.isKeyWindow() {
            ns_window.orderOut(None);
        }
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

/// The class the overlay is actually swapped to: an `NSPanel` subclass that
/// forces `canBecomeKeyWindow`.
///
/// Swapping to a BARE `NSPanel` looks right and silently breaks all keyboard
/// input. tao does not hand us a plain `NSWindow`; it hands us its own
/// `TaoWindow` subclass, which overrides `canBecomeKeyWindow`/
/// `canBecomeMainWindow` to return its `focusable` flag. `set_class` throws
/// that override away, and `NSPanel`'s inherited implementation answers the
/// title-bar/resize-bar test, which a `decorations: false` window fails. The
/// result is `canBecomeKeyWindow == NO`, `makeKeyWindow` a no-op, and a chat
/// composer that shows a caret and receives nothing. `NonactivatingPanel` does
/// not help: it governs whether taking keys ACTIVATES the app, not whether the
/// window may become key at all.
///
/// `canBecomeMainWindow` stays NO deliberately. Key without main is what lets
/// the notch take keystrokes while the app the user was working in keeps its
/// foreground, which is the whole point of the non-activating panel.
fn aura_panel_class() -> Option<&'static AnyClass> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        // Raw-pointer receivers rather than references: `MethodImplementation`
        // needs a higher-ranked signature, and `&AnyObject` pins one lifetime.
        extern "C" fn yes(_this: *const AnyObject, _cmd: Sel) -> Bool {
            Bool::YES
        }
        extern "C" fn no(_this: *const AnyObject, _cmd: Sel) -> Bool {
            Bool::NO
        }
        // Already registered means a previous call won; reuse it rather than
        // failing, since `new` returns None for a name collision too.
        let Some(mut builder) = ClassBuilder::new(c"AuraOverlayPanel", NSPanel::class()) else {
            return AnyClass::get(c"AuraOverlayPanel");
        };
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                yes as extern "C" fn(*const AnyObject, Sel) -> Bool,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                no as extern "C" fn(*const AnyObject, Sel) -> Bool,
            );
        }
        Some(builder.register())
    })
}

/// The class the accessory windows (dictation HUD, status pill) are swapped
/// to: a SUBCLASS of `AuraOverlayPanel` whose `canBecomeKeyWindow` is gated
/// through `KEY_GRANTED_PANEL` instead of unconditional.
///
/// It has to be a subclass, not a sibling: `reassert_panel_style` runs
/// `ensure_panel_class` on the HUD after every phase change, and its
/// `is_kind_of` check would swap a sibling straight back to the overlay class.
/// Adds no ivars, so the instance-size guard in `ensure_class` still holds.
fn aura_accessory_class() -> Option<&'static AnyClass> {
    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        extern "C" fn key_if_granted(this: *const AnyObject, _cmd: Sel) -> Bool {
            Bool::new(KEY_GRANTED_PANEL.load(Ordering::SeqCst) == this as usize)
        }
        let parent = aura_panel_class()?;
        let Some(mut builder) = ClassBuilder::new(c"AuraAccessoryPanel", parent) else {
            return AnyClass::get(c"AuraAccessoryPanel");
        };
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                key_if_granted as extern "C" fn(*const AnyObject, Sel) -> Bool,
            );
        }
        Some(builder.register())
    })
}

/// Swaps the object's class to the panel subclass if it is not already one.
/// Returns whether the window can be treated as a panel afterwards.
fn ensure_panel_class(ns_window: &NSWindow) -> bool {
    ensure_class(ns_window, aura_panel_class(), "AuraOverlayPanel")
}

/// The accessory twin. An `AuraOverlayPanel` window would be swapped, but
/// nothing ever calls this on the main window.
fn ensure_accessory_class(ns_window: &NSWindow) -> bool {
    ensure_class(ns_window, aura_accessory_class(), "AuraAccessoryPanel")
}

/// Swaps the object's class to `wanted` unless it already is one (or a
/// subclass of one). Returns whether the window can be treated as a panel.
fn ensure_class(ns_window: &NSWindow, wanted: Option<&'static AnyClass>, name: &str) -> bool {
    let Some(panel_class) = wanted else {
        warn!("macos_window: could not register {name}, leaving the window as an ordinary NSWindow");
        return false;
    };
    let object: &AnyObject = unsafe { &*((ns_window as *const NSWindow) as *const AnyObject) };
    let current: &AnyClass = object.class();
    if is_kind_of(current, panel_class) {
        return true;
    }
    // The subclass adds no ivars, so this compares equal for the same reason
    // NSWindow and NSPanel do. It stays as the guard against a future AppKit
    // that grows NSPanel, but note what it CANNOT catch: tao's subclass packs
    // its flag into existing padding, so TaoWindow measures the same as
    // NSWindow and the swap that discards its overrides looks harmless here.
    // That is why the overrides are re-declared above rather than relied upon.
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
    let current = ns_window.styleMask();
    let mask = current | NSWindowStyleMask::NonactivatingPanel;
    // Only write when it actually changed. Opening the chat runs overlay::apply
    // three times (initial slot height, the measured height, then the resize
    // observer), and every needless setStyleMask is a chance to disturb focus
    // for no gain.
    if mask != current {
        ns_window.setStyleMask(mask);
        // tao never calls setStyleMask bare, and its comment says why: "If we
        // don't do this, key handling will break (at least until the window is
        // clicked again)". Changing the mask rebuilds the frame view and drops
        // whatever was first responder, which here is the WKWebView holding the
        // chat composer. Restoring it is what keeps typing alive across the
        // slot resizes above.
        restore_first_responder(ns_window);
    }
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

/// Points the window's first responder back at its content view, which is the
/// WKWebView hosting the overlay. Mirrors what tao does after every style-mask
/// write (`platform_impl/macos/util/async.rs`).
fn restore_first_responder(ns_window: &NSWindow) {
    let Some(view) = ns_window.contentView() else {
        return;
    };
    ns_window.makeFirstResponder(Some(&view));
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
/// the app the user was working in must keep its foreground status. For an
/// accessory panel this only succeeds after `set_accessory_key_eligible(true)`;
/// the dictation HUD grants that in its pre-show step.
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
