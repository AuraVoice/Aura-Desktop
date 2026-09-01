use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

const DOUBLE_TAP_MS: u32 = 400;

// Win32 virtual key codes for the double-tappable keys, spelled out so this
// predicate stays usable from targets that do not link the windows crate.
// Alt is deliberately absent: a lone Alt tap drops the focused window into
// Windows keyboard menu mode, the same failure as the 2026-07-16 notch lesson.
const VK_LCONTROL_CODE: u32 = 0xA2;
const VK_RCONTROL_CODE: u32 = 0xA3;
const VK_LSHIFT_CODE: u32 = 0xA0;
const VK_RSHIFT_CODE: u32 = 0xA1;
const VOICE_KEY_STORE: &str = "hotkeys.json";
const VOICE_KEY_SETTING: &str = "voiceToggleKey";
static VOICE_TOGGLE_VK: AtomicU32 = AtomicU32::new(VK_LCONTROL_CODE);
static TOGGLE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn configured_key_label() -> &'static str {
    match VOICE_TOGGLE_VK.load(Ordering::Relaxed) {
        VK_RCONTROL_CODE => "Right Ctrl",
        VK_LCONTROL_CODE => "Left Ctrl",
        VK_LSHIFT_CODE => "Left Shift",
        VK_RSHIFT_CODE => "Right Shift",
        _ => "custom shortcut",
    }
}

/// The accelerator sentinel matching the key the hook is currently watching.
/// Inverse of `vk_for_sentinel`.
fn configured_key_accelerator() -> &'static str {
    match VOICE_TOGGLE_VK.load(Ordering::Relaxed) {
        VK_RCONTROL_CODE => "ControlRight",
        VK_LSHIFT_CODE => "ShiftLeft",
        VK_RSHIFT_CODE => "ShiftRight",
        _ => "ControlLeft",
    }
}

/// `Some(vk)` when the accelerator names a double-tappable key, `None` when it
/// is a real modifier+key shortcut handled by the global-shortcut plugin.
fn vk_for_sentinel(accelerator: &str) -> Option<u32> {
    match accelerator {
        "ControlLeft" => Some(VK_LCONTROL_CODE),
        "ControlRight" => Some(VK_RCONTROL_CODE),
        "ShiftLeft" => Some(VK_LSHIFT_CODE),
        "ShiftRight" => Some(VK_RSHIFT_CODE),
        _ => None,
    }
}

/// True when `vk` is the key this listener treats as the voice toggle. The
/// dictation chord derives its own voice-toggle suppression from this rather
/// than hardcoding "Left Ctrl", so changing either constant keeps the two in
/// agreement.
pub fn is_voice_toggle_vk(vk: u32) -> bool {
    vk == VOICE_TOGGLE_VK.load(Ordering::Relaxed)
}

pub fn use_default_toggle_key() {
    VOICE_TOGGLE_VK.store(VK_LCONTROL_CODE, Ordering::Relaxed);
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tap {
    Single,
    Double,
}

struct TapClassifier {
    last_tap_ms: Option<u32>,
    threshold_ms: u32,
}

impl TapClassifier {
    fn new(threshold_ms: u32) -> Self {
        Self {
            last_tap_ms: None,
            threshold_ms,
        }
    }

    fn classify(&mut self, now_ms: u32) -> Tap {
        if let Some(last_tap_ms) = self.last_tap_ms {
            if now_ms.wrapping_sub(last_tap_ms) <= self.threshold_ms {
                self.last_tap_ms = None;
                return Tap::Double;
            }
        }
        self.last_tap_ms = Some(now_ms);
        Tap::Single
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceToggleKeyStatus {
    pub available: bool,
    pub key_label: String,
    pub accelerator: String,
    pub keys: Vec<String>,
    pub gesture: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub struct VoiceToggleKeyHandle {
    status: VoiceToggleKeyStatus,
    #[cfg(target_os = "windows")]
    hook_thread_id: u32,
    #[cfg(target_os = "windows")]
    hook_thread: Option<std::thread::JoinHandle<()>>,
    #[cfg(target_os = "macos")]
    run_loop: Option<RunLoopHandle>,
    #[cfg(target_os = "macos")]
    tap_thread: Option<std::thread::JoinHandle<()>>,
}

/// The listener thread's run loop, so `Drop` can ask it to return from
/// `CFRunLoopRun`.
///
/// `CFRunLoop` is thread-safe for exactly this call - `CFRunLoopStop` is
/// documented as callable from any thread - but `CFRetained` is conservatively
/// not `Send`, so the promise is made here rather than by ignoring it at the
/// call site. This mirrors the Windows side's rule that only a raw thread id
/// crosses threads, never a live handle: nothing else is ever done with this
/// value.
#[cfg(target_os = "macos")]
struct RunLoopHandle(objc2_core_foundation::CFRetained<objc2_core_foundation::CFRunLoop>);

#[cfg(target_os = "macos")]
unsafe impl Send for RunLoopHandle {}
#[cfg(target_os = "macos")]
unsafe impl Sync for RunLoopHandle {}

impl VoiceToggleKeyHandle {
    pub fn status(&self) -> VoiceToggleKeyStatus {
        self.status.clone()
    }
}

#[tauri::command]
pub fn voice_toggle_key_status(
    state: tauri::State<'_, VoiceToggleKeyHandle>,
    hotkeys: tauri::State<'_, crate::hotkeys::HotkeyState>,
) -> VoiceToggleKeyStatus {
    let mut status = state.status();
    apply_current_binding(&mut status, &hotkeys);
    status
}

pub fn start(app: AppHandle) -> VoiceToggleKeyHandle {
    if let Ok(store) = app.store(VOICE_KEY_STORE) {
        let saved = store.get(VOICE_KEY_SETTING).and_then(|value| value.as_str().map(str::to_string));
        // A custom modifier+key shortcut parks the hook on vk 0, which no key
        // ever reports, so the double-tap path can never fire alongside it.
        let vk = match saved.as_deref() {
            None => VK_LCONTROL_CODE,
            Some(accelerator) => vk_for_sentinel(accelerator).unwrap_or(0),
        };
        VOICE_TOGGLE_VK.store(vk, Ordering::Relaxed);
    }
    platform::start(app)
}

#[tauri::command]
pub fn set_voice_toggle_key(
    app: AppHandle,
    state: tauri::State<'_, VoiceToggleKeyHandle>,
    hotkeys: tauri::State<'_, crate::hotkeys::HotkeyState>,
    key_code: String,
) -> Result<VoiceToggleKeyStatus, String> {
    let vk = vk_for_sentinel(&key_code).unwrap_or(0);
    if let Err(err) = crate::hotkeys::set_voice_binding(&app, &hotkeys, &key_code) {
        let mut status = state.status();
        apply_current_binding(&mut status, &hotkeys);
        let _ = app.emit(crate::events::VOICE_TOGGLE_KEY_CHANGED, &status);
        return Err(err);
    }
    VOICE_TOGGLE_VK.store(vk, Ordering::Relaxed);
    let mut status = state.status();
    apply_current_binding(&mut status, &hotkeys);
    let _ = app.emit(crate::events::VOICE_TOGGLE_KEY_CHANGED, &status);
    Ok(status)
}

fn apply_current_binding(status: &mut VoiceToggleKeyStatus, hotkeys: &crate::hotkeys::HotkeyState) {
    if let Some((accelerator, keys, registered)) = crate::hotkeys::voice_binding(hotkeys) {
        status.available = registered;
        status.reason = None;
        status.key_label = keys.join(" + ");
        status.accelerator = accelerator;
        status.keys = keys;
        status.gesture = "press".to_string();
        if !registered {
            status.reason = Some("That shortcut is currently held by Windows or another app.".to_string());
        }
    } else {
        let label = configured_key_label().to_string();
        status.accelerator = configured_key_accelerator().to_string();
        status.keys = vec![label.clone()];
        status.key_label = label;
        status.gesture = "doubleTap".to_string();
    }
}

/// Re-publishes the voice trigger status after something other than
/// `set_voice_toggle_key` changed it (currently the reset command).
pub fn emit_status_changed(app: &AppHandle) {
    let Some(handle) = app.try_state::<VoiceToggleKeyHandle>() else { return };
    let hotkeys = app.state::<crate::hotkeys::HotkeyState>();
    let mut status = handle.status();
    apply_current_binding(&mut status, &hotkeys);
    let _ = app.emit(crate::events::VOICE_TOGGLE_KEY_CHANGED, &status);
}

pub fn emit_toggle(app: &AppHandle) {
    let sequence = TOGGLE_SEQUENCE.fetch_add(1, Ordering::Relaxed).saturating_add(1);
    let emitted_at_ms = crate::util::now_ms_u64();
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.emit(
            crate::events::AURA_TOGGLE,
            serde_json::json!({
                "sequence": sequence,
                "emittedAtMs": emitted_at_ms,
            }),
        ) {
            log::error!("voice_toggle_key: failed to emit sequence={sequence}: {err}");
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for VoiceToggleKeyHandle {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};

        if self.hook_thread_id != 0 {
            // The hook owns a GetMessageW loop, so posting WM_QUIT asks that
            // same thread to unhook before it exits. Never tear the hook down
            // from the low-level keyboard callback itself.
            unsafe {
                let _ = PostThreadMessageW(
                    self.hook_thread_id,
                    WM_QUIT,
                    WPARAM::default(),
                    LPARAM::default(),
                );
            }
        }
        if let Some(thread) = self.hook_thread.take() {
            let _ = thread.join();
        }
    }
}

/// The per-hold state behind the isolated-tap gesture.
///
/// Lives at file level rather than inside a platform module because both the
/// Windows low-level hook and the macOS event tap drive exactly this state
/// machine; only the way key events reach it differs. Its tests below run on
/// both platforms for the same reason.
#[derive(Default)]
struct TapState {
    toggle_key_held: bool,
    candidate: bool,
    /// Set for the rest of the current hold once the dictation chord was
    /// engaged during it. Needed because the plain chord-cancel branch
    /// below only sees a partner key going down DURING the hold: with
    /// Ctrl+Win, pressing Win first and Ctrl second leaves the cancel
    /// branch untouched, so the Ctrl keyup would emit a toggle and two
    /// dictations inside DOUBLE_TAP_MS would open a cloud voice call.
    suppressed: bool,
}

impl TapState {
    fn observe(
        &mut self,
        is_toggle_key: bool,
        is_down: bool,
        is_up: bool,
        dictation_engaged: bool,
    ) -> bool {
        if is_toggle_key && is_down {
            if !self.toggle_key_held {
                self.toggle_key_held = true;
                self.candidate = true;
                // A fresh hold starts clean, so a suppression flag left
                // behind by a keyup this hook never saw (lock screen, fast
                // user switch) cannot swallow the next legitimate tap.
                self.suppressed = false;
            }
            self.suppressed |= dictation_engaged;
            return false;
        }
        self.suppressed |= dictation_engaged;
        if is_down && self.toggle_key_held {
            self.candidate = false;
            return false;
        }
        if is_toggle_key && is_up {
            let should_emit = self.toggle_key_held && self.candidate && !self.suppressed;
            self.toggle_key_held = false;
            self.candidate = false;
            self.suppressed = false;
            return should_emit;
        }
        false
    }
}

fn observe_physical_key_event(
    state: &mut TapState,
    is_toggle_key: bool,
    is_down: bool,
    is_up: bool,
    is_injected: bool,
    dictation_engaged: bool,
) -> bool {
    if is_injected {
        return false;
    }
    state.observe(is_toggle_key, is_down, is_up, dictation_engaged)
}

#[cfg(test)]
mod tests {
    use super::{observe_physical_key_event, TapState};

    #[test]
    fn isolated_tap_emits_once_and_repeat_does_not_rearm() {
        let mut state = TapState::default();
        assert!(!state.observe(true, true, false, false));
        assert!(!state.observe(true, true, false, false));
        assert!(state.observe(true, false, true, false));
        assert!(!state.observe(true, false, true, false));
    }

    #[test]
    fn chord_cancels_until_toggle_key_is_released() {
        let mut state = TapState::default();
        assert!(!state.observe(true, true, false, false));
        assert!(!state.observe(false, true, false, false));
        assert!(!state.observe(true, true, false, false));
        assert!(!state.observe(true, false, true, false));
    }

    #[test]
    fn injected_focus_key_does_not_cancel_physical_ctrl_tap() {
        let mut state = TapState::default();
        assert!(!observe_physical_key_event(
            &mut state, true, true, false, false, false,
        ));
        assert!(!observe_physical_key_event(
            &mut state, false, true, false, true, false,
        ));
        assert!(observe_physical_key_event(
            &mut state, true, false, true, false, false,
        ));
    }
}

/// The tap owns a `CFRunLoopRun`, so stopping that loop is what asks the thread
/// to disable the tap and exit. Never tear the tap down from inside its own
/// callback, for the same reason the Windows side never unhooks from inside the
/// hook procedure.
#[cfg(target_os = "macos")]
impl Drop for VoiceToggleKeyHandle {
    fn drop(&mut self) {
        if let Some(run_loop) = self.run_loop.take() {
            run_loop.0.stop();
        }
        if let Some(thread) = self.tap_thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::cell::RefCell;
    use std::mem::MaybeUninit;
    use std::sync::mpsc;

    use log::{error, info};
    use tauri::AppHandle;
    use tokio::sync::mpsc as tokio_mpsc;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
        PM_NOREMOVE, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use crate::dictation::chord::{ChordState, DICTATION_CHORD};

    use super::{
        configured_key_label, is_voice_toggle_vk, observe_physical_key_event, Tap, TapClassifier,
        TapState, VoiceToggleKeyHandle, VoiceToggleKeyStatus, DOUBLE_TAP_MS,
    };

    thread_local! {
        static EVENT_SENDER: RefCell<Option<tokio_mpsc::UnboundedSender<()>>> = const { RefCell::new(None) };
        static TAP_STATE: RefCell<TapState> = RefCell::new(TapState::default());
        static CHORD_STATE: RefCell<ChordState> = RefCell::new(ChordState::default());
    }


    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // KBDLLHOOKSTRUCT is supplied by Windows for this callback and is
            // valid only for the duration of the call. We inspect only the
            // key needed to identify the configured isolated Ctrl tap. No key data
            // is logged, persisted, or sent outside this process.
            let event = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let message = wparam.0 as u32;
            let is_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            let is_up = message == WM_KEYUP || message == WM_SYSKEYUP;
            let is_injected = event.flags.contains(LLKHF_INJECTED);
            // Dictation shares this one hook on purpose: ordering between two
            // WH_KEYBOARD_LL hooks in a single process is installation-order
            // dependent, so a second hook could see these events either before
            // or after this one. Injected events are excluded here as well, or
            // the Win guard's own synthetic VK_LWIN keyup would read as the
            // user releasing the chord mid-insert.
            let chord_outcome = if is_injected {
                None
            } else {
                Some(CHORD_STATE.with(|state| {
                    state
                        .borrow_mut()
                        .observe(event.vkCode, is_down, is_up)
                }))
            };
            if let Some(signal) = chord_outcome.as_ref().and_then(|outcome| outcome.signal) {
                crate::dictation::signal(signal);
            }
            // Escape is the escape hatch for held dictation text. Gated on the
            // flag so an ordinary Escape (every dialog, every editor, all day)
            // is one relaxed atomic load in this hook and nothing else.
            if is_down
                && !is_injected
                && event.vkCode == VK_ESCAPE.0 as u32
                && crate::dictation::is_holding_text()
            {
                crate::dictation::signal(
                    crate::dictation::chord::ChordSignal::CancelPending,
                );
            }
            // Only a chord that actually contains the voice toggle key needs
            // the classifier suppressed; DICTATION_CHORD::RightCtrlOnly (with
            // VOICE_TOGGLE_KEY on Left Ctrl) turns this off by itself.
            let dictation_engaged = DICTATION_CHORD.suppresses_voice_toggle()
                && chord_outcome.is_some_and(|outcome| outcome.engaged);
            let is_toggle_key = is_voice_toggle_vk(event.vkCode);

            let should_emit = TAP_STATE.with(|state| {
                observe_physical_key_event(
                    &mut state.borrow_mut(),
                    is_toggle_key,
                    is_down,
                    is_up,
                    is_injected,
                    dictation_engaged,
                )
            });
            if should_emit {
                EVENT_SENDER.with(|sender| {
                    if let Some(sender) = sender.borrow().as_ref() {
                        let _ = sender.send(());
                    }
                });
            }
        }

        // The configured Ctrl event always continues to Windows and other apps,
        // whether it became a voice toggle or part of a normal shortcut.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub fn start(app: AppHandle) -> VoiceToggleKeyHandle {
        let (event_tx, mut event_rx) = tokio_mpsc::unbounded_channel::<()>();
        let (startup_tx, startup_rx) = mpsc::sync_channel::<Result<u32, String>>(1);

        let hook_thread = std::thread::Builder::new()
            .name("aura-voice-toggle-key".to_string())
            .spawn(move || {
                let thread_id = unsafe { GetCurrentThreadId() };
                // Create the thread's message queue before publishing its id.
                // That guarantees Drop can post WM_QUIT even if shutdown races
                // the first blocking GetMessageW call.
                let mut priming_message = MSG::default();
                unsafe {
                    let _ = PeekMessageW(&mut priming_message, None, 0, 0, PM_NOREMOVE);
                }
                EVENT_SENDER.with(|sender| *sender.borrow_mut() = Some(event_tx));

                let module = match unsafe { GetModuleHandleW(None) } {
                    Ok(module) => module,
                    Err(err) => {
                        let _ = startup_tx.send(Err(format!(
                            "listener module handle unavailable: {err}"
                        )));
                        EVENT_SENDER.with(|sender| sender.borrow_mut().take());
                        return;
                    }
                };
                let hook = unsafe {
                    SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(keyboard_hook),
                        Some(HINSTANCE::from(module)),
                        0,
                    )
                };
                let hook = match hook {
                    Ok(hook) => hook,
                    Err(err) => {
                        let _ = startup_tx.send(Err(err.to_string()));
                        EVENT_SENDER.with(|sender| sender.borrow_mut().take());
                        return;
                    }
                };

                let _ = startup_tx.send(Ok(thread_id));
                let mut message = MaybeUninit::<MSG>::zeroed();
                loop {
                    let result = unsafe { GetMessageW(message.as_mut_ptr(), None, 0, 0) };
                    if result.0 <= 0 {
                        break;
                    }
                    let message = unsafe { message.assume_init_ref() };
                    unsafe {
                        let _ = TranslateMessage(message);
                        DispatchMessageW(message);
                    }
                }

                if let Err(err) = unsafe { UnhookWindowsHookEx(hook) } {
                    error!("voice_toggle_key: failed to unhook cleanly: {err}");
                }
                EVENT_SENDER.with(|sender| sender.borrow_mut().take());
            });

        let hook_thread = match hook_thread {
            Ok(thread) => thread,
            Err(err) => {
                let reason = format!("listener thread could not start: {err}");
                report_failure(&reason);
                return VoiceToggleKeyHandle {
                    status: VoiceToggleKeyStatus {
                        available: false,
                        key_label: configured_key_label().to_string(),
                        accelerator: String::new(),
                        keys: Vec::new(),
                        gesture: String::new(),
                        reason: Some(reason),
                    },
                    hook_thread_id: 0,
                    hook_thread: None,
                };
            }
        };

        match startup_rx.recv() {
            Ok(Ok(hook_thread_id)) => {
                info!(
                    "voice_toggle_key: {} listener installed",
                    configured_key_label()
                );
                tauri::async_runtime::spawn(async move {
                    let started_at = std::time::Instant::now();
                    let mut classifier = TapClassifier::new(DOUBLE_TAP_MS);
                    while event_rx.recv().await.is_some() {
                        let now_ms = started_at.elapsed().as_millis() as u32;
                        let previous_tap_ms = classifier.last_tap_ms;
                        let interval_ms =
                            previous_tap_ms.map(|last_tap_ms| now_ms.wrapping_sub(last_tap_ms));
                        if classifier.classify(now_ms) != Tap::Double {
                            if cfg!(debug_assertions) {
                                if let Some(interval_ms) = interval_ms {
                                    info!(
                                        "voice_toggle_key: tap interval={interval_ms}ms exceeded threshold={DOUBLE_TAP_MS}ms; latest tap starts a new pair"
                                    );
                                } else {
                                    info!(
                                        "voice_toggle_key: first tap registered; waiting threshold={DOUBLE_TAP_MS}ms"
                                    );
                                }
                            }
                            continue;
                        }
                        let interval_ms = interval_ms.unwrap_or(0);
                        info!(
                            "voice_toggle_key: emitting toggle interval={interval_ms}ms"
                        );
                        if crate::hotkeys::intercept_voice_test(&app) {
                            continue;
                        }
                        super::emit_toggle(&app);
                    }
                });
                VoiceToggleKeyHandle {
                    status: VoiceToggleKeyStatus {
                        available: true,
                        key_label: configured_key_label().to_string(),
                        accelerator: String::new(),
                        keys: Vec::new(),
                        gesture: String::new(),
                        reason: None,
                    },
                    hook_thread_id,
                    hook_thread: Some(hook_thread),
                }
            }
            Ok(Err(reason)) => {
                report_failure(&reason);
                let _ = hook_thread.join();
                VoiceToggleKeyHandle {
                    status: VoiceToggleKeyStatus {
                        available: false,
                        key_label: configured_key_label().to_string(),
                        accelerator: String::new(),
                        keys: Vec::new(),
                        gesture: String::new(),
                        reason: Some(reason),
                    },
                    hook_thread_id: 0,
                    hook_thread: None,
                }
            }
            Err(err) => {
                let reason = format!("listener startup channel closed: {err}");
                report_failure(&reason);
                let _ = hook_thread.join();
                VoiceToggleKeyHandle {
                    status: VoiceToggleKeyStatus {
                        available: false,
                        key_label: configured_key_label().to_string(),
                        accelerator: String::new(),
                        keys: Vec::new(),
                        gesture: String::new(),
                        reason: Some(reason),
                    },
                    hook_thread_id: 0,
                    hook_thread: None,
                }
            }
        }
    }

    fn report_failure(reason: &str) {
        error!("voice_toggle_key: listener unavailable: {reason}");
        if !cfg!(debug_assertions) {
            sentry::capture_message(
                &format!("voice_toggle_key: listener unavailable: {reason}"),
                sentry::Level::Error,
            );
        }
    }

}

#[cfg(test)]
mod tap_classifier_tests {
    use super::{Tap, TapClassifier, DOUBLE_TAP_MS};

    #[test]
    fn taps_within_threshold_classify_as_double_and_reset() {
        let mut classifier = TapClassifier::new(DOUBLE_TAP_MS);
        assert_eq!(classifier.classify(1_000), Tap::Single);
        assert_eq!(classifier.classify(1_400), Tap::Double);
        assert_eq!(classifier.classify(1_401), Tap::Single);
    }

    #[test]
    fn tap_after_threshold_starts_a_new_pair() {
        let mut classifier = TapClassifier::new(DOUBLE_TAP_MS);
        assert_eq!(classifier.classify(2_000), Tap::Single);
        assert_eq!(classifier.classify(2_401), Tap::Single);
        assert_eq!(classifier.classify(2_800), Tap::Double);
    }

    #[test]
    fn four_quick_taps_produce_two_independent_double_taps() {
        let mut classifier = TapClassifier::new(DOUBLE_TAP_MS);
        assert_eq!(classifier.classify(3_000), Tap::Single);
        assert_eq!(classifier.classify(3_200), Tap::Double);
        assert_eq!(classifier.classify(3_300), Tap::Single);
        assert_eq!(classifier.classify(3_500), Tap::Double);
    }

    #[test]
    fn timestamp_wraparound_preserves_a_short_interval() {
        let mut classifier = TapClassifier::new(DOUBLE_TAP_MS);
        assert_eq!(classifier.classify(u32::MAX - 100), Tap::Single);
        assert_eq!(classifier.classify(99), Tap::Double);
    }
}

/// The CGEventTap listener: macOS's WH_KEYBOARD_LL.
///
/// Deliberately the same shape as the Windows hook above - one dedicated thread
/// owning a run loop, torn down from `Drop`, feeding the SAME `TapState` and
/// `ChordState` - because the gesture logic is identical and only the delivery
/// mechanism differs. Three things ARE genuinely different:
///
/// 1. **Listen-only.** The Windows hook always calls `CallNextHookEx` and never
///    suppresses anything, so nothing is being intercepted here either.
///    `ListenOnly` says that to the OS explicitly, and it is what makes this
///    need the Input Monitoring grant rather than the heavier one.
/// 2. **A tap can be switched off underneath us.** macOS disables a tap whose
///    callback is too slow (`TapDisabledByTimeout`) or during certain user
///    input (`TapDisabledByUserInput`), and it does so silently - dictation
///    would simply stop responding with nothing in any log. Re-enabling on
///    those two event types is not optional.
/// 3. **There is no LLKHF_INJECTED.** The insert path stamps every event it
///    posts with `INJECTED_EVENT_MARKER` instead, and this drops them, so the
///    modifier release during an insert cannot read as the user letting go of
///    the chord.
#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::sync::mpsc;

    use log::{error, info, warn};
    use objc2_core_foundation::{kCFRunLoopCommonModes, CFMachPort, CFRetained, CFRunLoop};
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventTapProxy, CGEventType,
    };
    use tauri::AppHandle;
    use tokio::sync::mpsc as tokio_mpsc;

    use crate::dictation::chord::{ChordState, DICTATION_CHORD};
    use crate::macos_input::{vk_for_keycode, INJECTED_EVENT_MARKER};

    use super::{
        configured_key_label, is_voice_toggle_vk, observe_physical_key_event, RunLoopHandle, Tap,
        TapClassifier, TapState, VoiceToggleKeyHandle, VoiceToggleKeyStatus, DOUBLE_TAP_MS,
    };

    thread_local! {
        static EVENT_SENDER: RefCell<Option<tokio_mpsc::UnboundedSender<()>>> = const { RefCell::new(None) };
        static TAP_STATE: RefCell<TapState> = RefCell::new(TapState::default());
        static CHORD_STATE: RefCell<ChordState> = RefCell::new(ChordState::default());
        // Which modifiers were down at the previous flagsChanged. A flagsChanged
        // event says WHICH key changed but not whether it went down or up, so
        // that is derived by diffing against this.
        static MODIFIERS_DOWN: RefCell<Vec<u16>> = const { RefCell::new(Vec::new()) };
    }

    // The tap's own port, kept so the callback can re-enable it after macOS
    // disables it. Only ever touched on the tap thread.
    thread_local! {
        static TAP_PORT: RefCell<Option<CFRetained<CFMachPort>>> = const { RefCell::new(None) };
    }

    fn mask_for(event_type: CGEventType) -> u64 {
        1u64 << event_type.0
    }

    unsafe extern "C-unwind" fn tap_callback(
        _proxy: CGEventTapProxy,
        event_type: CGEventType,
        event: std::ptr::NonNull<CGEvent>,
        _user_info: *mut std::ffi::c_void,
    ) -> *mut CGEvent {
        // macOS turned the tap off. Turning it back on here is the whole
        // recovery path; without it the tap stays dead for the rest of the
        // process and dictation silently stops responding.
        if event_type == CGEventType::TapDisabledByTimeout
            || event_type == CGEventType::TapDisabledByUserInput
        {
            warn!("voice_toggle_key: event tap was disabled by the system, re-enabling");
            TAP_PORT.with(|port| {
                if let Some(port) = port.borrow().as_ref() {
                    CGEvent::tap_enable(port, true);
                }
            });
            return event.as_ptr();
        }

        let event_ref = unsafe { event.as_ref() };
        let keycode = CGEvent::integer_value_field(
            Some(event_ref),
            CGEventField::KeyboardEventKeycode,
        ) as u16;
        // Our own posted keystrokes carry the marker. Excluded for the same
        // reason the Windows hook excludes LLKHF_INJECTED: the modifier release
        // during an insert would otherwise read as the user letting go.
        let is_injected = CGEvent::integer_value_field(
            Some(event_ref),
            CGEventField::EventSourceUserData,
        ) == INJECTED_EVENT_MARKER;

        // A flagsChanged event names the key that changed but not its
        // direction, so track which modifiers are currently down and diff.
        let (is_down, is_up) = match event_type {
            CGEventType::KeyDown => (true, false),
            CGEventType::KeyUp => (false, true),
            CGEventType::FlagsChanged => MODIFIERS_DOWN.with(|held| {
                let mut held = held.borrow_mut();
                match held.iter().position(|candidate| *candidate == keycode) {
                    Some(index) => {
                        held.remove(index);
                        (false, true)
                    }
                    None => {
                        held.push(keycode);
                        (true, false)
                    }
                }
            }),
            _ => (false, false),
        };
        if !is_down && !is_up {
            return event.as_ptr();
        }

        let Some(vk) = vk_for_keycode(keycode) else {
            // An ordinary character key. It is neither a chord key nor the
            // voice trigger, so nothing below can care about it.
            return event.as_ptr();
        };

        let chord_outcome = if is_injected {
            None
        } else {
            Some(CHORD_STATE.with(|state| state.borrow_mut().observe(vk, is_down, is_up)))
        };
        if let Some(signal) = chord_outcome.as_ref().and_then(|outcome| outcome.signal) {
            crate::dictation::signal(signal);
        }
        // Escape is the escape hatch for held dictation text. Gated on the flag
        // so an ordinary Escape (every dialog, every editor, all day) is one
        // relaxed atomic load here and nothing else.
        const VK_ESCAPE: u32 = 0x1B;
        if is_down && !is_injected && vk == VK_ESCAPE && crate::dictation::is_holding_text() {
            crate::dictation::signal(crate::dictation::chord::ChordSignal::CancelPending);
        }
        // Only a chord that actually contains the voice toggle key needs the
        // classifier suppressed.
        let dictation_engaged = DICTATION_CHORD.suppresses_voice_toggle()
            && chord_outcome.is_some_and(|outcome| outcome.engaged);
        let is_toggle_key = is_voice_toggle_vk(vk);

        let should_emit = TAP_STATE.with(|state| {
            observe_physical_key_event(
                &mut state.borrow_mut(),
                is_toggle_key,
                is_down,
                is_up,
                is_injected,
                dictation_engaged,
            )
        });
        if should_emit {
            EVENT_SENDER.with(|sender| {
                if let Some(sender) = sender.borrow().as_ref() {
                    let _ = sender.send(());
                }
            });
        }

        // The event always continues to the system and other apps, whether it
        // became a voice toggle or part of a normal shortcut.
        event.as_ptr()
    }

    pub fn start(app: AppHandle) -> VoiceToggleKeyHandle {
        let (event_tx, mut event_rx) = tokio_mpsc::unbounded_channel::<()>();
        // RunLoopHandle rather than the bare CFRetained: this value crosses
        // from the tap thread back to the caller, and the handle is where the
        // "stopping a run loop from another thread is allowed" promise lives.
        let (startup_tx, startup_rx) = mpsc::sync_channel::<Result<RunLoopHandle, String>>(1);

        let tap_thread = std::thread::Builder::new()
            .name("aura-voice-toggle-key".to_string())
            .spawn(move || {
                EVENT_SENDER.with(|sender| *sender.borrow_mut() = Some(event_tx));

                let mask = mask_for(CGEventType::KeyDown)
                    | mask_for(CGEventType::KeyUp)
                    | mask_for(CGEventType::FlagsChanged);
                let port = unsafe {
                    CGEvent::tap_create(
                        CGEventTapLocation::SessionEventTap,
                        CGEventTapPlacement::HeadInsertEventTap,
                        CGEventTapOptions::ListenOnly,
                        mask,
                        Some(tap_callback),
                        std::ptr::null_mut(),
                    )
                };
                let Some(port) = port else {
                    // The only realistic cause is a missing Input Monitoring
                    // grant, so say that rather than a bare null.
                    let _ = startup_tx.send(Err(
                        "Aura needs Input Monitoring access to watch for the voice trigger."
                            .to_string(),
                    ));
                    EVENT_SENDER.with(|sender| sender.borrow_mut().take());
                    return;
                };

                let source = CFMachPort::new_run_loop_source(None, Some(&port), 0);
                let Some(run_loop) = CFRunLoop::current() else {
                    let _ = startup_tx.send(Err("no run loop on the listener thread".to_string()));
                    EVENT_SENDER.with(|sender| sender.borrow_mut().take());
                    return;
                };
                run_loop.add_source(source.as_deref(), unsafe { kCFRunLoopCommonModes });
                CGEvent::tap_enable(&port, true);
                TAP_PORT.with(|slot| *slot.borrow_mut() = Some(port));

                // Publish the run loop only once the tap is live, so Drop can
                // never stop a loop that has not started.
                let _ = startup_tx.send(Ok(RunLoopHandle(run_loop)));
                CFRunLoop::run();

                TAP_PORT.with(|slot| {
                    if let Some(port) = slot.borrow_mut().take() {
                        CGEvent::tap_enable(&port, false);
                    }
                });
                EVENT_SENDER.with(|sender| sender.borrow_mut().take());
            });

        let tap_thread = match tap_thread {
            Ok(thread) => thread,
            Err(err) => {
                let reason = format!("listener thread could not start: {err}");
                report_failure(&reason);
                return unavailable(reason);
            }
        };

        match startup_rx.recv() {
            Ok(Ok(handle)) => {
                info!(
                    "voice_toggle_key: {} listener installed",
                    configured_key_label()
                );
                tauri::async_runtime::spawn(async move {
                    let started_at = std::time::Instant::now();
                    let mut classifier = TapClassifier::new(DOUBLE_TAP_MS);
                    while event_rx.recv().await.is_some() {
                        let now_ms = started_at.elapsed().as_millis() as u32;
                        if classifier.classify(now_ms) != Tap::Double {
                            continue;
                        }
                        info!("voice_toggle_key: emitting toggle");
                        if crate::hotkeys::intercept_voice_test(&app) {
                            continue;
                        }
                        super::emit_toggle(&app);
                    }
                });
                VoiceToggleKeyHandle {
                    status: VoiceToggleKeyStatus {
                        available: true,
                        key_label: configured_key_label().to_string(),
                        accelerator: String::new(),
                        keys: Vec::new(),
                        gesture: String::new(),
                        reason: None,
                    },
                    run_loop: Some(handle),
                    tap_thread: Some(tap_thread),
                }
            }
            Ok(Err(reason)) => {
                report_failure(&reason);
                let _ = tap_thread.join();
                unavailable(reason)
            }
            Err(err) => {
                let reason = format!("listener startup channel closed: {err}");
                report_failure(&reason);
                unavailable(reason)
            }
        }
    }

    fn unavailable(reason: String) -> VoiceToggleKeyHandle {
        VoiceToggleKeyHandle {
            status: VoiceToggleKeyStatus {
                available: false,
                key_label: configured_key_label().to_string(),
                accelerator: String::new(),
                keys: Vec::new(),
                gesture: String::new(),
                reason: Some(reason),
            },
            run_loop: None,
            tap_thread: None,
        }
    }

    fn report_failure(reason: &str) {
        error!("voice_toggle_key: listener unavailable: {reason}");
        if !cfg!(debug_assertions) {
            sentry::capture_message(
                &format!("voice_toggle_key: listener unavailable: {reason}"),
                sentry::Level::Error,
            );
        }
    }
}

/// Everything else keeps the previous behaviour: no listener, and a status that
/// says so.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use tauri::AppHandle;

    use super::{configured_key_label, VoiceToggleKeyHandle, VoiceToggleKeyStatus};

    pub fn start(_app: AppHandle) -> VoiceToggleKeyHandle {
        VoiceToggleKeyHandle {
            status: VoiceToggleKeyStatus {
                available: false,
                key_label: configured_key_label().to_string(),
                accelerator: String::new(),
                keys: Vec::new(),
                gesture: String::new(),
                reason: Some("Voice key toggling is not available on this platform.".to_string()),
            },
        }
    }
}
