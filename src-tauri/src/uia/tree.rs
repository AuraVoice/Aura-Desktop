//! The bounded, redacted UI Automation tree walk.
//!
//! Runs only on the worker thread in `worker.rs`, which owns the COM apartment
//! and the `IUIAutomation` instance - none of these types are `Send`, and none
//! of them may touch Tauri's message-pump thread.
//!
//! Three rules shape everything here:
//!
//! 1. **Every read is bounded.** UI Automation calls cross a process boundary
//!    into an application Aura does not control. An unresponsive app turns an
//!    innocent-looking property read into an arbitrarily long stall on the
//!    voice response path, so node count, depth, text length and total elapsed
//!    time are all capped, and the deadline is rechecked before each node.
//! 2. **Protected content never enters the struct.** A password element's value
//!    is not read at all, rather than read and then filtered. Nothing can leak
//!    what was never fetched.
//! 3. **Aura never reads itself.** Elements owned by this process are skipped,
//!    so the overlay and dashboard cannot appear in their own screen context.

use std::time::Instant;

use sha2::{Digest, Sha256};
use windows::core::BSTR;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Accessibility::{
    IUIAutomation, IUIAutomationElement, IUIAutomationExpandCollapsePattern,
    IUIAutomationSelectionItemPattern, IUIAutomationValuePattern, TreeScope_Children,
    UIA_AutomationIdPropertyId, UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId,
    UIA_ExpandCollapsePatternId, UIA_HasKeyboardFocusPropertyId, UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId, UIA_NamePropertyId,
    UIA_SelectionItemPatternId, UIA_ValuePatternId,
};

use super::contract::{
    clip_text, now_ms, AppIdentity, BoundHit, Quality, QualityReason, StructuredContext, UiNode,
    MAX_ANCESTORS, MAX_DESCENDANTS, MAX_DESCENDANT_DEPTH, MAX_NODES, MAX_SIBLINGS, SCHEMA_VERSION,
};

/// Roles worth paying an extra cross-process pattern query for. Reading the
/// Value/Selection/ExpandCollapse patterns on every node in the tree would
/// multiply the COM round trips for containers that never carry a value.
const VALUE_BEARING_ROLES: &[&str] = &[
    "Edit",
    "Document",
    "ComboBox",
    "Spinner",
    "Slider",
    "Hyperlink",
    "Text",
];
const STATEFUL_ROLES: &[&str] = &[
    "CheckBox",
    "RadioButton",
    "ListItem",
    "TreeItem",
    "MenuItem",
    "TabItem",
    "ComboBox",
    "Tree",
];

/// Budget shared across the whole walk. The caller abandons a late result
/// anyway (see `worker.rs`); this stops the worker itself from staying busy.
pub struct Budget {
    deadline: Instant,
    nodes_remaining: usize,
}

impl Budget {
    pub fn new(deadline: Instant) -> Self {
        Self {
            deadline,
            nodes_remaining: MAX_NODES,
        }
    }

    fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    fn take_node(&mut self) -> bool {
        if self.nodes_remaining == 0 {
            return false;
        }
        self.nodes_remaining -= 1;
        true
    }
}

/// Walks the focused (or pointer) element and its bounded neighbourhood.
///
/// Never returns an error: a failure produces a snapshot whose `quality.reason`
/// explains itself, so the caller always has something to report and always
/// knows to fall back to pixels.
pub fn capture(
    automation: &IUIAutomation,
    turn_context_id: String,
    cursor: POINT,
    guide_armed: bool,
    budget: &mut Budget,
) -> StructuredContext {
    let started = Instant::now();
    let (process, window_id, window_title) = crate::guide::foreground_window_details();

    let mut context = StructuredContext {
        schema_version: SCHEMA_VERSION,
        turn_context_id,
        captured_at_ms: now_ms(),
        capture_ms: 0,
        app: AppIdentity {
            process: clip_text(&process),
            window_id,
            window_title: clip_text(&window_title),
        },
        focus: None,
        ancestors: Vec::new(),
        siblings: Vec::new(),
        descendants: Vec::new(),
        quality: Quality {
            sufficient: false,
            reason: QualityReason::NoFocusElement,
            text_nodes: 0,
            text_chars: 0,
        },
        bounds_hit: Vec::new(),
    };

    // Keyboard focus first, pointer element as the documented fallback: a user
    // asking "what is this" while hovering has no focused control at all.
    let focused = unsafe { automation.GetFocusedElement() }
        .ok()
        .filter(|element| !is_own_process(element))
        .or_else(|| {
            unsafe { automation.ElementFromPoint(cursor) }
                .ok()
                .filter(|element| !is_own_process(element))
        });
    let Some(focused) = focused else {
        context.capture_ms = started.elapsed().as_millis() as u64;
        context.finish_quality(guide_armed);
        return context;
    };

    let ancestry = collect_ancestors(automation, &focused, budget);
    context.focus = build_node(&focused, &ancestry, 0, &context.app.process, budget);
    context.ancestors = ancestry
        .iter()
        .enumerate()
        .filter_map(|(index, element)| {
            build_node(element, &ancestry[index + 1..], index, &context.app.process, budget)
        })
        .collect();
    // Root-most first, so the model reads a path inwards.
    context.ancestors.reverse();

    if let Some(parent) = ancestry.first() {
        context.siblings =
            collect_children(automation, parent, Some(&focused), MAX_SIBLINGS, &context.app.process, budget);
    }
    let (descendants, depth_truncated) =
        collect_descendants(automation, &focused, &context.app.process, budget);
    context.descendants = descendants;

    if depth_truncated {
        context.note_bound(BoundHit::Depth);
    }
    if budget.nodes_remaining == 0 {
        context.note_bound(BoundHit::NodeCount);
    }
    if budget.expired() {
        context.note_bound(BoundHit::Duration);
    }
    context.enforce_byte_budget();
    context.capture_ms = started.elapsed().as_millis() as u64;
    context.finish_quality(guide_armed);
    context
}

/// An element belonging to Aura itself. Compared by process id rather than by
/// window handle so it covers the overlay, the dashboard and any future window
/// without anyone remembering to add it to a list.
pub(super) fn is_own_process(element: &IUIAutomationElement) -> bool {
    unsafe { element.CurrentProcessId() }
        .map(|pid| pid as u32 == std::process::id())
        .unwrap_or(false)
}

fn collect_ancestors(
    automation: &IUIAutomation,
    focused: &IUIAutomationElement,
    budget: &Budget,
) -> Vec<IUIAutomationElement> {
    let mut chain = Vec::new();
    let Ok(walker) = (unsafe { automation.ControlViewWalker() }) else {
        return chain;
    };
    let mut current = focused.clone();
    while chain.len() < MAX_ANCESTORS && !budget.expired() {
        let Ok(parent) = (unsafe { walker.GetParentElement(&current) }) else {
            break;
        };
        // The desktop root carries no useful context and its children are every
        // top-level window on the machine, so the walk stops below it.
        if unsafe { parent.CurrentControlType() }
            .map(|role| role_name(role.0) == "Pane" && chain.len() + 1 >= MAX_ANCESTORS)
            .unwrap_or(false)
        {
            chain.push(parent);
            break;
        }
        chain.push(parent.clone());
        current = parent;
    }
    chain
}

/// One cached batch read of a parent's children.
///
/// `FindAllBuildCache` is the reason this is affordable: it fetches every
/// child AND the properties below in a single cross-process call, instead of
/// one round trip per property per child. Reading twenty children the naive way
/// is hundreds of COM calls into someone else's message loop.
fn collect_children(
    automation: &IUIAutomation,
    parent: &IUIAutomationElement,
    exclude: Option<&IUIAutomationElement>,
    limit: usize,
    process: &str,
    budget: &mut Budget,
) -> Vec<UiNode> {
    let mut nodes = Vec::new();
    if budget.expired() {
        return nodes;
    }
    let (Ok(condition), Ok(cache)) = (unsafe { automation.CreateTrueCondition() }, unsafe {
        automation.CreateCacheRequest()
    }) else {
        return nodes;
    };
    for property in [
        UIA_NamePropertyId,
        UIA_ControlTypePropertyId,
        UIA_AutomationIdPropertyId,
        UIA_BoundingRectanglePropertyId,
        UIA_IsPasswordPropertyId,
        UIA_IsEnabledPropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_HasKeyboardFocusPropertyId,
    ] {
        let _ = unsafe { cache.AddProperty(property) };
    }
    let Ok(children) = (unsafe { parent.FindAllBuildCache(TreeScope_Children, &condition, &cache) })
    else {
        return nodes;
    };
    let count = unsafe { children.Length() }.unwrap_or(0);
    for index in 0..count {
        if nodes.len() >= limit || budget.expired() {
            break;
        }
        let Ok(child) = (unsafe { children.GetElement(index) }) else {
            continue;
        };
        if is_own_process(&child) {
            continue;
        }
        if let Some(exclude) = exclude {
            if unsafe { automation.CompareElements(exclude, &child) }
                .map(|same| same.as_bool())
                .unwrap_or(false)
            {
                continue;
            }
        }
        if let Some(node) = build_node(&child, &[], index as usize, process, budget) {
            nodes.push(node);
        }
    }
    nodes
}

/// Breadth-first so the shallow, usually more meaningful controls are the ones
/// that survive the node cap.
/// Returns the nodes plus whether the depth cap cut the walk short, so a
/// systematically deep app shows up as `bounds_hit: ["depth"]` rather than as
/// mysteriously thin context.
fn collect_descendants(
    automation: &IUIAutomation,
    focused: &IUIAutomationElement,
    process: &str,
    budget: &mut Budget,
) -> (Vec<UiNode>, bool) {
    let mut nodes = Vec::new();
    let mut frontier = vec![focused.clone()];
    let mut depth_truncated = false;
    for depth in 0..MAX_DESCENDANT_DEPTH {
        if nodes.len() >= MAX_DESCENDANTS || budget.expired() {
            break;
        }
        if depth + 1 == MAX_DESCENDANT_DEPTH && !frontier.is_empty() {
            depth_truncated = true;
        }
        let mut next = Vec::new();
        for parent in &frontier {
            if nodes.len() >= MAX_DESCENDANTS || budget.expired() {
                break;
            }
            let remaining = MAX_DESCENDANTS - nodes.len();
            let batch = collect_children(automation, parent, None, remaining, process, budget);
            nodes.extend(batch);
            if let Ok(condition) = unsafe { automation.CreateTrueCondition() } {
                if let Ok(children) =
                    unsafe { parent.FindAll(TreeScope_Children, &condition) }
                {
                    let count = unsafe { children.Length() }.unwrap_or(0);
                    for index in 0..count.min(MAX_DESCENDANTS as i32) {
                        if let Ok(child) = unsafe { children.GetElement(index) } {
                            next.push(child);
                        }
                    }
                }
            }
        }
        frontier = next;
    }
    (nodes, depth_truncated && !frontier.is_empty())
}

/// Turns one element into a bounded, redacted node. `None` when the element
/// carries nothing worth sending or the node budget is spent.
fn build_node(
    element: &IUIAutomationElement,
    ancestry: &[IUIAutomationElement],
    sibling_index: usize,
    process: &str,
    budget: &mut Budget,
) -> Option<UiNode> {
    if budget.expired() || !budget.take_node() {
        return None;
    }
    let role = unsafe { element.CurrentControlType() }
        .map(|value| role_name(value.0))
        .unwrap_or("Custom");
    let name = bstr_text(unsafe { element.CurrentName() }.ok());
    let automation_id = bstr_text(unsafe { element.CurrentAutomationId() }.ok());

    // Read the flag BEFORE the value, and skip the value read entirely when it
    // is set. The password never enters this process, so no later filter can
    // fail to remove it.
    let redacted = unsafe { element.CurrentIsPassword() }
        .map(|flag| flag.as_bool())
        .unwrap_or(false);
    let value = if redacted {
        None
    } else {
        read_value(element, role)
    };

    if role == "Custom" && name.is_empty() && value.is_none() && automation_id.is_empty() {
        return None;
    }

    let rect = unsafe { element.CurrentBoundingRectangle() }
        .map(|r| [r.left, r.top, r.right - r.left, r.bottom - r.top])
        .unwrap_or([0, 0, 0, 0]);

    let mut states: Vec<&'static str> = Vec::new();
    if unsafe { element.CurrentIsEnabled() }
        .map(|f| f.as_bool())
        .unwrap_or(true)
    {
        states.push("enabled");
    } else {
        states.push("disabled");
    }
    if unsafe { element.CurrentHasKeyboardFocus() }
        .map(|f| f.as_bool())
        .unwrap_or(false)
    {
        states.push("focused");
    }
    if unsafe { element.CurrentIsOffscreen() }
        .map(|f| f.as_bool())
        .unwrap_or(false)
    {
        states.push("offscreen");
    }
    if STATEFUL_ROLES.contains(&role) {
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            )
        } {
            if unsafe { pattern.CurrentIsSelected() }
                .map(|f| f.as_bool())
                .unwrap_or(false)
            {
                states.push("selected");
            }
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                UIA_ExpandCollapsePatternId,
            )
        } {
            if let Ok(state) = unsafe { pattern.CurrentExpandCollapseState() } {
                // 1 == Expanded, 0 == Collapsed (ExpandCollapseState).
                states.push(if state.0 == 1 { "expanded" } else { "collapsed" });
            }
        }
    }

    Some(UiNode {
        id: synthesized_id(process, &automation_id, role, ancestry, sibling_index),
        runtime_id: String::new(),
        automation_id,
        role: role.to_string(),
        name,
        value,
        states,
        rect,
        redacted,
    })
}

fn read_value(element: &IUIAutomationElement, role: &str) -> Option<String> {
    if !VALUE_BEARING_ROLES.contains(&role) {
        return None;
    }
    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .ok()?;
    // Second guard: a control can expose ValuePattern and still be protected.
    if unsafe { element.CurrentIsPassword() }
        .map(|f| f.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let text = bstr_text(unsafe { pattern.CurrentValue() }.ok());
    (!text.is_empty()).then_some(text)
}

fn bstr_text(value: Option<BSTR>) -> String {
    value
        .map(|raw| clip_text(&raw.to_string()))
        .unwrap_or_default()
}

/// A durable identity for one control.
///
/// Deliberately NOT RuntimeId: that is unique only within the current UI
/// Automation session, so it cannot be compared across app restarts and must
/// never be persisted. Hashing the app, the automation id, the role and the
/// position in the ancestry gives something stable enough to recognise "the
/// same field" across turns without pretending to be globally unique.
fn synthesized_id(
    process: &str,
    automation_id: &str,
    role: &str,
    ancestry: &[IUIAutomationElement],
    sibling_index: usize,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(process.as_bytes());
    hasher.update(b"|");
    hasher.update(automation_id.as_bytes());
    hasher.update(b"|");
    hasher.update(role.as_bytes());
    hasher.update(b"|");
    for ancestor in ancestry.iter().take(MAX_ANCESTORS) {
        let ancestor_role = unsafe { ancestor.CurrentControlType() }
            .map(|value| role_name(value.0))
            .unwrap_or("Custom");
        hasher.update(ancestor_role.as_bytes());
        hasher.update(b"/");
    }
    hasher.update(sibling_index.to_le_bytes());
    let digest = hasher.finalize();
    digest[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// UIA_CONTROLTYPE_ID values are a stable, documented, contiguous block
/// starting at 50000. Mapped to the names the model already reasons about
/// rather than raw numbers.
pub(super) fn role_name(control_type: i32) -> &'static str {
    match control_type {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Custom",
    }
}
