//! macOS Accessibility reads: the AX half of what UI Automation does on
//! Windows.
//!
//! Three callers, one API surface: dictation asks what the focused control is
//! before typing into it (`uia/focus_ax.rs`), the dictation HUD asks where the
//! target window sits so it docks on the right display, and meeting join
//! detection asks for an app's window titles.
//!
//! Two rules hold for everything here, both inherited from `uia/focus.rs`:
//!
//! 1. **Roles and geometry only, never values.** The focused field is exactly
//!    where a half-written message lives. Nothing in this file reads
//!    `AXValue`'s contents; `is_attribute_settable` asks whether it COULD be
//!    written, which is a boolean about the control, not its text.
//! 2. **Every failure fails open.** A denied Accessibility grant, an
//!    unresponsive app, an unfamiliar role - all of them resolve to "don't
//!    know", and the caller's "don't know" branch is the permissive one.
//!
//! The messaging timeout is the one thing with no Windows analogue and it is
//! not optional. AX calls block on the TARGET application's run loop, so a
//! hung app would otherwise hold the dictation worker thread forever. UI
//! Automation never had this failure mode because it answers from its own
//! apartment thread.

#![cfg(target_os = "macos")]

use objc2_application_services::AXUIElement;
use objc2_core_foundation::{CFArray, CFRetained, CFString, CFType};

/// How long any single AX read may block on the target application. Chosen
/// against the dictation worker's 250ms probe tick: a slower answer than that
/// is worth less than the tick it would delay, and "don't know" types anyway.
const MESSAGING_TIMEOUT_SECONDS: f32 = 0.25;

/// Attribute names. These are `CFSTR()` macros in the C headers rather than
/// exported symbols, so there is nothing to link against and the literals are
/// the binding.
const ATTR_FOCUSED_UI_ELEMENT: &str = "AXFocusedUIElement";
const ATTR_FOCUSED_WINDOW: &str = "AXFocusedWindow";
const ATTR_ROLE: &str = "AXRole";
const ATTR_SUBROLE: &str = "AXSubrole";
const ATTR_VALUE: &str = "AXValue";
const ATTR_WINDOWS: &str = "AXWindows";
const ATTR_TITLE: &str = "AXTitle";

/// Whether this process holds the Accessibility grant. With `prompt` set,
/// macOS shows its own "open System Settings" dialog once per process; without
/// it the check is silent, which is what a status poll wants.
pub fn is_trusted(prompt: bool) -> bool {
    use objc2_application_services::{kAXTrustedCheckOptionPrompt, AXIsProcessTrustedWithOptions};
    use objc2_core_foundation::{
        kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFBoolean, CFDictionary,
    };

    if !prompt {
        // Passing no options is the silent form.
        return unsafe { AXIsProcessTrustedWithOptions(None) };
    }

    let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
    // Both of these are process-lifetime CF singletons, so the dictionary is
    // never holding a pointer that can go away underneath it. The CFType
    // callbacks are passed anyway because that is what makes the dictionary a
    // normal retaining CF collection rather than one holding bare pointers.
    let value: &CFBoolean = CFBoolean::new(true);
    let mut keys: [*const std::ffi::c_void; 1] = [(key as *const CFString).cast()];
    let mut values: [*const std::ffi::c_void; 1] = [(value as *const CFBoolean).cast()];
    let options = unsafe {
        CFDictionary::new(
            None,
            keys.as_mut_ptr(),
            values.as_mut_ptr(),
            1,
            &raw const kCFTypeDictionaryKeyCallBacks,
            &raw const kCFTypeDictionaryValueCallBacks,
        )
    };
    unsafe { AXIsProcessTrustedWithOptions(options.as_deref()) }
}

/// Reads one attribute off an element, with the messaging timeout applied.
/// `None` covers every failure the AX API can report, which is what keeps the
/// callers' fail-open behaviour honest.
fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let key = CFString::from_str(name);
    let mut raw: *const CFType = std::ptr::null();
    let status = unsafe {
        element.copy_attribute_value(&key, std::ptr::NonNull::from(&mut raw))
    };
    if status.0 != 0 || raw.is_null() {
        return None;
    }
    // copy_attribute_value follows the Copy rule, so we own this reference.
    Some(unsafe { CFRetained::from_raw(std::ptr::NonNull::new(raw as *mut CFType)?) })
}

fn string_attribute(element: &AXUIElement, name: &str) -> Option<String> {
    let value = attribute(element, name)?;
    let text = value.downcast_ref::<CFString>()?;
    Some(text.to_string())
}

fn element_attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<AXUIElement>> {
    let value = attribute(element, name)?;
    value.downcast::<AXUIElement>().ok()
}

fn apply_timeout(element: &AXUIElement) {
    let _ = unsafe { element.set_messaging_timeout(MESSAGING_TIMEOUT_SECONDS) };
}

/// What dictation needs to know about whatever currently holds keyboard focus.
/// Everything here is a description of the CONTROL; none of it is its content.
pub struct FocusedElement {
    pub role: String,
    pub subrole: String,
    /// Whether `AXValue` is writable. `None` when the element does not answer,
    /// which fails open. This is the AX analogue of UIA's ValuePattern
    /// `CurrentIsReadOnly`, and the same one question is asked of it.
    pub value_settable: Option<bool>,
    pub pid: i32,
}

/// The system-wide focused element, or `None` when nothing has focus or AX is
/// unavailable. Blocking and bounded by the messaging timeout; call from a
/// worker thread.
pub fn focused_element() -> Option<FocusedElement> {
    let system = unsafe { AXUIElement::new_system_wide() };
    apply_timeout(&system);

    let focused = element_attribute(&system, ATTR_FOCUSED_UI_ELEMENT)?;
    apply_timeout(&focused);

    let role = string_attribute(&focused, ATTR_ROLE)?;
    let subrole = string_attribute(&focused, ATTR_SUBROLE).unwrap_or_default();

    let mut settable: u8 = 0;
    let key = CFString::from_str(ATTR_VALUE);
    let status =
        unsafe { focused.is_attribute_settable(&key, std::ptr::NonNull::from(&mut settable)) };
    let value_settable = if status.0 == 0 {
        Some(settable != 0)
    } else {
        None
    };

    let mut pid: libc::pid_t = 0;
    let pid = if unsafe { focused.pid(std::ptr::NonNull::from(&mut pid)) }.0 == 0 {
        pid
    } else {
        0
    };

    Some(FocusedElement {
        role,
        subrole,
        value_settable,
        pid,
    })
}

/// Centre of the focused window of the given process, in Cocoa screen points.
/// Used only to pick which display a surface docks to, so an application that
/// refuses the read simply falls back to the primary monitor.
pub fn focused_window_center(pid: i32) -> Option<(f64, f64)> {
    use objc2_application_services::{AXValue, AXValueType};
    use objc2_core_foundation::{CGPoint, CGSize};

    let app = unsafe { AXUIElement::new_application(pid) };
    apply_timeout(&app);
    let window = element_attribute(&app, ATTR_FOCUSED_WINDOW)?;
    apply_timeout(&window);

    // AXPosition and AXSize come back boxed in an AXValue rather than as plain
    // CF numbers, so each needs unwrapping into its C struct.
    let read_point = |name: &str| -> Option<CGPoint> {
        let value = attribute(&window, name)?;
        let boxed = value.downcast_ref::<AXValue>()?;
        let mut point = CGPoint::new(0.0, 0.0);
        let ok = unsafe {
            boxed.value(
                AXValueType::CGPoint,
                std::ptr::NonNull::from(&mut point).cast(),
            )
        };
        ok.then_some(point)
    };
    let read_size = |name: &str| -> Option<CGSize> {
        let value = attribute(&window, name)?;
        let boxed = value.downcast_ref::<AXValue>()?;
        let mut size = CGSize::new(0.0, 0.0);
        let ok = unsafe {
            boxed.value(
                AXValueType::CGSize,
                std::ptr::NonNull::from(&mut size).cast(),
            )
        };
        ok.then_some(size)
    };

    let position = read_point("AXPosition")?;
    let size = read_size("AXSize")?;
    Some((
        position.x + size.width / 2.0,
        position.y + size.height / 2.0,
    ))
}

/// Every window title the given process exposes. Empty when the Accessibility
/// grant is missing, which is the safe direction for join detection: no titles
/// means no match, never a wrong match.
pub fn window_titles(pid: i32) -> Vec<String> {
    let app = unsafe { AXUIElement::new_application(pid) };
    apply_timeout(&app);

    let Some(windows) = attribute(&app, ATTR_WINDOWS) else {
        return Vec::new();
    };
    let Some(windows) = windows.downcast_ref::<CFArray>() else {
        return Vec::new();
    };

    let mut titles = Vec::new();
    for index in 0..windows.count() {
        // Read through the raw accessor rather than the typed `get`: an
        // untyped CFArray's element type is opaque to the bindings, and these
        // are AXUIElements. CFArrayGetValueAtIndex follows the Get rule, so
        // the pointer is borrowed for the length of this loop body only and
        // must not be released here.
        let raw = unsafe { windows.value_at_index(index) };
        if raw.is_null() {
            continue;
        }
        let window: &AXUIElement = unsafe { &*(raw as *const AXUIElement) };
        if let Some(title) = string_attribute(window, ATTR_TITLE) {
            if !title.is_empty() {
                titles.push(title);
            }
        }
    }
    titles
}
