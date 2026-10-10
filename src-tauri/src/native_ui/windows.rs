//! The Windows backend: UI Automation to read and press, SendInput to type,
//! click and scroll where no pattern does it.
//!
//! Every UI Automation object lives on one MTA worker thread, `aura-operator-ui`,
//! which owns the `IUIAutomation` instance and the live elements behind the refs
//! of the last snapshot. Callers hand it a job and wait with a timeout; a late
//! reply is dropped, never acted on.
//!
//! Three rules, all from the plan's section 3:
//!
//! 1. **A real click beats a pattern** when the element is on screen. UIA's
//!    Invoke can block until whatever it opened is dismissed (a Save As dialog
//!    opened from Invoke hangs the caller), and a click is what the app was
//!    built for. Patterns are the route for elements the mouse cannot reach.
//! 2. **Never click through Aura.** The point is hit-tested first; if anything
//!    other than the target's own process is on top (the notch, a toast, another
//!    window), the click is refused rather than landing on the wrong thing.
//! 3. **Passwords never enter this process.** A password element's value is not
//!    read, the same rule as `uia/tree.rs`.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use log::{error, warn};
use windows::core::{BOOL, BSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationCondition,
    IUIAutomationElement, IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
    IUIAutomationScrollItemPattern, IUIAutomationScrollPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationValuePattern,
    ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
    TreeScope_Children, UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId,
    UIA_ExpandCollapsePatternId, UIA_HasKeyboardFocusPropertyId, UIA_InvokePatternId,
    UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId,
    UIA_NamePropertyId, UIA_ProcessIdPropertyId, UIA_ScrollItemPatternId, UIA_ScrollPatternId,
    UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetLastInputInfo, SendInput, INPUT, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, LASTINPUTINFO, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END,
    VK_ESCAPE, VK_F1, VK_HOME, VK_INSERT, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR,
    VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetSystemMetrics, GetWindow, GetWindowLongW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, ShowWindow, GWL_EXSTYLE, GW_OWNER, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE, WS_EX_TOOLWINDOW,
};

use super::{RefInfo, Snapshot, UiAction, WindowEntry};
use crate::uia::tree::{is_own_process, role_name};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(6);
const ACT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bounds on one window walk. Breadth beyond these needs read_more or a
/// scroll, not a bigger prompt.
const MAX_NODES: usize = 1500;
const MAX_DEPTH: usize = 40;
const WALK_BUDGET: Duration = Duration::from_millis(3000);
const MAX_REFS: usize = 600;
const MAX_NAME_CHARS: usize = 120;
const MAX_VALUE_CHARS: usize = 200;
const MAX_INDENT: usize = 8;
const MAX_WINDOWS: usize = 30;

/// Roles that get a ref: the things a person clicks, types into or picks.
const INTERACTIVE: &[&str] = &[
    "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem",
    "RadioButton", "SplitButton", "TabItem", "TreeItem", "Slider", "Spinner", "DataItem",
    "HeaderItem", "Document",
];
/// Roles whose value is worth one extra cross-process read.
const VALUE_ROLES: &[&str] = &["Edit", "ComboBox", "Spinner", "Slider", "Document"];
/// Containers that carry no meaning of their own when unnamed: their children
/// are printed at the container's indent instead.
const SILENT_CONTAINERS: &[&str] = &["Pane", "Group", "Custom", "Window"];

enum Job {
    Snapshot {
        hwnd: isize,
        reply: Sender<Result<Snapshot, String>>,
    },
    Act {
        hwnd: isize,
        action: UiAction,
        reply: Sender<Result<String, String>>,
    },
}

/// Managed as Tauri state.
pub struct NativeUi {
    jobs: Mutex<Sender<Job>>,
}

impl NativeUi {
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        if let Err(e) = std::thread::Builder::new()
            .name("aura-operator-ui".into())
            .spawn(move || worker_loop(rx))
        {
            error!("native_ui: worker thread failed to start: {e}");
        }
        Self { jobs: Mutex::new(tx) }
    }

    fn send(&self, job: Job) -> bool {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.send(job).is_ok()
    }

    /// Walks the window. Blocking; call from a worker thread.
    pub fn snapshot(&self, hwnd: isize) -> Result<Snapshot, String> {
        let (reply, rx) = mpsc::channel();
        if !self.send(Job::Snapshot { hwnd, reply }) {
            return Err("ui_unavailable".to_string());
        }
        rx.recv_timeout(SNAPSHOT_TIMEOUT)
            .map_err(|_| "ui_timeout".to_string())?
    }

    /// Runs one action against a ref of the LAST snapshot of `hwnd`. Returns
    /// how it was done ("invoke", "click", "typed", ...) for the trace.
    pub fn act(&self, hwnd: isize, action: UiAction) -> Result<String, String> {
        let (reply, rx) = mpsc::channel();
        if !self.send(Job::Act { hwnd, action, reply }) {
            return Err("ui_unavailable".to_string());
        }
        rx.recv_timeout(ACT_TIMEOUT)
            .map_err(|_| "ui_timeout".to_string())?
    }
}

fn worker_loop(jobs: Receiver<Job>) {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };

    // SAFETY: this thread owns its apartment for its whole life.
    if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
        warn!("native_ui: COM initialization failed");
        return;
    }
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(instance) => instance,
            Err(e) => {
                warn!("native_ui: CUIAutomation unavailable ({})", e.code().0);
                unsafe { CoUninitialize() };
                return;
            }
        };
    // The live elements behind the refs of the last snapshot, and the window
    // they came from. Replaced wholesale by every snapshot.
    let mut refs: HashMap<String, IUIAutomationElement> = HashMap::new();
    let mut refs_hwnd: isize = 0;

    while let Ok(job) = jobs.recv() {
        match job {
            Job::Snapshot { hwnd, reply } => {
                let result = walk(&automation, hwnd);
                match result {
                    Ok((snapshot, elements)) => {
                        refs = elements;
                        refs_hwnd = hwnd;
                        let _ = reply.send(Ok(snapshot));
                    }
                    Err(e) => {
                        refs.clear();
                        refs_hwnd = 0;
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Job::Act { hwnd, action, reply } => {
                let result = if refs_hwnd != hwnd && !matches!(action, UiAction::Key { .. }) {
                    Err("stale_snapshot".to_string())
                } else {
                    act(&automation, hwnd, &refs, action)
                };
                let _ = reply.send(result);
            }
        }
    }
    unsafe { CoUninitialize() };
}

// ---------------------------------------------------------------------------
// Reading

fn cache_request(automation: &IUIAutomation) -> Result<IUIAutomationCacheRequest, String> {
    let cache = unsafe { automation.CreateCacheRequest() }.map_err(|e| e.to_string())?;
    for property in [
        UIA_NamePropertyId,
        UIA_ControlTypePropertyId,
        UIA_BoundingRectanglePropertyId,
        UIA_IsPasswordPropertyId,
        UIA_IsEnabledPropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_HasKeyboardFocusPropertyId,
        UIA_ProcessIdPropertyId,
    ] {
        let _ = unsafe { cache.AddProperty(property) };
    }
    Ok(cache)
}

/// One cached batch read of an element's children: a single cross-process call
/// for the children and every property above, instead of one per property.
fn children(
    element: &IUIAutomationElement,
    condition: &IUIAutomationCondition,
    cache: &IUIAutomationCacheRequest,
) -> Vec<IUIAutomationElement> {
    let Ok(array) = (unsafe { element.FindAllBuildCache(TreeScope_Children, condition, cache) }) else {
        return Vec::new();
    };
    let count = unsafe { array.Length() }.unwrap_or(0);
    (0..count)
        .filter_map(|index| unsafe { array.GetElement(index) }.ok())
        .collect()
}

fn clip(raw: &str, max: usize) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max).collect();
    out.push_str("...");
    out
}

fn bstr(value: windows::core::Result<BSTR>) -> String {
    value.map(|raw| raw.to_string()).unwrap_or_default()
}

fn read_value(element: &IUIAutomationElement) -> Option<String> {
    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }.ok()?;
    // Second guard, as in uia/tree.rs: a control can expose a value pattern and
    // still be protected.
    if unsafe { element.CurrentIsPassword() }.map(|f| f.as_bool()).unwrap_or(false) {
        return None;
    }
    let text = bstr(unsafe { pattern.CurrentValue() });
    (!text.is_empty()).then(|| clip(&text, MAX_VALUE_CHARS))
}

type Walked = (Snapshot, HashMap<String, IUIAutomationElement>);

fn walk(automation: &IUIAutomation, hwnd: isize) -> Result<Walked, String> {
    if !window_exists(hwnd) {
        return Err("window_gone".to_string());
    }
    let root = unsafe { automation.ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void)) }
        .map_err(|_| "window_unreadable".to_string())?;
    if is_own_process(&root) {
        return Err("own_window".to_string());
    }
    let condition = unsafe { automation.ControlViewCondition() }.map_err(|e| e.to_string())?;
    let cache = cache_request(automation)?;
    let deadline = Instant::now() + WALK_BUDGET;
    let own_pid = std::process::id() as i32;

    let mut snapshot = Snapshot::default();
    let mut elements = HashMap::new();
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("Window \"{}\"", clip(&window_title(hwnd), MAX_NAME_CHARS)));

    // Depth-first, children pushed in reverse so the output reads top to
    // bottom in the order the app lays them out.
    let mut stack: Vec<(IUIAutomationElement, usize, usize)> = children(&root, &condition, &cache)
        .into_iter()
        .rev()
        .map(|element| (element, 1usize, 1usize))
        .collect();
    while let Some((element, depth, indent)) = stack.pop() {
        if snapshot.nodes >= MAX_NODES || Instant::now() >= deadline {
            snapshot.cut_short = true;
            break;
        }
        snapshot.nodes += 1;
        if unsafe { element.CachedProcessId() }.map(|pid| pid == own_pid).unwrap_or(false) {
            continue;
        }
        let role = unsafe { element.CachedControlType() }
            .map(|value| role_name(value.0))
            .unwrap_or("Custom");
        let name = clip(&bstr(unsafe { element.CachedName() }), MAX_NAME_CHARS);
        let password = unsafe { element.CachedIsPassword() }.map(|f| f.as_bool()).unwrap_or(false);
        let enabled = unsafe { element.CachedIsEnabled() }.map(|f| f.as_bool()).unwrap_or(true);
        let offscreen = unsafe { element.CachedIsOffscreen() }.map(|f| f.as_bool()).unwrap_or(false);
        let focused = unsafe { element.CachedHasKeyboardFocus() }.map(|f| f.as_bool()).unwrap_or(false);

        let silent = SILENT_CONTAINERS.contains(&role) && name.is_empty();
        let skip_line = silent || (role == "Text" && name.is_empty()) || role == "Separator";
        let child_indent = if skip_line { indent } else { indent + 1 };

        if !skip_line {
            let mut line = "  ".repeat(indent.min(MAX_INDENT));
            if INTERACTIVE.contains(&role) && elements.len() < MAX_REFS {
                let ref_id = format!("e{}", elements.len() + 1);
                line.push_str(&format!("[{ref_id}] "));
                snapshot.refs.insert(
                    ref_id.clone(),
                    RefInfo { role: role.to_string(), name: name.clone(), password },
                );
                elements.insert(ref_id, element.clone());
            }
            line.push_str(role);
            if !name.is_empty() {
                line.push_str(&format!(" \"{name}\""));
            }
            if password {
                line.push_str(" (password)");
            } else if VALUE_ROLES.contains(&role) {
                if let Some(value) = read_value(&element) {
                    line.push_str(&format!(" = \"{value}\""));
                }
            }
            if !enabled {
                line.push_str(" (disabled)");
            }
            if focused {
                line.push_str(" (focused)");
            }
            if offscreen {
                line.push_str(" (offscreen)");
            }
            lines.push(line);
        }

        if depth < MAX_DEPTH {
            for child in children(&element, &condition, &cache).into_iter().rev() {
                stack.push((child, depth + 1, child_indent));
            }
        } else {
            snapshot.cut_short = true;
        }
    }
    if snapshot.cut_short {
        lines.push("(The window has more than this view could read. Scroll, or open the part you need.)".to_string());
    }
    snapshot.text = lines.join("\n");
    Ok((snapshot, elements))
}

// ---------------------------------------------------------------------------
// Acting

fn act(
    automation: &IUIAutomation,
    hwnd: isize,
    refs: &HashMap<String, IUIAutomationElement>,
    action: UiAction,
) -> Result<String, String> {
    if !window_exists(hwnd) {
        return Err("window_gone".to_string());
    }
    if is_protected(hwnd) {
        // An elevated app drops our input and refuses our patterns without
        // any error. Say so rather than pretend.
        return Err("elevated".to_string());
    }
    match action {
        UiAction::Click { ref_id } => {
            let element = refs.get(&ref_id).ok_or("ref_not_found")?;
            click(automation, hwnd, element)
        }
        UiAction::Type { ref_id, text, submit } => {
            let element = refs.get(&ref_id).ok_or("ref_not_found")?;
            type_into(automation, hwnd, element, &text, submit)
        }
        UiAction::Key { chord } => {
            if !bring_to_front(hwnd) {
                return Err("not_foreground".to_string());
            }
            send_chord(&chord)?;
            Ok("key".to_string())
        }
        UiAction::Scroll { ref_id, down } => {
            let element = match ref_id {
                Some(id) => Some(refs.get(&id).ok_or("ref_not_found")?.clone()),
                None => None,
            };
            scroll(automation, hwnd, element.as_ref(), down)
        }
    }
}

/// Screen point at the centre of an on-screen element, or None.
fn on_screen_center(element: &IUIAutomationElement) -> Option<POINT> {
    if unsafe { element.CurrentIsOffscreen() }.map(|f| f.as_bool()).unwrap_or(true) {
        return None;
    }
    let rect = unsafe { element.CurrentBoundingRectangle() }.ok()?;
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(POINT { x: rect.left + width / 2, y: rect.top + height / 2 })
}

/// Whether a click at `point` would land in the target's own process.
fn point_belongs_to(automation: &IUIAutomation, point: POINT, hwnd: isize) -> bool {
    let Ok(hit) = (unsafe { automation.ElementFromPoint(point) }) else {
        return false;
    };
    let hit_pid = unsafe { hit.CurrentProcessId() }.unwrap_or(0) as u32;
    hit_pid != 0 && hit_pid == window_pid(hwnd)
}

fn click(automation: &IUIAutomation, hwnd: isize, element: &IUIAutomationElement) -> Result<String, String> {
    if unsafe { element.CurrentIsOffscreen() }.map(|f| f.as_bool()).unwrap_or(false) {
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
        } {
            let _ = unsafe { pattern.ScrollIntoView() };
            std::thread::sleep(Duration::from_millis(150));
        }
    }
    if let Some(point) = on_screen_center(element) {
        if !bring_to_front(hwnd) {
            return Err("not_foreground".to_string());
        }
        if !point_belongs_to(automation, point, hwnd) {
            return Err("covered".to_string());
        }
        mouse_click(point)?;
        return Ok("click".to_string());
    }
    // Off screen and could not be scrolled into view: the patterns are the
    // only way to reach it.
    if let Ok(pattern) = unsafe { element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) } {
        unsafe { pattern.Invoke() }.map_err(|e| e.to_string())?;
        return Ok("invoke".to_string());
    }
    if let Ok(pattern) = unsafe { element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) } {
        unsafe { pattern.Toggle() }.map_err(|e| e.to_string())?;
        return Ok("toggle".to_string());
    }
    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
    } {
        unsafe { pattern.Select() }.map_err(|e| e.to_string())?;
        return Ok("select".to_string());
    }
    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
    } {
        let expanded = unsafe { pattern.CurrentExpandCollapseState() }.map(|s| s.0 == 1).unwrap_or(false);
        if expanded {
            unsafe { pattern.Collapse() }.map_err(|e| e.to_string())?;
        } else {
            unsafe { pattern.Expand() }.map_err(|e| e.to_string())?;
        }
        return Ok("expand".to_string());
    }
    Err("not_clickable".to_string())
}

fn type_into(
    automation: &IUIAutomation,
    hwnd: isize,
    element: &IUIAutomationElement,
    text: &str,
    submit: bool,
) -> Result<String, String> {
    if unsafe { element.CurrentIsPassword() }.map(|f| f.as_bool()).unwrap_or(false) {
        return Err("password_field".to_string());
    }
    if !bring_to_front(hwnd) {
        return Err("not_foreground".to_string());
    }
    let _ = unsafe { element.SetFocus() };
    std::thread::sleep(Duration::from_millis(80));
    let has_focus = unsafe { element.CurrentHasKeyboardFocus() }.map(|f| f.as_bool()).unwrap_or(false);
    if !has_focus {
        // Some controls ignore SetFocus; a click puts the caret there.
        let point = on_screen_center(element).ok_or("not_focusable")?;
        if !point_belongs_to(automation, point, hwnd) {
            return Err("covered".to_string());
        }
        mouse_click(point)?;
        std::thread::sleep(Duration::from_millis(80));
    }
    // Typing goes through dictation's insert path: the same chunking that
    // Electron apps and terminals accept, the same held-modifier and
    // elevated-target guards.
    match crate::dictation::insert::insert_text_here(text) {
        crate::dictation::insert::InsertOutcome::Inserted => {}
        crate::dictation::insert::InsertOutcome::KeysHeld => return Err("keys_held".to_string()),
        crate::dictation::insert::InsertOutcome::Blocked => return Err("elevated".to_string()),
        _ => return Err("not_typed".to_string()),
    }
    if submit {
        send_chord("enter")?;
    }
    Ok("typed".to_string())
}

fn scroll(
    automation: &IUIAutomation,
    hwnd: isize,
    element: Option<&IUIAutomationElement>,
    down: bool,
) -> Result<String, String> {
    let amount = if down { ScrollAmount_LargeIncrement } else { ScrollAmount_LargeDecrement };
    // The nearest scrollable thing: the element itself or one of its parents,
    // or the window when no ref was given.
    let start = match element {
        Some(element) => Some(element.clone()),
        None => unsafe { automation.ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void)) }.ok(),
    };
    if let (Some(start), Ok(walker)) = (start.clone(), unsafe { automation.ControlViewWalker() }) {
        let mut current = Some(start);
        for _ in 0..10 {
            let Some(candidate) = current.take() else { break };
            if let Ok(pattern) = unsafe {
                candidate.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
            } {
                if unsafe { pattern.Scroll(ScrollAmount_NoAmount, amount) }.is_ok() {
                    return Ok("scroll_pattern".to_string());
                }
            }
            current = unsafe { walker.GetParentElement(&candidate) }.ok();
        }
    }
    // No scroll pattern anywhere up the tree: the wheel, over the element or
    // the middle of the window.
    let point = start
        .as_ref()
        .and_then(on_screen_center)
        .or_else(|| window_rect(hwnd).map(|(x, y, w, h)| POINT { x: x + w as i32 / 2, y: y + h as i32 / 2 }))
        .ok_or("not_scrollable")?;
    if !bring_to_front(hwnd) {
        return Err("not_foreground".to_string());
    }
    if !point_belongs_to(automation, point, hwnd) {
        return Err("covered".to_string());
    }
    mouse_move(point)?;
    send_inputs(&[mouse_input(0, 0, if down { -360i32 as u32 } else { 360 }, MOUSEEVENTF_WHEEL.0)])?;
    Ok("wheel".to_string())
}

// ---------------------------------------------------------------------------
// Input injection

fn send_inputs(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, core::mem::size_of::<INPUT>() as i32) };
    if sent == 0 {
        return Err("input_blocked".to_string());
    }
    Ok(())
}

fn mouse_input(dx: i32, dy: i32, data: u32, flags: u32) -> INPUT {
    let mut input = INPUT { r#type: INPUT_MOUSE, ..Default::default() };
    input.Anonymous.mi = MOUSEINPUT {
        dx,
        dy,
        mouseData: data,
        dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS(flags),
        time: 0,
        dwExtraInfo: 0,
    };
    input
}

/// Absolute coordinates over the whole virtual desktop, so a window on a
/// second monitor at a different DPI lands where UIA said it is.
fn normalized(point: POINT) -> (i32, i32) {
    let (left, top, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
        )
    };
    let x = ((point.x - left) as i64 * 65535 / (width - 1) as i64) as i32;
    let y = ((point.y - top) as i64 * 65535 / (height - 1) as i64) as i32;
    (x, y)
}

fn mouse_move(point: POINT) -> Result<(), String> {
    let (x, y) = normalized(point);
    send_inputs(&[mouse_input(x, y, 0, MOUSEEVENTF_MOVE.0 | MOUSEEVENTF_ABSOLUTE.0 | MOUSEEVENTF_VIRTUALDESK.0)])
}

fn mouse_click(point: POINT) -> Result<(), String> {
    let (x, y) = normalized(point);
    let absolute = MOUSEEVENTF_ABSOLUTE.0 | MOUSEEVENTF_VIRTUALDESK.0;
    send_inputs(&[
        mouse_input(x, y, 0, MOUSEEVENTF_MOVE.0 | absolute),
        mouse_input(x, y, 0, MOUSEEVENTF_LEFTDOWN.0 | absolute),
        mouse_input(x, y, 0, MOUSEEVENTF_LEFTUP.0 | absolute),
    ])
}

fn key_input(key: VIRTUAL_KEY, up: bool, extended: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let mut input = INPUT { r#type: INPUT_KEYBOARD, ..Default::default() };
    input.Anonymous.ki = KEYBDINPUT { wVk: key, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 };
    input
}

/// "ctrl+shift+s", "enter", "alt+f4", "pagedown". Unknown names are refused,
/// never guessed.
pub fn parse_chord(chord: &str) -> Result<Vec<(VIRTUAL_KEY, bool)>, String> {
    let mut keys = Vec::new();
    for part in chord.split('+').map(|p| p.trim().to_ascii_lowercase()).filter(|p| !p.is_empty()) {
        let key = match part.as_str() {
            "ctrl" | "control" => (VK_CONTROL, false),
            "shift" => (VK_SHIFT, false),
            "alt" => (VK_MENU, false),
            "win" | "windows" | "meta" | "cmd" => (VK_LWIN, false),
            "enter" | "return" => (VK_RETURN, false),
            "esc" | "escape" => (VK_ESCAPE, false),
            "tab" => (VK_TAB, false),
            "space" => (VK_SPACE, false),
            "backspace" => (VK_BACK, false),
            "delete" | "del" => (VK_DELETE, true),
            "insert" => (VK_INSERT, true),
            "up" => (VK_UP, true),
            "down" => (VK_DOWN, true),
            "left" => (VK_LEFT, true),
            "right" => (VK_RIGHT, true),
            "home" => (VK_HOME, true),
            "end" => (VK_END, true),
            "pageup" => (VK_PRIOR, true),
            "pagedown" => (VK_NEXT, true),
            other => {
                if let Some(n) = other.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
                    if (1..=12).contains(&n) {
                        (VIRTUAL_KEY(VK_F1.0 + n - 1), false)
                    } else {
                        return Err("unknown_key".to_string());
                    }
                } else if other.len() == 1 && other.as_bytes()[0].is_ascii_alphanumeric() {
                    (VIRTUAL_KEY(other.as_bytes()[0].to_ascii_uppercase() as u16), false)
                } else {
                    return Err("unknown_key".to_string());
                }
            }
        };
        keys.push(key);
    }
    if keys.is_empty() || keys.len() > 4 {
        return Err("unknown_key".to_string());
    }
    Ok(keys)
}

fn send_chord(chord: &str) -> Result<(), String> {
    let keys = parse_chord(chord)?;
    let mut inputs: Vec<INPUT> = keys.iter().map(|(key, ext)| key_input(*key, false, *ext)).collect();
    inputs.extend(keys.iter().rev().map(|(key, ext)| key_input(*key, true, *ext)));
    send_inputs(&inputs)
}

// ---------------------------------------------------------------------------
// Windows (plain Win32, callable from any thread)

pub fn window_exists(hwnd: isize) -> bool {
    hwnd != 0 && unsafe { IsWindow(Some(HWND(hwnd as *mut core::ffi::c_void))) }.as_bool()
}

pub fn window_title(hwnd: isize) -> String {
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; len as usize + 1];
    let read = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..read.max(0) as usize])
}

pub fn window_pid(hwnd: isize) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut core::ffi::c_void), Some(&mut pid)) };
    pid
}

/// The executable stem ("spotify", "code"), the name the guard reasons about.
pub fn app_stem(hwnd: isize) -> String {
    crate::system_control::process_stem_for_window(hwnd).unwrap_or_default()
}

/// Physical-pixel window bounds: x, y, width, height.
pub fn window_rect(hwnd: isize) -> Option<(i32, i32, u32, u32)> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(HWND(hwnd as *mut core::ffi::c_void), &mut rect) }.ok()?;
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    (w > 0 && h > 0).then_some((rect.left, rect.top, w as u32, h as u32))
}

/// True when this process cannot even open the window's process for a limited
/// query: from a non-elevated Aura that means it runs at a higher integrity
/// level, and every input and pattern call into it is silently dropped.
pub fn is_protected(hwnd: isize) -> bool {
    let pid = window_pid(hwnd);
    if pid == 0 {
        return false;
    }
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => {
            let _ = unsafe { CloseHandle(handle) };
            false
        }
        Err(_) => true,
    }
}

pub fn foreground_window() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

/// Restores a minimised window and brings it forward. True when it is the
/// foreground window afterwards (or another window of the same process is,
/// such as its own dialog).
pub fn bring_to_front(hwnd: isize) -> bool {
    let window = HWND(hwnd as *mut core::ffi::c_void);
    if unsafe { IsIconic(window) }.as_bool() {
        let _ = unsafe { ShowWindow(window, SW_RESTORE) };
        std::thread::sleep(Duration::from_millis(150));
    }
    let foreground = foreground_window();
    if foreground == hwnd || (foreground != 0 && window_pid(foreground) == window_pid(hwnd)) {
        return true;
    }
    crate::win_focus::set_foreground_raw(hwnd);
    std::thread::sleep(Duration::from_millis(120));
    let foreground = foreground_window();
    foreground == hwnd || (foreground != 0 && window_pid(foreground) == window_pid(hwnd))
}

/// Tick of the last real or injected input anywhere on the session. The loop
/// compares it across a model call, during which Aura itself injects nothing,
/// so a change means the person touched the mouse or keyboard.
pub fn last_input_tick() -> u32 {
    let mut info = LASTINPUTINFO { cbSize: core::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        info.dwTime
    } else {
        0
    }
}

/// The top-level windows a person would call "open": visible, titled, not a
/// tool window, not owned by another window, and not Aura's own.
pub fn list_windows() -> Vec<WindowEntry> {
    collect_windows(0)
}

/// `list_windows`, plus the owned windows (a Settings window, a dialog) of the
/// process with this pid. An app's own secondary windows are usually owned by
/// its main one, so without this the Operator never sees what its click opened.
pub fn list_windows_with_owned(pid: u32) -> Vec<WindowEntry> {
    collect_windows(pid)
}

fn collect_windows(owned_of_pid: u32) -> Vec<WindowEntry> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<isize>);
        out.push(hwnd.0 as isize);
        BOOL(1)
    }
    let mut handles: Vec<isize> = Vec::new();
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<isize> as isize)) };
    let own_pid = std::process::id();
    let mut out = Vec::new();
    for raw in handles {
        if out.len() >= MAX_WINDOWS {
            break;
        }
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            continue;
        }
        let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.map(|owner| !owner.0.is_null()).unwrap_or(false);
        if owned && (owned_of_pid == 0 || window_pid(raw) != owned_of_pid) {
            continue;
        }
        let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
        if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
            continue;
        }
        if window_pid(raw) == own_pid {
            continue;
        }
        let title = window_title(raw);
        if title.trim().is_empty() || window_rect(raw).is_none() {
            continue;
        }
        out.push(WindowEntry { hwnd: raw, app: app_stem(raw), title });
    }
    out
}
