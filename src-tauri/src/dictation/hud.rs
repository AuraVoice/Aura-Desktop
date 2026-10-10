//! The dictation HUD: a thin pill docked to the same screen edge as the voice
//! bar, enlarging while the chord is held.
//!
//! This is its OWN window (label "dictation"), not an overlay.rs presentation,
//! for two reasons. Any path into the overlay can reach
//! `win_focus::force_foreground`, which both steals focus (killing insertion,
//! whose whole contract is that the target window keeps it) and taps Alt,
//! dropping the target into keyboard menu mode. And
//! `OverlayPresentation::Bar` is already in use whenever a voice session is
//! live, so the two surfaces would fight over `applied_presentation`. Dictation
//! also has to be able to RENDER signed out, because the signed-out case is now
//! something it has to explain rather than something it supports, and the
//! overlay's React root cannot do that.
//!
//! It reuses overlay.rs's edge anchoring. The user docked their notch somewhere
//! on purpose; dictation appears there too.
//!
//! main.tsx routes on the window label, and "dictation" is listed in
//! capabilities/default.json's `windows` array. Without that entry the label
//! gets ZERO permissions, including core:default, so it could not even listen
//! for its own events.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};
use tauri_plugin_store::StoreExt;

use crate::overlay::{self, NotchEdge};

pub const DICTATION_WINDOW: &str = "dictation";

/// The resting pill stays visible between holds and expands only while
/// dictation is active.
const RESTING_WIDTH: f64 = 8.0;
const RESTING_HEIGHT: f64 = 40.0;
const ACTIVE_WIDTH: f64 = 24.0;
const ACTIVE_HEIGHT: f64 = 65.0;
// Hover hint sizes must agree with DictationHud.css: the 164px hint pill
// (.dictation-launcher__hint) and 46px mic column (.dictation-launcher__mic)
// render edge-to-edge inside these windows.
const HOVER_SIDE_WIDTH: f64 = 196.0;
const HOVER_SIDE_HEIGHT: f64 = 46.0;
const HOVER_TOP_WIDTH: f64 = 164.0;
const HOVER_TOP_HEIGHT: f64 = 63.0;

/// The message pill. Used by `Error`; live recognition stays a compact
/// waveform because the final transcript belongs in the focused field.
/// `Pending` and `Recovery` share the taller card because both carry the
/// transcript and a Copy button as their last row.
const MESSAGE_WIDTH: f64 = 340.0;
const MESSAGE_HEIGHT: f64 = 44.0;
const PENDING_HEIGHT: f64 = 112.0;
const RECOVERY_HEIGHT: f64 = 112.0;
/// The one-time online-dictation consent prompt. Wider and taller than any
/// other state because it is the only one that has to carry a disclosure the
/// user is expected to read and two buttons they have to be able to hit.
/// 132 was too short for the disclosure at its real wrapped length: the body
/// ran to four lines, and since .glass-surface clips its overflow, the actions
/// row was cut off the bottom of the surface and the Turn on button could not
/// be clicked at all. Sized now to fit the copy with headroom; the CSS also
/// guards the row so a longer disclosure shrinks the body instead.
const CONSENT_WIDTH: f64 = 396.0;
const CONSENT_HEIGHT: f64 = 176.0;

/// Companion mode: Bolt stands in a corner of the work area instead of the
/// pill docking to the notch edge. The resting window fits his 64 px canvas
/// plus a hop and his shadow; the hovered one adds the chord hint beside him.
/// Must agree with `.dictation-companion` in DictationHud.css.
const COMPANION_REST_WIDTH: f64 = 84.0;
const COMPANION_REST_HEIGHT: f64 = 92.0;
const COMPANION_HOVER_WIDTH: f64 = 220.0;
/// The click menu beside him. Must agree with `.dictation-companion-menu`.
const COMPANION_MENU_WIDTH: f64 = 256.0;
const COMPANION_MENU_HEIGHT: f64 = 124.0;
/// Extra height a card phase needs so Bolt can stand under the card holding
/// it up: his 64 px minus the 8 px where his hands sit under the card's edge.
const COMPANION_CARRY: f64 = 56.0;
/// Gap between Bolt and the two screen edges that meet at his corner.
const COMPANION_INSET: f64 = 12.0;

/// The window the current hold is typing into, remembered so a later phase
/// change can re-place the HUD on the right display without the worker having
/// to thread the target through every publish.
static LAST_TARGET: AtomicIsize = AtomicIsize::new(0);
/// True while the current hold is dictating into the overlay window itself
/// (the chat composer). Set once per utterance in `show` from
/// `target_is_overlay` and the chat flags, cleared by `show_idle`, and read by
/// `edge_wanted`: a self-targeted hold must NOT borrow the notch edge, because
/// hiding the Bar hides the very window the insert needs focused. The
/// dashboard and every other Aura window are NOT self: hiding the Bar costs
/// them nothing, so they take the ordinary foreign-target path (issue #28).
static TARGET_IS_SELF: AtomicBool = AtomicBool::new(false);
static IDLE_HOVERED: AtomicBool = AtomicBool::new(false);

/// Last answer from the macOS `target_center` AX read, as (pid, centre, when).
/// Short enough that re-docking or moving the target window between two holds
/// still re-reads, long enough that the burst of placements one phase change
/// produces asks the target application once instead of three times.
#[cfg(target_os = "macos")]
const TARGET_CENTER_TTL: std::time::Duration = std::time::Duration::from_millis(500);
/// (pid, centre in physical pixels, when it was read).
#[cfg(target_os = "macos")]
type CachedCenter = (isize, (f64, f64), std::time::Instant);
#[cfg(target_os = "macos")]
static TARGET_CENTER: Mutex<Option<CachedCenter>> = Mutex::new(None);

/// True while the Buddy agent overlay is visible. The overlay and this HUD are
/// separate always-on-top windows that are never both on screen: at rest the
/// notch wins and this pill stays hidden; for the length of a hold the HUD
/// takes the edge and the notch is hidden instead. Both directions run through
/// `overlay::apply_result`, the sole place any overlay change reaches the real
/// window and the sole caller of `set_overlay_suppressed`. This side asks for
/// the edge with `overlay::set_dictation_hold` and never touches the notch
/// itself - that single choke point is what makes "at most one of the two is
/// visible" a guarantee rather than two toggles that merely happen to be
/// called together.
static SUPPRESSED_BY_OVERLAY: AtomicBool = AtomicBool::new(false);

/// Which corner of the work area Bolt stands in while companion mode is on.
/// Geometry is Rust's, so this is persisted under its own key in the overlay
/// store the way `notch_edge` is, not inside the dashboard's settings object.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum CompanionCorner {
    #[default]
    BottomLeft,
    BottomRight,
    TopLeft,
    TopRight,
}

impl CompanionCorner {
    pub fn from_stored(value: &str) -> Option<Self> {
        match value {
            "bottomLeft" => Some(Self::BottomLeft),
            "bottomRight" => Some(Self::BottomRight),
            "topLeft" => Some(Self::TopLeft),
            "topRight" => Some(Self::TopRight),
            _ => None,
        }
    }

    pub fn as_stored(self) -> &'static str {
        match self {
            Self::BottomLeft => "bottomLeft",
            Self::BottomRight => "bottomRight",
            Self::TopLeft => "topLeft",
            Self::TopRight => "topRight",
        }
    }

    fn is_right(self) -> bool {
        matches!(self, Self::BottomRight | Self::TopRight)
    }

    fn is_top(self) -> bool {
        matches!(self, Self::TopLeft | Self::TopRight)
    }
}

const OVERLAY_STORE: &str = "overlay-window.json";
const COMPANION_CORNER_KEY: &str = "companion_corner";
/// The dashboard's settings object, written by src/lib/generalSettings.ts.
const GENERAL_SETTINGS_KEY: &str = "dashboard_general_settings";

/// `None` until the first read, which loads the persisted corner once; the
/// default is bottom left, clear of the toast stacks on both platforms.
static COMPANION_CORNER: Mutex<Option<CompanionCorner>> = Mutex::new(None);

pub fn companion_corner(app: &AppHandle) -> CompanionCorner {
    let mut slot = COMPANION_CORNER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(corner) = *slot {
        return corner;
    }
    let corner = app
        .store(OVERLAY_STORE)
        .ok()
        .and_then(|store| store.get(COMPANION_CORNER_KEY))
        .and_then(|value| value.as_str().and_then(CompanionCorner::from_stored))
        .unwrap_or_default();
    *slot = Some(corner);
    corner
}

/// Persists the corner and re-places the HUD. A store that cannot be opened
/// still moves him for this session; the failure is logged, never fatal.
pub fn set_companion_corner(app: &AppHandle, corner: CompanionCorner) {
    *COMPANION_CORNER.lock().unwrap_or_else(|e| e.into_inner()) = Some(corner);
    match app.store(OVERLAY_STORE) {
        Ok(store) => store.set(COMPANION_CORNER_KEY, serde_json::json!(corner.as_stored())),
        Err(e) => log::error!("dictation.hud: failed to persist companion corner: {e}"),
    }
    refresh_placement(app);
}

/// Whether Bolt stands on the desktop. Read from the dashboard's settings
/// store at every placement, the way dashboard.rs reads `showInTaskbar`, so
/// the switch takes effect without a restart. Both switches must be on, and
/// any read failure means off: a missing robot is the harmless outcome.
pub fn companion_mode(app: &AppHandle) -> bool {
    let Ok(store) = app.store(OVERLAY_STORE) else {
        return false;
    };
    store
        .get(GENERAL_SETTINGS_KEY)
        .map(|settings| {
            let flag = |key: &str| {
                settings
                    .get(key)
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
            };
            flag("showCompanionAvatar") && flag("companionOnDesktop")
        })
        .unwrap_or(false)
        && !snoozed(app)
}

/// True while the click menu is open beside Bolt. The one time the resting
/// window may activate: its buttons need WebView2 to own input (see
/// `needs_activation`), and the user asked for it by clicking him.
static MENU_OPEN: AtomicBool = AtomicBool::new(false);
const COMPANION_SNOOZE_KEY: &str = "companion_snoozed_until";
/// Unix milliseconds until which the companion stays off the desktop. `None`
/// until first read, which loads the persisted value so a snooze survives a
/// relaunch. While it is in the future `companion_mode` is false and the HUD
/// falls back to the plain pill: dictation keeps working, only he is away.
static SNOOZED_UNTIL: Mutex<Option<u64>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn snoozed(app: &AppHandle) -> bool {
    let mut slot = SNOOZED_UNTIL.lock().unwrap_or_else(|e| e.into_inner());
    let until = match *slot {
        Some(until) => until,
        None => {
            let stored = app
                .store(OVERLAY_STORE)
                .ok()
                .and_then(|store| store.get(COMPANION_SNOOZE_KEY))
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            *slot = Some(stored);
            // The wake-up thread from `snooze_until` died with the process that
            // set it; without a new one Bolt never comes back on his own.
            if stored > now_ms() {
                schedule_wake(app, stored);
            }
            stored
        }
    };
    until > now_ms()
}

/// Puts Bolt away until `until_ms` (unix milliseconds, computed by the
/// webview so "tomorrow morning" is in the user's local time) and brings him
/// back on his own when it passes. The thread is the wake-up for THIS process;
/// after a relaunch the persisted value is simply read until it has expired.
pub fn snooze_until(app: &AppHandle, until_ms: u64) {
    *SNOOZED_UNTIL.lock().unwrap_or_else(|e| e.into_inner()) = Some(until_ms);
    match app.store(OVERLAY_STORE) {
        Ok(store) => store.set(COMPANION_SNOOZE_KEY, serde_json::json!(until_ms)),
        Err(e) => log::error!("dictation.hud: failed to persist companion snooze: {e}"),
    }
    MENU_OPEN.store(false, Ordering::Relaxed);
    refresh_placement(app);
    schedule_wake(app, until_ms);
}

fn schedule_wake(app: &AppHandle, until_ms: u64) {
    let wake = until_ms.saturating_sub(now_ms());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(wake + 50));
        // A later, longer snooze supersedes this one: only wake if nothing
        // extended it.
        let current = SNOOZED_UNTIL.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or(0);
        if current <= now_ms() {
            refresh_placement(&handle);
        }
    });
}

/// Opens or closes the click menu. Only meaningful at rest; a phase change
/// closes it implicitly because `publish` clears the flag.
pub fn set_menu_open(app: &AppHandle, open: bool) {
    if last_update().phase != HudPhase::Idle {
        MENU_OPEN.store(false, Ordering::Relaxed);
        return;
    }
    MENU_OPEN.store(open, Ordering::Relaxed);
    if open {
        IDLE_HOVERED.store(false, Ordering::Relaxed);
    }
    refresh_placement(app);
}

/// True from the pointer going down on Bolt until the drop is settled. While
/// it is set, the window's own `Moved` events are the drag in progress; at any
/// other time they are this module's own `set_position` calls and are ignored,
/// which is what keeps a programmatic placement from ever counting as a drop.
static DRAGGING: AtomicBool = AtomicBool::new(false);
/// Whether the window actually moved during the current drag. A click that
/// never moves ends with nothing to settle.
static DRAG_MOVED: AtomicBool = AtomicBool::new(false);
/// Bumped on every `Moved` event during a drag. The drop is settled once no
/// further move has arrived for `DRAG_SETTLE`, because the OS move loop gives
/// no end-of-drag event the webview can see.
static DRAG_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const DRAG_SETTLE: std::time::Duration = std::time::Duration::from_millis(160);
/// Centre of the window, in physical pixels, where Bolt was last dropped. At
/// rest he stays on that display; a hold still takes him to the target's.
static REST_POINT: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// The pointer went down on Bolt and React is about to start the OS drag.
pub fn begin_drag() {
    DRAGGING.store(true, Ordering::Relaxed);
    DRAG_MOVED.store(false, Ordering::Relaxed);
}

/// The pointer came back up in the webview. After a real drag the OS move
/// loop usually swallows that event, so the settle timer below is the normal
/// path; when it does arrive it settles the drop at once rather than clearing
/// the flag under the timer's feet. A click that never moved just ends.
pub fn end_drag(app: &AppHandle) {
    if !DRAGGING.load(Ordering::Relaxed) {
        return;
    }
    if DRAG_MOVED.load(Ordering::Relaxed) {
        companion_dropped(app);
    } else {
        DRAGGING.store(false, Ordering::Relaxed);
    }
}

/// `WindowEvent::Moved` on the HUD window. Only a drag in progress is of
/// interest; every other move is one of this module's own placements.
fn drag_moved(app: &AppHandle) {
    if !DRAGGING.load(Ordering::Relaxed) {
        return;
    }
    DRAG_MOVED.store(true, Ordering::Relaxed);
    let generation = DRAG_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DRAG_SETTLE);
        if DRAG_GENERATION.load(Ordering::Relaxed) != generation
            || !DRAGGING.load(Ordering::Relaxed)
        {
            return;
        }
        let on_main = handle.clone();
        let _ = handle.run_on_main_thread(move || companion_dropped(&on_main));
    });
}

/// Settles a drop: whichever quadrant of the work area the window's centre
/// landed in is the new corner, on the display it landed on. Persisting the
/// corner re-places the window, which is the snap.
fn companion_dropped(app: &AppHandle) {
    DRAGGING.store(false, Ordering::Relaxed);
    let Some(window) = app.get_webview_window(DICTATION_WINDOW) else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let centre = (
        position.x as f64 + size.width as f64 / 2.0,
        position.y as f64 + size.height as f64 / 2.0,
    );
    let Ok(Some(monitor)) = window.monitor_from_point(centre.0, centre.1) else {
        return;
    };
    let scale = monitor.scale_factor();
    let full_size = monitor.size().to_logical::<f64>(scale);
    let full_pos = monitor.position().to_logical::<f64>(scale);
    let (work_pos, work_size) = overlay::work_area_within(full_pos, full_size, scale);
    let logical = tauri::PhysicalPosition::new(centre.0, centre.1).to_logical::<f64>(scale);
    let right = logical.x > work_pos.x + work_size.width / 2.0;
    let top = logical.y < work_pos.y + work_size.height / 2.0;
    let corner = match (top, right) {
        (true, true) => CompanionCorner::TopRight,
        (true, false) => CompanionCorner::TopLeft,
        (false, true) => CompanionCorner::BottomRight,
        (false, false) => CompanionCorner::BottomLeft,
    };
    *REST_POINT.lock().unwrap_or_else(|e| e.into_inner()) = Some(centre);
    set_companion_corner(app, corner);
}

/// What the HUD is currently telling the user. Every caption is derived from
/// one of these; the chord itself is always rendered from
/// `DICTATION_CHORD.label()`, never a hardcoded string.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HudPhase {
    Idle,
    Listening,
    Transcribing,
    Inserted,
    /// A voice command was executed instead of typing (command_brain.rs).
    /// The caption names the action taken; it never quotes the transcript.
    Action,
    Error,
    /// A final transcript exists, but Windows could not safely type it. This
    /// interactive card lets the user copy the words instead of losing them.
    Recovery,
    /// Decoded, but no text box had focus, so the words are being held until
    /// one does. The transcript is shown because the user has to know both
    /// that something is waiting and what it says.
    Pending,
    /// The chord was pressed before the user agreed to online dictation. No
    /// microphone was opened and no audio exists; this asks, and nothing else
    /// happens until it is answered. The second interactive phase after Idle.
    Consent,
}

/// Whether the HUD should receive mouse input in this phase.
///
/// Almost every phase is a passive caption that must not steal clicks from the
/// window underneath, which is the whole point of a dictation HUD. The
/// exceptions need clicks to do their job: the resting pill's hover affordance,
/// the Copy button on the pending and recovery cards, and the consent prompt's
/// buttons.
fn accepts_clicks(phase: HudPhase) -> bool {
    matches!(
        phase,
        HudPhase::Idle | HudPhase::Pending | HudPhase::Recovery | HudPhase::Consent
    )
}

/// Whether this phase should borrow the notch edge from the Bar. A hold that
/// targets the overlay window keeps it visible (the insert needs its focus,
/// and the chat card renders its own chip for error, recovery and pending), so
/// it never takes the edge; the consent question is the one exception because
/// it must be seen and clicked. `Pending` cannot occur for a self target: the
/// focus probe refuses to judge our own process and `Unknown` types.
fn edge_wanted(phase: HudPhase) -> bool {
    if phase == HudPhase::Idle {
        return false;
    }
    if !TARGET_IS_SELF.load(Ordering::Relaxed) {
        return true;
    }
    phase == HudPhase::Consent
}

/// Phases whose window grows into a caption card rather than staying a pill.
///
/// For these the DOM update has to WAIT for the resize. `.dictation-message`
/// and `.glass-surface` both clip their overflow, so a card painted while the
/// window is still pill-sized has its lower rows cut off, and the recovery
/// card's Copy button is the last row. Publishing the event from the worker
/// thread and queueing the `set_size` separately made that gap as long as
/// whatever else was sitting on the main thread. Every other phase keeps or
/// shrinks the footprint and can paint immediately.
fn resizes_into_card(phase: HudPhase) -> bool {
    matches!(
        phase,
        HudPhase::Action
            | HudPhase::Error
            | HudPhase::Pending
            | HudPhase::Recovery
            | HudPhase::Consent
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HudUpdate {
    pub phase: HudPhase,
    /// The final or held text. Never logged anywhere.
    pub text: String,
    /// A short explanation shown under the text for a failure or a hold.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub chord_label: &'static str,
    /// Which edge the notch is docked to, so React renders the matching
    /// orientation. Stamped by `publish` from live overlay state rather than at
    /// construction, so no call site has to know about it.
    pub edge: &'static str,
    /// True when this hold is dictating into one of Aura's own windows. The
    /// chat composer renders its own listening chip from this, since the HUD
    /// stays suppressed behind the visible overlay. Stamped by `publish` like
    /// `edge`.
    pub own_target: bool,
    /// True when Bolt stands in a corner instead of the pill docking to the
    /// edge. Stamped by `publish` like `edge`, from the same read that sized
    /// the window, so React never lays out for a mode Rust did not size for.
    pub companion: bool,
    /// Which corner, so React mirrors Bolt to the matching side of a card.
    pub corner: &'static str,
}

/// The last update published, so a webview that was created moments ago can ask
/// for the current state instead of racing the first event. Without this the
/// HUD renders blank on the very first dictation, because the window is built
/// on arm and its listener is not registered yet when the first caption fires.
static LAST_UPDATE: Mutex<Option<HudUpdate>> = Mutex::new(None);

/// Backs the `dictation_hud_state` command.
pub fn last_update() -> HudUpdate {
    LAST_UPDATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| HudUpdate::new(HudPhase::Idle))
}

impl HudUpdate {
    pub fn new(phase: HudPhase) -> Self {
        Self {
            phase,
            text: String::new(),
            message: None,
            chord_label: super::chord::DICTATION_CHORD.label(),
            edge: NotchEdge::default().as_stored(),
            own_target: false,
            companion: false,
            corner: CompanionCorner::default().as_stored(),
        }
    }

    /// Stamps the live edge, companion mode and corner. Every path that
    /// records or emits an update goes through here so the three never
    /// disagree with the geometry `place_window` is about to apply.
    fn stamp_placement(&mut self, app: &AppHandle) {
        self.edge = overlay::snapshot(app).notch_edge.as_stored();
        self.companion = companion_mode(app);
        self.corner = companion_corner(app).as_stored();
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = text.into();
        self
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

/// Creates the HUD window if it does not exist yet. Runs on the main thread
/// because that is where Tauri builds windows on Windows; callers on the
/// dictation worker thread go through `AppHandle::run_on_main_thread`.
fn build_window(app: &AppHandle) -> Result<(), String> {
    // The resting surface receives hover (ignore_cursor_events false) so
    // Windows can show its native hint. WS_EX_NOACTIVATE, applied inside the
    // shared builder (the `AuraAccessoryPanel` class on macOS), keeps it from
    // taking focus, and the surface has no click action. Active dictation
    // switches back to click-through.
    let fresh = app.get_webview_window(DICTATION_WINDOW).is_none();
    let window = crate::window_util::build_accessory_window(
        app,
        DICTATION_WINDOW,
        "Aura Dictation",
        LogicalSize::new(RESTING_WIDTH, RESTING_HEIGHT),
        false,
    )?;
    // Once per window: the builder returns the existing one on every later
    // call, and a second handler would settle every drop twice.
    if fresh {
        let moved_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Moved(_) = event {
                drag_moved(&moved_handle);
            }
        });
    }
    Ok(())
}

/// Whether this phase needs the window to be activatable.
///
/// Pending, Recovery and Consent have controls. Every other phase is hover only or
/// click-through, which is why `apply_no_activate` was safe to set once at build
/// and forget: a window that cannot activate cannot hand its WebView2 child
/// focus, and a click into an unfocused WebView2 never reaches the DOM. That is
/// invisible until something in the window has to be clicked.
///
/// Kept separate from `accepts_clicks` on purpose even though both currently
/// name interactive phases: Idle accepts the cursor so Windows can show its
/// hover hint, and it must NOT become activatable to get that. On macOS the
/// same predicate drives the panel's `canBecomeKeyWindow` through
/// `prepare_activation`.
fn needs_activation(phase: HudPhase) -> bool {
    matches!(phase, HudPhase::Pending | HudPhase::Recovery | HudPhase::Consent)
        || (phase == HudPhase::Idle && MENU_OPEN.load(Ordering::Relaxed))
}

/// The half of activation that has to run BEFORE `window.show()`. On macOS
/// show is `makeKeyAndOrderFront:`, so the panel's answer to
/// `canBecomeKeyWindow` must already be right for the phase; setting it after
/// show would leave the HUD key for the rest of the hold, and every keystroke
/// dictation posts would land in this webview instead of the user's field
/// while the user's app still read as frontmost. Revoking also makes a
/// currently-key panel resign (see `macos_window::set_accessory_key_eligible`).
/// Windows has no pre-show half: WS_EX_NOACTIVATE is rewritten by tao's
/// apply_diff on show, so there it can only be applied afterwards.
#[cfg(target_os = "macos")]
fn prepare_activation(window: &tauri::WebviewWindow, phase: HudPhase) {
    crate::macos_window::set_accessory_key_eligible(window, needs_activation(phase));
}

#[cfg(not(target_os = "macos"))]
fn prepare_activation(_window: &tauri::WebviewWindow, _phase: HudPhase) {}

/// Adds or removes WS_EX_NOACTIVATE for the current phase, and logs the
/// ex-style bits that actually stuck.
///
/// The readback is not paranoia. tao's `WindowFlags::apply_diff` rewrites
/// GWL_EXSTYLE wholesale from its own cached flags, so any style set out of
/// band here can be silently dropped by a later `set_ignore_cursor_events` or
/// `show`. Logging what the window really carries turns "which flag won" from
/// an argument into an observation.
#[cfg(windows)]
fn sync_activation(window: &tauri::WebviewWindow, phase: HudPhase) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TRANSPARENT,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let activatable = needs_activation(phase);
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let no_activate = WS_EX_NOACTIVATE.0 as isize;
        let next = if activatable {
            current & !no_activate
        } else {
            current | no_activate
        };
        if next != current {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
        let applied = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        log::info!(
            "dictation.hud: phase={:?} activatable={} noactivate={} transparent={} layered={}",
            phase,
            activatable,
            applied & no_activate != 0,
            applied & WS_EX_TRANSPARENT.0 as isize != 0,
            applied & WS_EX_LAYERED.0 as isize != 0,
        );
    }
    // Focus has to follow the style: clearing WS_EX_NOACTIVATE only makes the
    // window eligible to activate, it does not activate it, and WebView2 needs
    // to actually own input before a click lands.
    if activatable {
        let _ = window.set_focus();
    }
}

/// The post-show half on macOS. Key eligibility was decided by
/// `prepare_activation` before `window.show()`; this re-asserts the panel style
/// tao's show may have rewritten and, for a phase with buttons, makes the panel
/// key without activating Aura (show already did when it was allowed to; this
/// covers the suppressed-then-restored case). The panel is NOT non-stealing by
/// construction: it is a non-activating panel whose key eligibility is
/// phase-gated, so a show site that skips the pre-show half steals key on
/// show. Keep both halves paired at every show call site.
#[cfg(target_os = "macos")]
fn sync_activation(window: &tauri::WebviewWindow, phase: HudPhase) {
    crate::macos_window::reassert_panel_style(window);
    if needs_activation(phase) {
        crate::macos_window::make_key_without_activating(window);
    }
}

/// Centre of a window in PHYSICAL screen pixels, which is what
/// `monitor_from_point` expects. Used to put the HUD on the display the user is
/// actually typing into rather than always on the primary one.
#[cfg(windows)]
fn target_center(target: isize) -> Option<(f64, f64)> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    if target == 0 {
        return None;
    }
    let mut rect = RECT::default();
    unsafe {
        let hwnd = HWND(target as *mut core::ffi::c_void);
        GetWindowRect(hwnd, &mut rect).ok()?;
    }
    Some((
        (rect.left + rect.right) as f64 / 2.0,
        (rect.top + rect.bottom) as f64 / 2.0,
    ))
}

/// The macOS twin. `target` is a pid here rather than a window handle (see
/// `insert::foreground_window`), so the frame comes from the accessibility
/// tree instead of the window server.
///
/// AX reports points, and `monitor_from_point` wants physical pixels, so the
/// result is scaled by the primary display's backing factor. That is the same
/// approximation `bar_position` already lives with, and it only has to be good
/// enough to pick the right display.
///
/// The read is memoised for `TARGET_CENTER_TTL` because it is the single most
/// expensive thing on the main thread during a hold: three AX properties, each
/// bounded by `macos_ax::MESSAGING_TIMEOUT_SECONDS` (0.25s), so up to 750ms per
/// call against an app that answers slowly. `show` and the `Listening` publish
/// that follows it are microseconds apart and ask the same question, and every
/// later phase transition asks it again. This memoises the ANSWER, not the
/// applied geometry: `place_window` still recomputes size and position from
/// live overlay state every time, so the "no applied cache" rule in CLAUDE.md
/// is untouched.
#[cfg(target_os = "macos")]
fn target_center(target: isize) -> Option<(f64, f64)> {
    if target <= 0 {
        return None;
    }
    let now = std::time::Instant::now();
    {
        let cached = TARGET_CENTER.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((pid, center, read_at)) = *cached {
            if pid == target && now.duration_since(read_at) < TARGET_CENTER_TTL {
                return Some(center);
            }
        }
    }
    let (x, y) = crate::macos_ax::focused_window_center(target as i32)?;
    let scale = crate::macos_window::primary_backing_scale();
    let center = (x * scale, y * scale);
    *TARGET_CENTER.lock().unwrap_or_else(|e| e.into_inner()) = Some((target, center, now));
    Some(center)
}

/// Which of Aura's own windows `target` is, by label (`main`, `dashboard`,
/// this HUD...), or `None` for a foreign window. Windows compares the target
/// HWND against every webview window's real top-level handle, which is exact
/// and sidesteps the WebView2 child-process pid trap. On macOS the target
/// token is already a pid (see `insert::foreground_window`), which cannot name
/// a window, so when the pid is ours the label comes from whichever webview
/// window reports focus, falling back to the overlay when none does. Called
/// from the worker thread only: `is_focused` is a blocking runtime getter.
#[cfg(windows)]
pub(super) fn own_window_label(app: &AppHandle, target: isize) -> Option<String> {
    if target == 0 {
        return None;
    }
    app.webview_windows()
        .iter()
        .find(|(_, w)| w.hwnd().is_ok_and(|h| h.0 as isize == target))
        .map(|(label, _)| label.clone())
}

#[cfg(target_os = "macos")]
pub(super) fn own_window_label(app: &AppHandle, target: isize) -> Option<String> {
    if target == 0 || target != std::process::id() as isize {
        return None;
    }
    let focused = app
        .webview_windows()
        .iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label.clone());
    Some(focused.unwrap_or_else(|| overlay::MAIN_WINDOW.to_string()))
}

/// True when the hold is typing into the overlay window itself (the chat
/// composer), the one own window the Bar hand-over would hide.
pub(super) fn target_is_overlay(app: &AppHandle, target: isize) -> bool {
    own_window_label(app, target).as_deref() == Some(overlay::MAIN_WINDOW)
}

/// True when the hold is typing into one of Aura's windows that is NOT the
/// overlay (the dashboard, for one). Such a window has its own text fields and
/// is never hidden by the edge hand-over, so it is treated like a foreign app:
/// the HUD takes the edge and an open chat card does not capture the text.
pub(super) fn target_is_other_own_window(app: &AppHandle, target: isize) -> bool {
    own_window_label(app, target).is_some_and(|label| label != overlay::MAIN_WINDOW)
}

fn oriented_size(edge: NotchEdge, side_width: f64, side_height: f64) -> LogicalSize<f64> {
    match edge {
        NotchEdge::Top | NotchEdge::Bottom => LogicalSize::new(side_height, side_width),
        NotchEdge::Left | NotchEdge::Right => LogicalSize::new(side_width, side_height),
    }
}

fn resting_size(edge: NotchEdge) -> LogicalSize<f64> {
    oriented_size(edge, RESTING_WIDTH, RESTING_HEIGHT)
}

/// The HUD's footprint for one phase. Idle is the compact persistent pill;
/// active phases enlarge it while keeping the same edge-aligned silhouette.
///
fn surface_size(
    edge: NotchEdge,
    phase: HudPhase,
    _has_caption: bool,
    companion: bool,
) -> LogicalSize<f64> {
    if companion {
        return companion_size(phase);
    }
    match phase {
        HudPhase::Idle if IDLE_HOVERED.load(Ordering::Relaxed) => match edge {
            NotchEdge::Top | NotchEdge::Bottom => {
                LogicalSize::new(HOVER_TOP_WIDTH, HOVER_TOP_HEIGHT)
            }
            NotchEdge::Left | NotchEdge::Right => {
                LogicalSize::new(HOVER_SIDE_WIDTH, HOVER_SIDE_HEIGHT)
            }
        },
        HudPhase::Idle => resting_size(edge),
        HudPhase::Action => LogicalSize::new(MESSAGE_WIDTH, MESSAGE_HEIGHT),
        HudPhase::Error => LogicalSize::new(MESSAGE_WIDTH, MESSAGE_HEIGHT),
        HudPhase::Recovery => LogicalSize::new(MESSAGE_WIDTH, RECOVERY_HEIGHT),
        HudPhase::Pending => LogicalSize::new(MESSAGE_WIDTH, PENDING_HEIGHT),
        HudPhase::Consent => LogicalSize::new(CONSENT_WIDTH, CONSENT_HEIGHT),
        _ => oriented_size(edge, ACTIVE_WIDTH, ACTIVE_HEIGHT),
    }
}

/// The companion footprint for one phase. Bolt alone for the resting and live
/// phases (the hovered rest adds the chord hint beside him); every card phase
/// keeps its card exactly as wide and tall as before and grows downward by the
/// height Bolt needs to stand under it holding it up.
fn companion_size(phase: HudPhase) -> LogicalSize<f64> {
    match phase {
        HudPhase::Idle if MENU_OPEN.load(Ordering::Relaxed) => {
            LogicalSize::new(COMPANION_MENU_WIDTH, COMPANION_MENU_HEIGHT)
        }
        HudPhase::Idle if IDLE_HOVERED.load(Ordering::Relaxed) => {
            LogicalSize::new(COMPANION_HOVER_WIDTH, COMPANION_REST_HEIGHT)
        }
        HudPhase::Idle | HudPhase::Listening | HudPhase::Transcribing | HudPhase::Inserted => {
            LogicalSize::new(COMPANION_REST_WIDTH, COMPANION_REST_HEIGHT)
        }
        HudPhase::Action | HudPhase::Error => {
            LogicalSize::new(MESSAGE_WIDTH, MESSAGE_HEIGHT + COMPANION_CARRY)
        }
        HudPhase::Recovery => LogicalSize::new(MESSAGE_WIDTH, RECOVERY_HEIGHT + COMPANION_CARRY),
        HudPhase::Pending => LogicalSize::new(MESSAGE_WIDTH, PENDING_HEIGHT + COMPANION_CARRY),
        HudPhase::Consent => LogicalSize::new(CONSENT_WIDTH, CONSENT_HEIGHT + COMPANION_CARRY),
    }
}

/// Where the companion window sits: inset from the two work-area edges that
/// meet at the chosen corner. The work area already excludes the taskbar and
/// the Dock, so a bottom corner lands above them rather than behind them.
fn companion_position(
    corner: CompanionCorner,
    work_pos: LogicalPosition<f64>,
    work_size: LogicalSize<f64>,
    size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    let x = if corner.is_right() {
        work_pos.x + work_size.width - size.width - COMPANION_INSET
    } else {
        work_pos.x + COMPANION_INSET
    };
    let y = if corner.is_top() {
        work_pos.y + COMPANION_INSET
    } else {
        work_pos.y + work_size.height - size.height - COMPANION_INSET
    };
    LogicalPosition::new(x, y)
}

/// True when the voice bar is currently docked to this same edge ON THIS SAME
/// display. Both surfaces are always-on-top and both anchor flush to the edge,
/// so without this they would draw on the same pixels the moment someone
/// dictates into a chat box during a live call.
fn voice_notch_shares_display(
    app: &AppHandle,
    full_pos: LogicalPosition<f64>,
    full_size: LogicalSize<f64>,
    scale: f64,
) -> bool {
    // Asks the overlay whether a Bar is actually drawn, not merely presented:
    // during a hold the Bar has lent this HUD its edge and is hidden, so there
    // is nothing to step aside from.
    if !overlay::bar_on_screen(app) {
        return false;
    }
    let Some(main) = overlay::main_window(app) else {
        return false;
    };
    let Ok(position) = main.outer_position() else {
        return false;
    };
    // Coarse containment on purpose: converting the main window's physical
    // origin with the TARGET display's scale is only approximate under mixed
    // DPI, and all this decides is whether to step out of the way.
    let origin = position.to_logical::<f64>(scale);
    origin.x >= full_pos.x
        && origin.x < full_pos.x + full_size.width
        && origin.y >= full_pos.y
        && origin.y < full_pos.y + full_size.height
}

/// Sizes and anchors the HUD for the current edge and phase. Called on every
/// show and on every transition into the failure pill, and it caches NOTHING:
/// the user can re-dock the notch between two holds, and an "already applied"
/// cache that outlives one failed resize is exactly the desync that froze the
/// sibling app's overlay (see CLAUDE.md).
fn place_window(app: &AppHandle, window: &tauri::WebviewWindow, target: isize, phase: HudPhase, has_caption: bool) {
    let edge = overlay::snapshot(app).notch_edge;
    // The stamped value React is rendering, never a fresh read: hover and the
    // overlay un-suppress place without emitting, so a live read that flipped
    // (a snooze running out) sized the window for Bolt while React still drew
    // the pill, stretched into a big dark bubble.
    let companion = last_update().companion;
    let size = surface_size(edge, phase, has_caption, companion);
    // At rest the companion stays on the display he was last dropped on; a
    // hold still takes him to the display of the window it is typing into.
    let rest_point = if companion && phase == HudPhase::Idle {
        *REST_POINT.lock().unwrap_or_else(|e| e.into_inner())
    } else {
        None
    };
    let monitor = rest_point
        .or_else(|| target_center(target))
        .and_then(|(x, y)| window.monitor_from_point(x, y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let full_size = monitor.size().to_logical::<f64>(scale);
    let full_pos = monitor.position().to_logical::<f64>(scale);
    let (work_pos, work_size) = overlay::work_area_within(full_pos, full_size, scale);
    if companion {
        // A corner is not the notch edge, so the step-aside below does not
        // apply: the bar is centred along its edge and never reaches a corner.
        let _ = window.set_size(size);
        let _ = window.set_position(companion_position(
            companion_corner(app),
            work_pos,
            work_size,
            size,
        ));
        return;
    }
    let mut position = overlay::bar_position(edge, work_pos, work_size, size);

    if voice_notch_shares_display(app, full_pos, full_size, scale) {
        // Step past the WHOLE bar window, not just the resting notch: whichever
        // card holds the slot grows the bar inward from this same edge, so a
        // fixed notch-sized inset lands the HUD inside the card. Clamped so a
        // tall card on a short display cannot push the HUD off screen.
        let inset = overlay::bar_cross_extent(app) + overlay::NOTCH_GAP;
        match edge {
            NotchEdge::Top => {
                position.y = (position.y + inset).min(work_pos.y + work_size.height - size.height);
            }
            NotchEdge::Bottom => position.y = (position.y - inset).max(work_pos.y),
            NotchEdge::Left => {
                position.x = (position.x + inset).min(work_pos.x + work_size.width - size.width);
            }
            NotchEdge::Right => position.x = (position.x - inset).max(work_pos.x),
        }
    }

    let _ = window.set_size(size);
    let _ = window.set_position(position);
}

/// Builds the window if needed, positions it on the monitor that owns `target`,
/// and shows it. Called on arm, never on prewarm: a user who never dictates
/// never pays for a second webview, and ordinary Ctrl or Win presses do not
/// silently create one.
pub fn show(app: &AppHandle, target: isize) {
    LAST_TARGET.store(target, Ordering::Relaxed);
    // An open chat slot (or a focused composer) also counts as "our own
    // window": the hold is aimed at the chat box, so the overlay must stay up
    // even though the OS foreground may already have drifted off it (see
    // `set_composer_focused` / `set_chat_slot_open`). Unless the foreground is
    // another Aura window such as the dashboard, which `chat_sink` rules out.
    TARGET_IS_SELF.store(
        target_is_overlay(app, target) || super::chat_sink(app, target),
        Ordering::Relaxed,
    );
    // Take the edge from the notch first: the overlay's hidden branch is what
    // lifts the suppression the guarded show() below checks. A self-targeted
    // hold never asks (see `edge_wanted`): the overlay stays visible, the HUD
    // stays suppressed, and the insert keeps its focused window.
    overlay::set_dictation_hold(app, edge_wanted(HudPhase::Listening));
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = build_window(&handle) {
            log::error!("dictation.hud: failed to create the HUD window: {e}");
            return;
        }
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, target, HudPhase::Listening, false);
            let _ = window.set_ignore_cursor_events(true);
            prepare_activation(&window, HudPhase::Listening);
            if !SUPPRESSED_BY_OVERLAY.load(Ordering::Relaxed) {
                let _ = window.show();
            }
            sync_activation(&window, HudPhase::Listening);
        }
    });
}

/// Creates and shows the passive resting pill without starting capture or
/// opening a transcription socket. The keyboard hook remains the only source
/// of Arm.
pub fn show_idle(app: &AppHandle) {
    IDLE_HOVERED.store(false, Ordering::Relaxed);
    MENU_OPEN.store(false, Ordering::Relaxed);
    // The resting pill targets nothing.
    TARGET_IS_SELF.store(false, Ordering::Relaxed);
    overlay::set_dictation_hold(app, false);
    let mut update = HudUpdate::new(HudPhase::Idle);
    update.stamp_placement(app);
    *LAST_UPDATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(update.clone());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = build_window(&handle) {
            log::error!("dictation.hud: failed to create the HUD window: {e}");
            return;
        }
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, LAST_TARGET.load(Ordering::Relaxed), HudPhase::Idle, false);
            let _ = window.set_ignore_cursor_events(false);
            prepare_activation(&window, HudPhase::Idle);
            if !SUPPRESSED_BY_OVERLAY.load(Ordering::Relaxed) {
                let _ = window.show();
            }
            sync_activation(&window, HudPhase::Idle);
            let _ = window.emit(crate::events::DICTATION_UPDATE, update);
        }
    });
}

pub fn set_hovered(app: &AppHandle, hovered: bool) {
    if last_update().phase != HudPhase::Idle {
        return;
    }
    IDLE_HOVERED.store(hovered, Ordering::Relaxed);
    let handle = app.clone();
    let target = LAST_TARGET.load(Ordering::Relaxed);
    let _ = app.run_on_main_thread(move || {
        if last_update().phase != HudPhase::Idle {
            IDLE_HOVERED.store(false, Ordering::Relaxed);
            return;
        }
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, target, HudPhase::Idle, false);
        }
    });
}

/// Re-applies the current geometry after the main notch changes edge or state.
pub fn refresh_placement(app: &AppHandle) {
    let handle = app.clone();
    let mut update = last_update();
    update.stamp_placement(app);
    let phase = update.phase;
    let has_caption = !update.text.is_empty();
    *LAST_UPDATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(update.clone());
    let target = LAST_TARGET.load(Ordering::Relaxed);
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, target, phase, has_caption);
            let _ = window.set_ignore_cursor_events(!accepts_clicks(phase));
            // The click menu is the one resting-state change that flips
            // activation, and it arrives through here rather than `publish`;
            // the same two halves, in the same order, as every other show site.
            prepare_activation(&window, phase);
            let _ = window.emit(crate::events::DICTATION_UPDATE, update);
            sync_activation(&window, phase);
        }
    });
}

pub fn hide(app: &AppHandle) {
    overlay::set_dictation_hold(app, false);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            let _ = window.hide();
        }
    });
}

/// Pushes one state update at the HUD. Safe to call from the worker thread.
/// The update is recorded before it is emitted, so a webview that has not
/// finished registering its listener can still pull the current state.
pub fn publish(app: &AppHandle, mut update: HudUpdate) {
    IDLE_HOVERED.store(false, Ordering::Relaxed);
    MENU_OPEN.store(false, Ordering::Relaxed);
    update.stamp_placement(app);
    update.own_target =
        update.phase != HudPhase::Idle && TARGET_IS_SELF.load(Ordering::Relaxed);
    let phase = update.phase;
    let has_caption = !update.text.is_empty();
    *LAST_UPDATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(update.clone());
    // After LAST_UPDATE is written: lifting the suppression places and shows
    // this window from `last_update()`, so it must already say this phase.
    // Any phase but Idle takes the edge from the notch; Idle hands it back,
    // and a self-targeted hold never asks in the first place (`edge_wanted`).
    overlay::set_dictation_hold(app, edge_wanted(phase));
    let defer_emit = resizes_into_card(phase);
    if !defer_emit {
        if let Some(window) = app.get_webview_window(DICTATION_WINDOW) {
            let _ = window.emit(crate::events::DICTATION_UPDATE, update.clone());
        }
    }
    let handle = app.clone();
    let target = LAST_TARGET.load(Ordering::Relaxed);
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(DICTATION_WINDOW) {
            place_window(&handle, &window, target, phase, has_caption);
            if defer_emit {
                let _ = window.emit(crate::events::DICTATION_UPDATE, update);
            }
            let _ = window.set_ignore_cursor_events(!accepts_clicks(phase));
            prepare_activation(&window, phase);
            if !SUPPRESSED_BY_OVERLAY.load(Ordering::Relaxed) {
                let _ = window.show();
            }
            // LAST, after both calls above: each one goes through tao's
            // apply_diff, which rewrites the whole ex-style from its own cached
            // flags and would drop anything set before it.
            sync_activation(&window, phase);
        }
    });
}

/// Called from `overlay::apply_result` on every real window transition,
/// including the ones this module triggers through `set_dictation_hold`.
/// Hides the pill the instant the Buddy overlay becomes visible, and restores
/// it to whatever `LAST_UPDATE` says it should be showing the instant the
/// overlay's window goes away, whether because it was dismissed or because a
/// hold borrowed its edge - not forced on, since dictation may not be running
/// at all. No-ops if the HUD window was never built (the user never armed
/// dictation), so summoning the overlay never creates one.
pub fn set_overlay_suppressed(app: &AppHandle, suppressed: bool) {
    SUPPRESSED_BY_OVERLAY.store(suppressed, Ordering::Relaxed);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(DICTATION_WINDOW) else {
            return;
        };
        if suppressed {
            let _ = window.hide();
            return;
        }
        let update = last_update();
        place_window(&handle, &window, LAST_TARGET.load(Ordering::Relaxed), update.phase, !update.text.is_empty());
        let _ = window.set_ignore_cursor_events(!accepts_clicks(update.phase));
        prepare_activation(&window, update.phase);
        let _ = window.show();
    });
}

/// Pushes one microphone level (0..1) at the HUD's waveform, roughly 20 times a
/// second and only while a hold is live.
///
/// Deliberately NOT recorded in `LAST_UPDATE`: a level is a transient reading,
/// and a webview that misses one gets the next in 50ms. Only captions need the
/// pull-on-mount path, because a caption that arrives before the listener
/// exists would otherwise leave the HUD blank.
///
/// This carries no speech, only loudness, so it is subject to the same rule as
/// everything else here: never logged, at any level.
pub fn publish_level(app: &AppHandle, level: f32) {
    if let Some(window) = app.get_webview_window(DICTATION_WINDOW) {
        let _ = window.emit(crate::events::DICTATION_LEVEL, level);
    }
}
