use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_store::StoreExt;

use crate::{dashboard, guide, overlay, security};

const HOTKEY_STORE: &str = "hotkeys.json";
const HOTKEYS_KEY: &str = "bindings";
const VOICE_KEY_SETTING: &str = "voiceToggleKey";
/// A webview that dies without calling `end_hotkey_test` must not swallow the
/// shortcut forever, so an armed test expires. The tour re-arms with the same
/// owner every 120s (TEST_REARM_MS in HotkeyTourStep.tsx) to hold the deadline
/// open while its screen is genuinely showing; shortening this below that
/// interval silently disarms a screen that still says "Press it now".
const TEST_TIMEOUT: Duration = Duration::from_secs(300);
/// The voice trigger is not in SPECS, so it needs its own label for conflict
/// messages. Keep in sync with the tour's "Start or end voice".
const VOICE_LABEL: &str = "Start or end voice";

/// Voice accelerator values that mean "no global shortcut, use the low-level
/// double-tap hook instead". Kept here because both `set_voice_binding` and
/// `initialize` have to route them away from `Shortcut::from_str`.
/// macOS also allows Option taps (the Claude Desktop convention); Windows must
/// not, because a lone Alt tap drops the focused window into keyboard menu
/// mode - see voice_toggle_key.rs.
#[cfg(not(target_os = "macos"))]
pub const DOUBLE_TAP_SENTINELS: [&str; 4] = ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"];
#[cfg(target_os = "macos")]
pub const DOUBLE_TAP_SENTINELS: [&str; 6] =
    ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight"];

/// The OS name used in "someone else owns that shortcut" errors.
#[cfg(not(target_os = "macos"))]
const OS_NAME: &str = "Windows";
#[cfg(target_os = "macos")]
const OS_NAME: &str = "macOS";

/// Option+Space on macOS: the AI-assistant convention (ChatGPT, Gemini and
/// Copilot all summon with it). The Windows default cannot carry over there
/// because Control+Alt+Space is macOS's "select next input source" shortcut.
#[cfg(not(target_os = "macos"))]
const CHAT_DEFAULT_ACCELERATOR: &str = "Control+Alt+Space";
#[cfg(target_os = "macos")]
const CHAT_DEFAULT_ACCELERATOR: &str = "Alt+Space";

/// The voice trigger a fresh install starts on.
///
/// Windows keeps the Left Ctrl double-tap. macOS deliberately does NOT: a
/// double-tapped bare modifier cannot be expressed as a registered shortcut, so
/// it needs the CGEventTap in voice_toggle_key.rs, and that tap needs the Input
/// Monitoring TCC grant plus a relaunch before it delivers anything. Shipping it
/// as the default meant every new Mac user's headline feature was dead until
/// they found a System Settings pane nothing had pointed them at.
///
/// A real chord costs nothing: tauri-plugin-global-shortcut registers it through
/// Carbon RegisterEventHotKey, which is not TCC-gated at all. Control+Alt+KeyV
/// matches the existing Control+Alt+<letter> family (D/S/G/M) and collides with
/// no macOS system binding. Double-tap stays available as an opt-in that asks
/// for the permission at the moment the user picks it.
#[cfg(not(target_os = "macos"))]
pub const VOICE_DEFAULT_ACCELERATOR: &str = "ControlLeft";
#[cfg(target_os = "macos")]
pub const VOICE_DEFAULT_ACCELERATOR: &str = "Control+Alt+KeyV";

/// The sentinel that matches what `voice_toggle_key::use_default_toggle_key`
/// parks the hook on. The two must stay in step: the stored string is what the
/// next launch reads back to recompute the same VK.
const DOUBLE_TAP_FALLBACK: &str = "ControlLeft";

struct HotkeySpec {
    id: &'static str,
    label: &'static str,
    default_accelerator: &'static str,
}

const SPECS: [HotkeySpec; 6] = [
    HotkeySpec { id: "chat", label: "Toggle text chat", default_accelerator: CHAT_DEFAULT_ACCELERATOR },
    HotkeySpec { id: "dashboard", label: "Toggle your dashboard", default_accelerator: "Control+Alt+KeyD" },
    HotkeySpec { id: "screenSight", label: "Toggle Screen Sight", default_accelerator: "Control+Alt+KeyS" },
    HotkeySpec { id: "guide", label: "Toggle Guide Mode", default_accelerator: "Control+Alt+KeyG" },
    HotkeySpec { id: "outputMute", label: "Mute or unmute Buddy", default_accelerator: "Control+Alt+KeyM" },
    HotkeySpec { id: "signOut", label: "Sign out", default_accelerator: "Control+Shift+KeyD" },
];

struct HotkeyRuntime {
    bindings: BTreeMap<String, Shortcut>,
    voice_binding: Option<Shortcut>,
    registered: BTreeSet<String>,
    chat_enabled: bool,
    testing: BTreeMap<String, (String, Instant)>,
    test_registered: BTreeSet<String>,
}

pub struct HotkeyState(Mutex<HotkeyRuntime>);

impl Default for HotkeyState {
    fn default() -> Self {
        let bindings = SPECS
            .iter()
            .map(|spec| {
                (
                    spec.id.to_string(),
                    Shortcut::from_str(spec.default_accelerator)
                        .expect("built-in hotkey accelerator must be valid"),
                )
            })
            .collect();
        Self(Mutex::new(HotkeyRuntime {
            bindings,
            voice_binding: None,
            registered: BTreeSet::new(),
            chat_enabled: false,
            testing: BTreeMap::new(),
            test_registered: BTreeSet::new(),
        }))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyBindingView {
    id: String,
    label: String,
    accelerator: String,
    keys: Vec<String>,
    registered: bool,
}

#[cfg(test)]
fn shortcut_for_default(id: &str) -> Shortcut {
    let spec = SPECS.iter().find(|spec| spec.id == id).expect("known hotkey id");
    Shortcut::from_str(spec.default_accelerator).expect("built-in hotkey accelerator must be valid")
}

/// Kept as functions because existing native callers use these defaults before
/// the managed registry is available during startup.
#[cfg(test)]
pub fn open_dashboard_shortcut() -> Shortcut { shortcut_for_default("dashboard") }
#[cfg(test)]
pub fn sign_out_shortcut() -> Shortcut { shortcut_for_default("signOut") }
#[cfg(test)]
pub fn screen_sight_shortcut() -> Shortcut { shortcut_for_default("screenSight") }
#[cfg(test)]
pub fn guide_mode_shortcut() -> Shortcut { shortcut_for_default("guide") }

fn keys_for(shortcut: Shortcut) -> Vec<String> {
    let mut keys = Vec::new();
    let (alt_label, super_label) = if cfg!(target_os = "macos") { ("Option", "Cmd") } else { ("Alt", "Win") };
    if shortcut.mods.contains(Modifiers::CONTROL) { keys.push("Ctrl".to_string()); }
    if shortcut.mods.contains(Modifiers::ALT) { keys.push(alt_label.to_string()); }
    if shortcut.mods.contains(Modifiers::SHIFT) { keys.push("Shift".to_string()); }
    if shortcut.mods.contains(Modifiers::SUPER) { keys.push(super_label.to_string()); }
    let raw = shortcut.key.to_string();
    let key = raw.strip_prefix("Key")
        .or_else(|| raw.strip_prefix("Digit"))
        .unwrap_or(&raw)
        .to_string();
    keys.push(if key == "Space" { "Space".to_string() } else { key });
    keys
}

fn views(runtime: &HotkeyRuntime) -> Vec<HotkeyBindingView> {
    SPECS.iter().map(|spec| {
        let shortcut = *runtime.bindings.get(spec.id).expect("known hotkey binding");
        HotkeyBindingView {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            accelerator: shortcut.to_string(),
            keys: keys_for(shortcut),
            registered: runtime.registered.contains(spec.id),
        }
    }).collect()
}

/// Keys that are useless as a shortcut on their own because the user needs them
/// for ordinary typing and navigation. With a modifier held they are fine.
const BARE_KEY_BLOCKLIST: [Code; 11] = [
    Code::Tab,
    Code::Enter,
    Code::Backspace,
    Code::Delete,
    Code::Escape,
    Code::CapsLock,
    Code::NumLock,
    Code::ScrollLock,
    Code::PrintScreen,
    Code::Pause,
    Code::ContextMenu,
];

/// A modifier pressed on its own is not a shortcut, it is the prefix of one.
const MODIFIER_CODES: [Code; 8] = [
    Code::ControlLeft,
    Code::ControlRight,
    Code::AltLeft,
    Code::AltRight,
    Code::ShiftLeft,
    Code::ShiftRight,
    Code::MetaLeft,
    Code::MetaRight,
];

/// Deliberately a blocklist, not an allowlist: the user picks whatever they
/// want and we only refuse combinations Windows will never hand us, or that
/// would leave them unable to type. Anything merely risky (no modifier, a
/// single modifier, AltGr overlap) is warned about in the UI and allowed.
#[cfg(not(target_os = "macos"))]
fn validate_shortcut(shortcut: Shortcut) -> Result<(), String> {
    if shortcut.mods.contains(Modifiers::SUPER) {
        return Err("Windows-key shortcuts are reserved for Windows. Use Ctrl, Alt, and Shift instead.".to_string());
    }
    if MODIFIER_CODES.contains(&shortcut.key) {
        return Err("Hold the modifiers, then press one other key.".to_string());
    }
    if shortcut.key == Code::F12 {
        return Err("F12 is reserved by Windows for debuggers.".to_string());
    }
    if shortcut.mods.is_empty() && BARE_KEY_BLOCKLIST.contains(&shortcut.key) {
        return Err("Pick a key you do not need for normal typing.".to_string());
    }
    if shortcut.key == Code::Tab && shortcut.mods.contains(Modifiers::ALT) {
        return Err("Alt+Tab is reserved for switching windows.".to_string());
    }
    if shortcut.key == Code::Escape
        && (shortcut.mods.contains(Modifiers::ALT) || shortcut.mods.contains(Modifiers::CONTROL))
    {
        return Err("That Escape shortcut is reserved by Windows.".to_string());
    }
    if shortcut.key == Code::F4 && shortcut.mods.contains(Modifiers::ALT) {
        return Err("Alt+F4 is reserved for closing windows.".to_string());
    }
    Ok(())
}

/// The macOS counterpart. Cmd is allowed (it is the natural shortcut modifier
/// there); refused combinations are the ones macOS itself owns system-wide:
/// Spotlight, input-source switching, the Character Viewer, app switching,
/// Force Quit, screen lock, and the screenshot family.
#[cfg(target_os = "macos")]
fn validate_shortcut(shortcut: Shortcut) -> Result<(), String> {
    if MODIFIER_CODES.contains(&shortcut.key) {
        return Err("Hold the modifiers, then press one other key.".to_string());
    }
    if shortcut.mods.is_empty() && BARE_KEY_BLOCKLIST.contains(&shortcut.key) {
        return Err("Pick a key you do not need for normal typing.".to_string());
    }
    let cmd = shortcut.mods.contains(Modifiers::SUPER);
    let ctrl = shortcut.mods.contains(Modifiers::CONTROL);
    let shift = shortcut.mods.contains(Modifiers::SHIFT);
    if shortcut.key == Code::Space && (cmd || ctrl) {
        return Err("That Space shortcut is reserved by macOS for Spotlight, input sources, and the Character Viewer.".to_string());
    }
    if shortcut.key == Code::Tab && cmd {
        return Err("Cmd+Tab is reserved for switching apps.".to_string());
    }
    if shortcut.key == Code::Escape && cmd {
        return Err("That Escape shortcut is reserved by macOS for Force Quit.".to_string());
    }
    if shortcut.key == Code::KeyQ && cmd && ctrl {
        return Err("Ctrl+Cmd+Q is reserved for locking the screen.".to_string());
    }
    if cmd && shift
        && matches!(shortcut.key, Code::Digit3 | Code::Digit4 | Code::Digit5 | Code::Digit6)
    {
        return Err("That shortcut is reserved by macOS for screenshots.".to_string());
    }
    Ok(())
}

/// The action that already owns `candidate`, so the error can name it instead of
/// saying "another Aura action". `skip_id` is the binding being edited, which
/// must not count as a conflict with itself.
fn conflicting_label(runtime: &HotkeyRuntime, candidate: Shortcut, skip_id: &str) -> Option<String> {
    if skip_id != "voice" && runtime.voice_binding == Some(candidate) {
        return Some(VOICE_LABEL.to_string());
    }
    runtime.bindings.iter()
        .find(|(id, shortcut)| id.as_str() != skip_id && *shortcut == &candidate)
        .map(|(id, _)| {
            SPECS.iter()
                .find(|spec| spec.id == id)
                .map(|spec| spec.label.to_string())
                .unwrap_or_else(|| id.clone())
        })
}

fn persist(app: &AppHandle, runtime: &HotkeyRuntime) -> Result<(), String> {
    let values: BTreeMap<String, String> = runtime.bindings.iter()
        .map(|(id, shortcut)| (id.clone(), shortcut.to_string()))
        .collect();
    let store = app.store(HOTKEY_STORE).map_err(|e| format!("could not open hotkey settings: {e}"))?;
    store.set(HOTKEYS_KEY, serde_json::json!(values));
    store.save().map_err(|e| format!("could not save hotkey settings: {e}"))
}

pub fn initialize(app: &AppHandle) {
    let state = app.state::<HotkeyState>();
    let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Ok(store) = app.store(HOTKEY_STORE) {
        if let Some(value) = store.get(HOTKEYS_KEY) {
            if let Ok(saved) = serde_json::from_value::<BTreeMap<String, String>>(value) {
                let mut candidates = runtime.bindings.clone();
                for spec in &SPECS {
                    let Some(accelerator) = saved.get(spec.id) else { continue };
                    // A hotkeys.json restored from a Windows machine can carry the
                    // old chat default, which is macOS's input-source switcher.
                    // Treat it as unset so the mac default applies; a shortcut the
                    // user deliberately picked never matches this string.
                    if cfg!(target_os = "macos") && spec.id == "chat" && accelerator == "Control+Alt+Space" {
                        continue;
                    }
                    let Ok(shortcut) = Shortcut::from_str(accelerator) else { continue };
                    if validate_shortcut(shortcut).is_ok() { candidates.insert(spec.id.to_string(), shortcut); }
                }
                let unique = candidates.values().enumerate().all(|(index, current)| {
                    candidates.values().skip(index + 1).all(|other| other != current)
                });
                if unique { runtime.bindings = candidates; }
            }
        }
        // No saved value means a fresh install, which takes this platform's
        // default rather than falling through to the double-tap hook.
        let accelerator = store
            .get(VOICE_KEY_SETTING)
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| VOICE_DEFAULT_ACCELERATOR.to_string());
        if !DOUBLE_TAP_SENTINELS.contains(&accelerator.as_str()) {
            let usable = Shortcut::from_str(&accelerator).ok().filter(|shortcut| {
                validate_shortcut(*shortcut).is_ok()
                    && !runtime.bindings.values().any(|binding| binding == shortcut)
            });
            match usable {
                Some(shortcut) => runtime.voice_binding = Some(shortcut),
                None => {
                    // Repair to this platform's default, not a hardcoded
                    // "ControlLeft": on macOS that literal would drop the user
                    // back onto the permission-gated double-tap, which is
                    // exactly what the default moved away from.
                    if DOUBLE_TAP_SENTINELS.contains(&VOICE_DEFAULT_ACCELERATOR) {
                        crate::voice_toggle_key::use_default_toggle_key();
                    } else if let Ok(fallback) = Shortcut::from_str(VOICE_DEFAULT_ACCELERATOR) {
                        runtime.voice_binding = Some(fallback);
                    }
                    store.set(VOICE_KEY_SETTING, serde_json::json!(VOICE_DEFAULT_ACCELERATOR));
                    if let Err(e) = store.save() {
                        log::error!("hotkeys: failed to repair unusable saved voice shortcut: {e}");
                    }
                }
            }
        }
    }

    for spec in SPECS.iter().filter(|spec| spec.id != "chat") {
        let shortcut = *runtime.bindings.get(spec.id).expect("known hotkey binding");
        match app.global_shortcut().register(shortcut) {
            Ok(()) => { runtime.registered.insert(spec.id.to_string()); }
            Err(e) => {
                log::error!("hotkeys: failed to register {} ({e}) - another process holds it; continuing without it", spec.id);
                if !cfg!(debug_assertions) {
                    sentry::capture_message(&format!("hotkeys: failed to register {}: {e}", spec.id), sentry::Level::Error);
                }
            }
        }
    }
    if let Some(shortcut) = runtime.voice_binding {
        match app.global_shortcut().register(shortcut) {
            Ok(()) => { runtime.registered.insert("voice".to_string()); }
            Err(e) => {
                log::error!("hotkeys: failed to register custom voice shortcut ({e}) - another process holds it");
                if !cfg!(debug_assertions) {
                    sentry::capture_message(&format!("hotkeys: failed to register custom voice shortcut: {e}"), sentry::Level::Error);
                }
                runtime.voice_binding = None;
                crate::voice_toggle_key::use_default_toggle_key();
                if let Ok(store) = app.store(HOTKEY_STORE) {
                    store.set(VOICE_KEY_SETTING, serde_json::json!(DOUBLE_TAP_FALLBACK));
                    if let Err(e) = store.save() {
                        log::error!("hotkeys: failed to persist voice shortcut fallback: {e}");
                    }
                }
            }
        }
    }
}

pub fn voice_binding(state: &HotkeyState) -> Option<(String, Vec<String>, bool)> {
    let runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    runtime.voice_binding.map(|shortcut| (
        shortcut.to_string(),
        keys_for(shortcut),
        runtime.registered.contains("voice"),
    ))
}

pub fn set_voice_binding(
    app: &AppHandle,
    state: &HotkeyState,
    accelerator: &str,
) -> Result<(), String> {
    let candidate = if DOUBLE_TAP_SENTINELS.contains(&accelerator) {
        None
    } else {
        let shortcut = Shortcut::from_str(accelerator)
            .map_err(|_| "Choose one non-modifier key with the modifiers.".to_string())?;
        validate_shortcut(shortcut)?;
        Some(shortcut)
    };
    let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(shortcut) = candidate {
        if let Some(label) = conflicting_label(&runtime, shortcut, "voice") {
            return Err(format!("{label} already uses that shortcut."));
        }
    }
    let previous = runtime.voice_binding;
    let was_registered = runtime.registered.remove("voice");
    if was_registered {
        if let Some(shortcut) = previous {
            if let Err(e) = app.global_shortcut().unregister(shortcut) {
                runtime.registered.insert("voice".to_string());
                return Err(format!("Could not release the current voice shortcut: {e}"));
            }
        }
    }
    if let Some(shortcut) = candidate {
        if let Err(e) = app.global_shortcut().register(shortcut) {
            let mut restored = !was_registered;
            if was_registered {
                if let Some(previous) = previous {
                    if app.global_shortcut().register(previous).is_ok() {
                        runtime.registered.insert("voice".to_string());
                        restored = true;
                    }
                }
            }
            if !restored {
                runtime.voice_binding = None;
                crate::voice_toggle_key::use_default_toggle_key();
                log::error!("hotkeys: custom voice shortcut rollback failed; restored Left Ctrl double-tap in memory");
            }
            return Err(format!("That shortcut is already in use by {OS_NAME} or another app: {e}"));
        }
        runtime.registered.insert("voice".to_string());
    }
    runtime.voice_binding = candidate;
    let store = app.store(HOTKEY_STORE).map_err(|e| format!("could not open hotkey settings: {e}"))?;
    store.set(VOICE_KEY_SETTING, serde_json::json!(accelerator));
    if let Err(e) = store.save() {
        if let Some(shortcut) = candidate { let _ = app.global_shortcut().unregister(shortcut); }
        runtime.registered.remove("voice");
        runtime.voice_binding = previous;
        let mut restored = !was_registered;
        if was_registered {
            if let Some(previous) = previous {
                if app.global_shortcut().register(previous).is_ok() {
                    runtime.registered.insert("voice".to_string());
                    restored = true;
                }
            }
        }
        if !restored {
            runtime.voice_binding = None;
            crate::voice_toggle_key::use_default_toggle_key();
            log::error!("hotkeys: custom voice shortcut rollback failed after store error; restored Left Ctrl double-tap in memory");
            return Err(format!("could not save voice shortcut: {e}. Aura restored Left Ctrl twice for this session."));
        }
        return Err(format!("could not save voice shortcut: {e}"));
    }
    Ok(())
}

#[tauri::command]
pub fn hotkey_bindings(state: tauri::State<'_, HotkeyState>) -> Vec<HotkeyBindingView> {
    let runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    views(&runtime)
}

#[tauri::command]
pub fn set_hotkey_binding(
    app: AppHandle,
    state: tauri::State<'_, HotkeyState>,
    id: String,
    accelerator: String,
) -> Result<Vec<HotkeyBindingView>, String> {
    if !SPECS.iter().any(|spec| spec.id == id) {
        return Err("Unknown shortcut.".to_string());
    }
    let candidate = Shortcut::from_str(&accelerator).map_err(|_| "Choose one non-modifier key with the modifiers.".to_string())?;
    validate_shortcut(candidate)?;
    let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(label) = conflicting_label(&runtime, candidate, &id) {
        return Err(format!("{label} already uses that shortcut."));
    }
    let previous = *runtime.bindings.get(&id).expect("known hotkey binding");
    if previous == candidate { return Ok(views(&runtime)); }
    let was_registered = runtime.registered.remove(&id);
    if was_registered {
        if let Err(e) = app.global_shortcut().unregister(previous) {
            runtime.registered.insert(id.clone());
            return Err(format!("Could not release the current shortcut: {e}"));
        }
    }
    let should_remain_registered = id != "chat" || runtime.chat_enabled;
    if should_remain_registered {
        if let Err(e) = app.global_shortcut().register(candidate) {
            if was_registered {
                if let Err(rollback_error) = app.global_shortcut().register(previous) {
                    log::error!("hotkeys: rollback failed for {id}: {rollback_error}");
                } else {
                    runtime.registered.insert(id.clone());
                }
            }
            return Err(format!("That shortcut is already in use by {OS_NAME} or another app: {e}"));
        }
        runtime.registered.insert(id.clone());
    } else {
        // Trial registration is the only reliable way to detect a conflict.
        app.global_shortcut().register(candidate)
            .map_err(|e| format!("That shortcut is already in use by {OS_NAME} or another app: {e}"))?;
        let _ = app.global_shortcut().unregister(candidate);
    }
    runtime.bindings.insert(id.clone(), candidate);
    if let Err(e) = persist(&app, &runtime) {
        if should_remain_registered { let _ = app.global_shortcut().unregister(candidate); }
        runtime.bindings.insert(id.clone(), previous);
        if was_registered && app.global_shortcut().register(previous).is_ok() {
            runtime.registered.insert(id);
        }
        return Err(e);
    }
    let result = views(&runtime);
    drop(runtime);
    let _ = app.emit(crate::events::HOTKEY_BINDINGS_CHANGED, &result);
    Ok(result)
}

/// The mouse-only escape hatch. Because a shortcut may now be a bare key that
/// swallows itself system-wide, there has to be a way back that needs no
/// keyboard at all.
#[tauri::command]
pub fn reset_hotkey_bindings(
    app: AppHandle,
    state: tauri::State<'_, HotkeyState>,
) -> Result<Vec<HotkeyBindingView>, String> {
    let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for id in std::mem::take(&mut runtime.registered) {
        let shortcut = if id == "voice" {
            runtime.voice_binding
        } else {
            runtime.bindings.get(&id).copied()
        };
        if let Some(shortcut) = shortcut {
            if let Err(e) = app.global_shortcut().unregister(shortcut) {
                log::error!("hotkeys: reset could not release {id}: {e}");
            }
        }
    }
    runtime.voice_binding = None;
    for spec in &SPECS {
        let shortcut = Shortcut::from_str(spec.default_accelerator)
            .expect("built-in hotkey accelerator must be valid");
        runtime.bindings.insert(spec.id.to_string(), shortcut);
        if spec.id == "chat" && !runtime.chat_enabled {
            continue;
        }
        match app.global_shortcut().register(shortcut) {
            Ok(()) => { runtime.registered.insert(spec.id.to_string()); }
            Err(e) => log::error!("hotkeys: reset could not register {} ({e})", spec.id),
        }
    }
    crate::voice_toggle_key::use_default_toggle_key();
    let store = app.store(HOTKEY_STORE).map_err(|e| format!("could not open hotkey settings: {e}"))?;
    store.set(VOICE_KEY_SETTING, serde_json::json!("ControlLeft"));
    persist(&app, &runtime)?;
    let result = views(&runtime);
    drop(runtime);
    let _ = app.emit(crate::events::HOTKEY_BINDINGS_CHANGED, &result);
    crate::voice_toggle_key::emit_status_changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn begin_hotkey_test(
    app: AppHandle,
    state: tauri::State<'_, HotkeyState>,
    id: String,
    owner: String,
) -> Result<(), String> {
    if id != "voice" && !SPECS.iter().any(|spec| spec.id == id) {
        return Err("Unknown shortcut.".to_string());
    }
    if owner.is_empty() {
        return Err("Missing shortcut test owner.".to_string());
    }
    let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_hotkey_tests(&app, &mut runtime);
    let previous_action = runtime.testing.insert(owner.clone(), (id.clone(), Instant::now() + TEST_TIMEOUT));
    let replaced_existing = previous_action.is_some();
    if id == "chat"
        && !runtime.registered.contains("chat")
        && !runtime.test_registered.contains("chat")
    {
        let shortcut = *runtime.bindings.get("chat").expect("known chat hotkey");
        if let Err(err) = app.global_shortcut().register(shortcut) {
            runtime.testing.remove(&owner);
            if let Some(previous_action) = previous_action {
                runtime.testing.insert(owner, previous_action);
            }
            cleanup_test_registrations(&app, &mut runtime);
            return Err(format!("That shortcut is already in use by {OS_NAME} or another app: {err}"));
        }
        runtime.test_registered.insert("chat".to_string());
    }
    if replaced_existing {
        cleanup_test_registrations(&app, &mut runtime);
    }
    Ok(())
}

#[tauri::command]
pub fn end_hotkey_test(app: AppHandle, state: tauri::State<'_, HotkeyState>, owner: String) {
    let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    runtime.testing.remove(&owner);
    cleanup_test_registrations(&app, &mut runtime);
}

pub fn set_chat_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<HotkeyState>();
    let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if runtime.chat_enabled == enabled && runtime.registered.contains("chat") == enabled { return Ok(()); }
    runtime.chat_enabled = enabled;
    let shortcut = *runtime.bindings.get("chat").expect("known chat hotkey");
    if enabled {
        if !runtime.test_registered.remove("chat") {
            app.global_shortcut().register(shortcut).map_err(|e| format!("failed to register chat hotkey: {e}"))?;
        }
        runtime.registered.insert("chat".to_string());
    } else if runtime.registered.remove("chat") {
        if runtime.testing.values().any(|(action, _)| action == "chat") {
            runtime.test_registered.insert("chat".to_string());
        } else {
            app.global_shortcut().unregister(shortcut).map_err(|e| format!("failed to unregister chat hotkey: {e}"))?;
        }
    }
    let result = views(&runtime);
    drop(runtime);
    let _ = app.emit(crate::events::HOTKEY_BINDINGS_CHANGED, &result);
    Ok(())
}

fn cleanup_test_registrations(app: &AppHandle, runtime: &mut HotkeyRuntime) {
    let orphaned: Vec<String> = runtime.test_registered.iter()
        .filter(|id| !runtime.testing.values().any(|(action, _)| action == *id))
        .cloned()
        .collect();
    for id in orphaned {
        if let Some(shortcut) = runtime.bindings.get(&id).copied() {
            if let Err(err) = app.global_shortcut().unregister(shortcut) {
                log::error!("hotkeys: could not release temporary {id} test shortcut: {err}");
            }
        }
        runtime.test_registered.remove(&id);
    }
}

fn prune_hotkey_tests(app: &AppHandle, runtime: &mut HotkeyRuntime) {
    let now = Instant::now();
    runtime.testing.retain(|_, (_, deadline)| now <= *deadline);
    cleanup_test_registrations(app, runtime);
}

fn tested_action(app: &AppHandle, runtime: &mut HotkeyRuntime, action: &str) -> bool {
    prune_hotkey_tests(app, runtime);
    runtime.testing.values().any(|(id, _)| id == action)
}

pub fn intercept_voice_test(app: &AppHandle) -> bool {
    let state = app.state::<HotkeyState>();
    let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if tested_action(app, &mut runtime, "voice") {
        let _ = app.emit(crate::events::HOTKEY_TEST_PRESSED, "voice");
        return true;
    }
    false
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut) {
    let state = app.state::<HotkeyState>();
    let action = {
        let mut runtime = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let action = if runtime.voice_binding.as_ref() == Some(shortcut) {
            Some("voice".to_string())
        } else {
            runtime.bindings.iter().find_map(|(id, binding)| (binding == shortcut).then(|| id.clone()))
        };
        if let Some(action) = action.as_deref() {
            if tested_action(app, &mut runtime, action) {
                let _ = app.emit(crate::events::HOTKEY_TEST_PRESSED, action);
                return;
            }
        }
        action
    };
    match action.as_deref() {
        Some("voice") => crate::voice_toggle_key::emit_toggle(app),
        Some("chat") => overlay::request_chat_toggle(app),
        Some("dashboard") => {
            if let Err(e) = dashboard::toggle_dashboard_window(app) { log::error!("hotkeys: toggle dashboard failed: {e}"); }
        }
        Some("signOut") => overlay::sign_out_requested(app),
        Some("screenSight") => security::toggle_screen_sight(app),
        Some("guide") => guide::toggle(app),
        Some("outputMute") => overlay::request_output_mute_toggle(app),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_dashboard_is_ctrl_alt_d() {
        assert_eq!(open_dashboard_shortcut(), Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD));
    }

    #[test]
    fn open_dashboard_is_distinct_from_sign_out() {
        assert_ne!(open_dashboard_shortcut(), sign_out_shortcut());
    }

    #[test]
    fn guide_mode_is_ctrl_alt_g_and_distinct() {
        assert_eq!(guide_mode_shortcut(), Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyG));
        assert_ne!(guide_mode_shortcut(), screen_sight_shortcut());
    }
}
