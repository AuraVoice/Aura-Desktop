//! Wire contract for structured screen context.
//!
//! Mirrored in TypeScript by `src/lib/screenContext.ts` and validated on the
//! backend by `backend/src/agent/voice/screen_context_stream.py`. All three
//! must agree; the schema version below is what lets the backend reject a
//! payload it does not understand instead of guessing at it.

use serde::Serialize;

/// Bump whenever a field changes meaning or a required field is added.
pub const SCHEMA_VERSION: u16 = 1;

/// Every bound this capture is allowed to spend. UI Automation walks another
/// process's tree over COM, so an unbounded walk is an unbounded stall on the
/// response path - each of these exists to stop one specific way that happens.
pub const MAX_ANCESTORS: usize = 6;
pub const MAX_SIBLINGS: usize = 8;
pub const MAX_DESCENDANTS: usize = 16;
pub const MAX_DESCENDANT_DEPTH: usize = 3;
pub const MAX_NODES: usize = 40;
pub const MAX_TEXT_CHARS: usize = 200;
pub const MAX_SERIALIZED_BYTES: usize = 32 * 1024;

/// Deterministic verdict on whether the structured snapshot can answer the
/// turn on its own. Closed vocabulary: the backend rejects anything else, and
/// these are aggregated to see how often pixels are still needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityReason {
    /// Enough named, textual UI to answer from. No screenshot needed.
    StructuredOk,
    /// Nothing has keyboard focus and nothing sits under the pointer.
    NoFocusElement,
    /// A focus element resolved but carried no usable text anywhere near it.
    EmptyTree,
    /// Canvas, video, game, remote desktop: a real surface with no accessible
    /// content. Detected structurally (no named descendants, no text), never
    /// from an app name blocklist.
    VisualOnlySurface,
    /// The walk ran out of its time budget.
    CaptureTimeout,
    /// A traversal bound was hit before enough context was gathered.
    BoundsExceeded,
    /// Guide Mode is armed and reasons about pixels by definition.
    GuideRequiresPixels,
    /// UI Automation could not be reached at all on this machine.
    UiaUnavailable,
}

/// Which bound a capture ran into, reported so a systematically truncated app
/// is visible in telemetry rather than silently degrading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BoundHit {
    Depth,
    NodeCount,
    Bytes,
    Duration,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AppIdentity {
    /// Executable stem, e.g. "OUTLOOK". Never a full path.
    pub process: String,
    pub window_id: String,
    pub window_title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UiNode {
    /// Stable synthesized identity: sha256 of process, automation id, control
    /// role, ancestor chain and sibling index, truncated. Needed because
    /// RuntimeId is only unique within the CURRENT UI Automation session and
    /// must never be persisted or compared across runs.
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub runtime_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub automation_id: String,
    pub role: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// Omitted entirely when `redacted` is set. A password value never reaches
    /// this struct, so it cannot be serialized, logged or streamed by mistake.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<&'static str>,
    /// Physical screen pixels: [left, top, width, height].
    pub rect: [i32; 4],
    pub redacted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Quality {
    pub sufficient: bool,
    pub reason: QualityReason,
    pub text_nodes: usize,
    pub text_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StructuredContext {
    pub schema_version: u16,
    pub turn_context_id: String,
    pub captured_at_ms: u64,
    /// How long the UI Automation walk itself took. Surfaced to the frontend as
    /// the `ui_automation_ms` stage metric.
    pub capture_ms: u64,
    pub app: AppIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<UiNode>,
    pub ancestors: Vec<UiNode>,
    pub siblings: Vec<UiNode>,
    pub descendants: Vec<UiNode>,
    pub quality: Quality,
    pub bounds_hit: Vec<BoundHit>,
}

impl StructuredContext {
    /// An empty snapshot carrying only why nothing was captured. Returned
    /// instead of an error so the caller always gets a reason it can report,
    /// and always falls back to pixels rather than losing screen awareness.
    pub fn unavailable(turn_context_id: String, reason: QualityReason, capture_ms: u64) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            turn_context_id,
            captured_at_ms: now_ms(),
            capture_ms,
            app: AppIdentity::default(),
            focus: None,
            ancestors: Vec::new(),
            siblings: Vec::new(),
            descendants: Vec::new(),
            quality: Quality {
                sufficient: false,
                reason,
                text_nodes: 0,
                text_chars: 0,
            },
            bounds_hit: Vec::new(),
        }
    }

    /// Text carried by every node in the snapshot, used by the sufficiency
    /// rule below. Counts names and values, not roles: a tree of unnamed
    /// generic containers is not context.
    fn text_totals(&self) -> (usize, usize) {
        let mut nodes = 0;
        let mut chars = 0;
        for node in self
            .focus
            .iter()
            .chain(self.ancestors.iter())
            .chain(self.siblings.iter())
            .chain(self.descendants.iter())
        {
            let node_chars =
                node.name.chars().count() + node.value.as_deref().unwrap_or("").chars().count();
            if node_chars > 0 {
                nodes += 1;
                chars += node_chars;
            }
        }
        (nodes, chars)
    }

    /// The deterministic decision the whole structured-first policy rests on.
    ///
    /// No model call and no transcript classifier: whether to spend a
    /// screenshot is decided from the shape of the tree alone, so it costs
    /// nothing and behaves identically every time. The bar is deliberately
    /// conservative - when this is unsure it says "insufficient", the caller
    /// sends pixels, and screen awareness degrades to exactly today's
    /// behaviour rather than silently getting worse.
    pub fn finish_quality(&mut self, guide_armed: bool) {
        let (text_nodes, text_chars) = self.text_totals();
        self.quality.text_nodes = text_nodes;
        self.quality.text_chars = text_chars;

        let reason = if guide_armed {
            QualityReason::GuideRequiresPixels
        } else if self.bounds_hit.contains(&BoundHit::Duration) {
            QualityReason::CaptureTimeout
        } else if self.focus.is_none() {
            QualityReason::NoFocusElement
        } else if self.is_visual_only_surface() {
            QualityReason::VisualOnlySurface
        } else if text_nodes < 3 || text_chars < 40 {
            QualityReason::EmptyTree
        } else if self.bounds_hit.contains(&BoundHit::Bytes) {
            QualityReason::BoundsExceeded
        } else {
            QualityReason::StructuredOk
        };
        self.quality.sufficient = reason == QualityReason::StructuredOk;
        self.quality.reason = reason;
    }

    /// A canvas, video surface, game or remote-desktop viewport looks the same
    /// through UI Automation: a real, focusable element of a container-ish role
    /// with nothing accessible inside it. Detected by shape rather than by
    /// naming applications, so it holds for software nobody listed.
    fn is_visual_only_surface(&self) -> bool {
        let Some(focus) = self.focus.as_ref() else {
            return false;
        };
        let container_role = matches!(
            focus.role.as_str(),
            "Image" | "Document" | "Pane" | "Custom" | "Group"
        );
        let focus_has_text =
            !focus.name.is_empty() || focus.value.as_deref().is_some_and(|v| !v.is_empty());
        let descendants_named = self
            .descendants
            .iter()
            .any(|node| !node.name.is_empty() || node.value.is_some());
        container_role && !focus_has_text && !descendants_named
    }

    /// Trims the snapshot until it fits `MAX_SERIALIZED_BYTES`.
    ///
    /// The per-field caps already make a runaway payload unlikely, but "unlikely"
    /// is not a bound: a page with many long labels can still add up. Trimming
    /// here rather than letting the backend reject the whole thing means a
    /// large page degrades to less context instead of to none.
    ///
    /// Least valuable first: descendants (detail), then siblings (periphery).
    /// The focus node and its ancestor path are what actually answer the turn,
    /// so they are never dropped.
    pub fn enforce_byte_budget(&mut self) {
        for _ in 0..(MAX_DESCENDANTS + MAX_SIBLINGS + 1) {
            let Ok(encoded) = serde_json::to_vec(self) else {
                return;
            };
            if encoded.len() <= MAX_SERIALIZED_BYTES {
                return;
            }
            if self.descendants.pop().is_none() && self.siblings.pop().is_none() {
                self.note_bound(BoundHit::Bytes);
                return;
            }
            self.note_bound(BoundHit::Bytes);
        }
    }

    pub fn note_bound(&mut self, bound: BoundHit) {
        if !self.bounds_hit.contains(&bound) {
            self.bounds_hit.push(bound);
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Flattens and hard-caps one piece of UI text. Applied to every name and
/// value the moment it leaves COM, so no unbounded string ever reaches the
/// struct, the log, or the wire.
pub fn clip_text(raw: &str) -> String {
    let flattened = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= MAX_TEXT_CHARS {
        return flattened;
    }
    flattened.chars().take(MAX_TEXT_CHARS).collect()
}
