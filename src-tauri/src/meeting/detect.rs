//! Zoom/Teams join detection - one polling thread per armed meeting window.
//!
//! React (useMeetingCapture.ts) arms a watch for each eligible meeting's time
//! window; this module polls the desktop every 5s inside that window looking
//! for an in-call Zoom/Teams window (process name is the primary signal,
//! window title the confirmation), emits `meeting-join-detected` once on
//! match, then flips to presence-watching and emits `meeting-left` when the
//! match disappears for two consecutive polls. A re-appearance inside the
//! window re-emits join (the backend claim is idempotent per device, so JS
//! treats it as a continuation). The thread self-expires at the window's end:
//! a meeting the user never joins costs nothing and emits nothing.
//!
//! Browser-hosted Google Meet, Teams, and Zoom calls are recognized from the
//! visible browser window title while the matching calendar window is live.
//!
//! `start_ambient_watch` is the second, always-on consumer of the same scan:
//! one thread for the whole process that emits `meeting-call-seen` /
//! `meeting-call-gone` for ANY call it finds, calendar or not, so the notch
//! can ask "Record this meeting?". It reports; it never captures.
//!
//! The watch loop, the polling cadence and the app-matching table are shared;
//! only `scan` at the bottom is per-platform, and it exists solely to answer
//! "which apps have visible windows, and what are they called", plus "which
//! apps hold the microphone". Nothing here holds the OverlayState mutex; the
//! macOS ambient tick only reads `voice_active` through it for a moment.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use log::{error, info};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::app_icon::IconSource;
use super::{AmbientCallPayload, AmbientGonePayload, AmbientWatchHandle, JoinWatchHandle};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Consecutive match-free polls before the meeting counts as left - one blip
/// (window minimized to tray during a re-dock, title flicker) must not end a
/// capture.
const LEFT_AFTER_MISSES: u32 = 2;
/// The ambient scanner's "gone" threshold for browser-hosted calls. Only the
/// active tab's title is visible, so switching tabs mid-call hides the match
/// without ending the call; the per-event watch below leans on the calendar
/// end for that, but an ad-hoc call has no calendar. Five minutes is the
/// trade-off for a call whose only evidence is its title.
const BROWSER_GONE_AFTER_MISSES: u32 = 60;
/// The "gone" threshold for a call seen through the microphone. The mic session
/// does not care which tab is in front, so this can say the call really ended:
/// thirty seconds after the last app lets go of the mic. Zoom, Meet and Teams
/// keep the device open while muted (it is how they say "you are muted"), so a
/// mute is not a release.
const MIC_GONE_AFTER_MISSES: u32 = 6;
/// Consecutive polls the SAME call must be seen for before it is announced,
/// when no call is currently tracked. There was no first-sight debounce at
/// all: the very first matching poll armed the prompt, so a Meet lobby page
/// the user never joined, a tab merely mentioning the product, and a title
/// that flickered past for one tick each summoned the notch. Confirming costs
/// nothing real - the prompt only ASKS, and capture starts on the click - so
/// the meeting is not shortened, only the question is delayed.
const SEEN_AFTER_HITS: u32 = 3;

use super::JoinDetectedPayload;

/// Trailing suffixes browsers append to a tab's title. Stripped before
/// hashing so the same Meet tab keys identically across browsers. The two
/// Firefox entries are DATA copied from what Firefox actually emits, which is
/// why one of them carries an em-dash (written as an escape, never typed).
const BROWSER_TITLE_SUFFIXES: &[&str] = &[
    " - google chrome",
    " - microsoft edge",
    " - brave",
    " \u{2014} mozilla firefox",
    " - mozilla firefox",
];

/// Starts the always-on call scanner. Returns the call it is currently
/// reporting when one is already running, so a remounting webview can seed
/// its prompt state without waiting for the next `meeting-call-seen`.
pub fn start_ambient_watch(app: AppHandle) -> Result<Option<AmbientCallPayload>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let handle = app.state::<AmbientWatchHandle>();
        let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if watch.cancel.is_some() {
            return Ok(watch.current.clone());
        }
        watch.cancel = Some(cancel.clone());
    }
    let thread_app = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("meeting-ambient-watch".to_string())
        .spawn(move || ambient_thread(thread_app, cancel))
    {
        let handle = app.state::<AmbientWatchHandle>();
        let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        watch.cancel = None;
        return Err(e.to_string());
    }
    Ok(None)
}

pub fn stop_ambient_watch(app: &AppHandle) {
    let Some(handle) = app.try_state::<AmbientWatchHandle>() else {
        return;
    };
    let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cancel) = watch.cancel.take() {
        cancel.store(true, Ordering::Relaxed);
    }
    watch.current = None;
}

/// The scanner loop. The handle's `current` is the single source of truth for
/// "which call are we reporting", read and written under the lock each tick,
/// so a stop that clears it mid-sleep is honoured on the next tick and a
/// remount can read it directly.
fn ambient_thread(app: AppHandle, cancel: Arc<AtomicBool>) {
    info!("meeting.detect: ambient watch started");
    // The lock watcher is otherwise only started by the capture engine.
    super::session::ensure_watcher();
    let mut misses: u32 = 0;
    // The call the watch is counting toward `SEEN_AFTER_HITS`, and how many
    // consecutive polls it has survived. Never announced until it settles.
    let mut pending: Option<(String, u32)> = None;
    #[cfg(target_os = "macos")]
    let mut trust_logged = false;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        // A locked screen is not "call gone": no scan, no misses.
        if super::session::is_locked() {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        // Window titles come from the accessibility tree, which is empty
        // without the grant. Re-checked every tick because the grant applies
        // live; silent check only, this must never raise the system dialog.
        // The microphone pass needs no grant, so the tick still runs.
        #[cfg(target_os = "macos")]
        {
            if !crate::macos_ax::is_trusted(false) {
                if !trust_logged {
                    info!("meeting.detect: titles unavailable, Accessibility not granted");
                    trust_logged = true;
                }
            } else {
                trust_logged = false;
            }
        }

        // Only macOS needs this: Aura's own call runs in a WebKit helper there,
        // indistinguishable from Safari's. On Windows the WebView2 host walk in
        // `scan` already tells Aura's webview apart. A momentary read, never
        // held across the scan.
        #[cfg(target_os = "macos")]
        let own_voice_live = crate::overlay::is_voice_active(&app);
        #[cfg(not(target_os = "macos"))]
        let own_voice_live = false;
        let seen = call_signal(own_voice_live);
        let current = ambient_current(&app);
        match (seen, current) {
            (Some((next, _)), Some(previous)) if previous.call_key == next.call_key => {
                misses = 0;
                pending = None;
            }
            (Some((mut next, icon_source)), previous) => {
                misses = 0;
                // Arming a call the watch is not already tracking needs
                // confirmation. A re-key mid-call (`previous` is Some) is NOT
                // held back: the capture is pointed at the old key and must
                // follow the title immediately.
                if previous.is_none() {
                    let hits = match pending.take() {
                        Some((key, hits)) if key == next.call_key => hits + 1,
                        _ => 1,
                    };
                    if hits < SEEN_AFTER_HITS {
                        pending = Some((next.call_key.clone(), hits));
                        std::thread::sleep(POLL_INTERVAL);
                        continue;
                    }
                }
                pending = None;
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                if let Some(previous) = previous {
                    emit_gone(&app, previous);
                }
                // Once per call, never per tick. A browser-hosted call keeps
                // None: the card shows the meeting site's own icon instead.
                if !(next.app.ends_with("web") || next.app == "google-meet") {
                    next.app_icon = super::app_icon::png_data_url(&icon_source);
                }
                info!(
                    "meeting.detect: ambient call seen ({}, icon={})",
                    next.app,
                    next.app_icon.is_some()
                );
                set_ambient_current(&app, Some(next.clone()));
                if let Err(e) = app.emit(crate::events::MEETING_CALL_SEEN, next) {
                    error!("meeting.detect: emit call seen failed: {e}");
                }
            }
            (None, Some(previous)) => {
                misses += 1;
                if misses >= gone_threshold(&previous) {
                    misses = 0;
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    set_ambient_current(&app, None);
                    emit_gone(&app, previous);
                }
            }
            (None, None) => {
                misses = 0;
                // A candidate that stops matching before it is confirmed was
                // the lobby page, the stray tab, or the title flicker. It
                // starts its count over if it comes back.
                pending = None;
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    // Drop this thread's own registration (unless a replacement already
    // took it), same guard as watch_thread below.
    let handle = app.state::<AmbientWatchHandle>();
    let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if watch
        .cancel
        .as_ref()
        .is_some_and(|registered| Arc::ptr_eq(registered, &cancel))
    {
        watch.cancel = None;
        watch.current = None;
    }
    info!("meeting.detect: ambient watch ended");
}

fn ambient_current(app: &AppHandle) -> Option<AmbientCallPayload> {
    let handle = app.state::<AmbientWatchHandle>();
    let watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    watch.current.clone()
}

fn set_ambient_current(app: &AppHandle, current: Option<AmbientCallPayload>) {
    let handle = app.state::<AmbientWatchHandle>();
    let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    watch.current = current;
}

fn emit_gone(app: &AppHandle, previous: AmbientCallPayload) {
    info!("meeting.detect: ambient call gone ({})", previous.app);
    let payload = AmbientGonePayload {
        call_key: previous.call_key,
        app: previous.app,
    };
    if let Err(e) = app.emit(crate::events::MEETING_CALL_GONE, payload) {
        error!("meeting.detect: emit call gone failed: {e}");
    }
}

/// The signal seam: a matching window (`source: "window"`), else an app holding
/// the microphone (`source: "mic"`). The loop above treats both alike except
/// for how long a call may go unseen before it counts as gone.
fn call_signal(own_voice_live: bool) -> Option<(AmbientCallPayload, IconSource)> {
    let (app, title, icon_source, source) = find_meeting_window_with_source(own_voice_live)?;
    Some((
        AmbientCallPayload {
            call_key: call_key(&app, &title),
            app,
            window_title: title,
            source: source.to_string(),
            app_icon: None,
        },
        icon_source,
    ))
}

fn gone_threshold(call: &AmbientCallPayload) -> u32 {
    if call.source == "mic" {
        return MIC_GONE_AFTER_MISSES;
    }
    if is_browser_hosted(&call.app) {
        BROWSER_GONE_AFTER_MISSES
    } else {
        LEFT_AFTER_MISSES
    }
}

/// "app:<16 hex of sha256(normalized title)>". Native Zoom always titles its
/// window "Zoom Meeting", so every Zoom call shares a key; that is fine because
/// React clears its decision on `meeting-call-gone`, and two Zoom calls always
/// pass through gone in between. Meet titles carry the meeting code, so a tab
/// switch and return resolves to the same call.
fn call_key(app: &str, title: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(normalized_title(title).as_bytes()));
    format!("{app}:{}", &digest[..16])
}

fn normalized_title(title: &str) -> String {
    let mut normalized = title.trim().to_lowercase();
    // Browsers prepend an unread badge like "(3) " to the active tab's title.
    if let Some(rest) = normalized.strip_prefix('(') {
        if let Some(close) = rest.find(") ") {
            if close > 0 && rest[..close].bytes().all(|b| b.is_ascii_digit()) {
                normalized = rest[close + 2..].to_string();
            }
        }
    }
    for suffix in BROWSER_TITLE_SUFFIXES {
        if let Some(stripped) = normalized.strip_suffix(suffix) {
            normalized = stripped.trim_end().to_string();
            break;
        }
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeftPayload {
    event_id: String,
}

/// Arms detection for one meeting between `window_start_ms` and
/// `window_end_ms` (unix ms). Re-arming an already-watched event replaces the
/// old watch. (Plain function; the #[tauri::command] wrapper lives in mod.rs
/// so non-Windows builds still register a stub.)
pub fn start_join_watch(
    app: AppHandle,
    event_id: String,
    window_start_ms: i64,
    window_end_ms: i64,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let handle = app.state::<JoinWatchHandle>();
        let mut watches = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = watches.insert(event_id.clone(), cancel.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
    }
    let thread_app = app.clone();
    std::thread::Builder::new()
        .name("meeting-join-watch".to_string())
        .spawn(move || {
            watch_thread(thread_app, event_id, window_start_ms, window_end_ms, cancel)
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn stop_join_watch(app: AppHandle, event_id: String) {
    let handle = app.state::<JoinWatchHandle>();
    let mut watches = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cancel) = watches.remove(&event_id) {
        cancel.store(true, Ordering::Relaxed);
    }
}

fn watch_thread(
    app: AppHandle,
    event_id: String,
    window_start_ms: i64,
    window_end_ms: i64,
    cancel: Arc<AtomicBool>,
) {
    info!("meeting.detect: watching {event_id} until {window_end_ms}");
    let mut joined = false;
    let mut joined_in_browser = false;
    let mut misses: u32 = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let now = super::now_ms();
        // Expiry only applies while NOT joined: an overrunning meeting must
        // keep its presence watch so leaving it still stops the capture
        // (otherwise a joined window at expiry records to the 4h cap with
        // nobody watching). The capture engine's own cap bounds the overrun.
        if now >= window_end_ms && !joined {
            break;
        }
        if now >= window_end_ms && joined_in_browser {
            info!("meeting.detect: browser meeting ended for {event_id}");
            if let Err(e) = app.emit(
                crate::events::MEETING_LEFT,
                LeftPayload {
                    event_id: event_id.clone(),
                },
            ) {
                error!("meeting.detect: emit left failed: {e}");
            }
            break;
        }
        if now >= window_start_ms {
            match find_meeting_window() {
                Some((app_name, title)) => {
                    misses = 0;
                    if !joined {
                        joined = true;
                        joined_in_browser = is_browser_hosted(&app_name);
                        info!("meeting.detect: join detected for {event_id} ({app_name})");
                        if let Err(e) = app.emit(crate::events::MEETING_JOIN_DETECTED, JoinDetectedPayload {
                            event_id: event_id.clone(),
                            app: app_name,
                            window_title: title,
                        }) {
                            error!("meeting.detect: emit join failed: {e}");
                        }
                    }
                }
                None => {
                    if joined {
                        // EnumWindows exposes only a browser's active tab
                        // title. Switching tabs must not look like leaving an
                        // already detected browser meeting. The calendar end
                        // bounds these captures instead.
                        if joined_in_browser {
                            std::thread::sleep(POLL_INTERVAL);
                            continue;
                        }
                        misses += 1;
                        if misses >= LEFT_AFTER_MISSES {
                            joined = false;
                            misses = 0;
                            info!("meeting.detect: meeting left for {event_id}");
                            if let Err(e) = app.emit(crate::events::MEETING_LEFT, LeftPayload {
                                event_id: event_id.clone(),
                            }) {
                                error!("meeting.detect: emit left failed: {e}");
                            }
                        }
                    }
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    // Drop this watch's own map entry (unless a replacement already took it).
    let handle = app.state::<JoinWatchHandle>();
    let mut watches = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if watches
        .get(&event_id)
        .is_some_and(|current| Arc::ptr_eq(current, &cancel))
    {
        watches.remove(&event_id);
    }
    info!("meeting.detect: watch ended for {event_id}");
}

/// One desktop scan. Returns ("zoom" | "teams", window title) for the first
/// visible in-call window found.
///
/// The matching table below is shared: the platform scan is only responsible
/// for producing (app stem, window title) pairs, and it maps its own notion of
/// a process onto the SAME stems the table already knows. That is what keeps
/// the "zoom" / "google-meet" / "teams-web" app strings identical on both
/// platforms, which matters because `joined_in_browser` and the backend claim
/// both key off them.
pub(crate) fn find_meeting_window() -> Option<(String, String)> {
    find_meeting_window_with_source(false).map(|(app, title, _, _)| (app, title))
}

/// `find_meeting_window` plus where the matched app's icon can be read from
/// and which signal found it (`"window"` or `"mic"`).
///
/// Two passes, and the order matters. A title match names the platform, so it
/// wins outright and everything downstream (the product label, the bundled
/// logo, `joined_in_browser`) behaves exactly as it always has. It is also the
/// only pass that sees a listen-only webinar, where no mic is ever opened.
/// Only when no title matches does the microphone get a say, and it knows the
/// process, never the site or the meeting: a known call app is named, a
/// browser is `browser-call`, a recorder or voice filter is ignored, and any
/// other app is `mic-call` under its own name.
fn find_meeting_window_with_source(
    own_voice_live: bool,
) -> Option<(String, String, IconSource, &'static str)> {
    let windows = scan::visible_windows();
    for (app_stem, title, icon_source) in &windows {
        let title_lower = title.to_lowercase();
        if let Some(app_name) = meeting_app_for_window(app_stem, &title_lower) {
            return Some((app_name.to_string(), title.clone(), icon_source.clone(), "window"));
        }
    }
    // Probed only after the cheap pass misses, so a normal tick costs no COM
    // work at all.
    scan::microphone_users(own_voice_live)
        .into_iter()
        .filter_map(|user| mic_call_app(&user.stem).map(|app| (app, user)))
        .min_by_key(|(app, _)| mic_call_rank(app))
        // The app's NAME, never a window title. The only title we could have
        // is whatever tab or window is frontmost, and `call_key` hashes it, so
        // carrying it through would change the call's identity every time the
        // user switched tabs and the same call would churn through gone/seen
        // all meeting. The name is stable and is what a `mic-call` card shows.
        .map(|(app, user)| (app.to_string(), user.display_name, user.icon_source, "mic"))
}

/// One process holding an active microphone session, already resolved to the
/// app the user would name (a WebView2 or helper process is reported as its
/// host app).
struct MicUser {
    /// The same stem the title table uses ("zoom", "chrome", "discord"), or
    /// for an app neither table knows, its exe stem or bundle id.
    stem: String,
    display_name: String,
    icon_source: IconSource,
}

/// Call apps named when they hold the mic, by the stem either platform scan
/// produces. The app id is what React labels and draws.
const MIC_CALL_APPS: &[(&str, &str)] = &[
    ("zoom", "zoom"),
    ("ms-teams", "teams"),
    ("teams", "teams"),
    ("discord", "discord"),
    ("discordptb", "discord"),
    ("discordcanary", "discord"),
    ("slack", "slack"),
    ("whatsapp", "whatsapp"),
    ("whatsapp.root", "whatsapp"),
    ("webex", "webex"),
    ("ciscocollabhost", "webex"),
    ("atmgr", "webex"),
    ("skype", "skype"),
    ("signal", "signal"),
    ("telegram", "telegram"),
    ("facetime", "facetime"),
];

/// Apps that hold the mic for something other than a conversation: recorders,
/// voice filters that sit on the device all day, and other dictation tools.
/// Windows exe stems and macOS bundle ids share one list because the two never
/// collide. Without this, "prompt for any app on the mic" would ask to record
/// every OBS session and, for a Krisp or Broadcast user, forever.
const MIC_NOISE: &[&str] = &[
    "obs64",
    "obs32",
    "obs",
    "audacity",
    "soundrec",
    "soundrecorder",
    "voicerecorder",
    "nvidia broadcast",
    "nvidia rtx voice",
    "krisp",
    "voiceaccess",
    "textinputhost",
    "speechruntime",
    "wispr flow",
    "loom",
    "com.obsproject.obs-studio",
    "com.apple.voicememos",
    "ai.krisp.krispmac",
    "org.audacityteam.audacity",
    "com.loom.desktop",
];

/// Families matched by prefix: Voicemeeter ships one exe per edition and
/// bitness, and Siri and system dictation run under several daemons.
const MIC_NOISE_PREFIXES: &[&str] = &[
    "voicemeeter",
    "com.apple.siri",
    "com.apple.speech",
    "com.apple.assistant",
    "com.apple.dictation",
    "com.apple.corespeech",
];

/// The app id a mic holder is reported as, or None when it is noise.
fn mic_call_app(stem: &str) -> Option<&'static str> {
    if let Some((_, app)) = MIC_CALL_APPS.iter().find(|(known, _)| *known == stem) {
        return Some(app);
    }
    if is_browser(stem) {
        return Some("browser-call");
    }
    if MIC_NOISE.contains(&stem) || MIC_NOISE_PREFIXES.iter().any(|prefix| stem.starts_with(prefix)) {
        return None;
    }
    Some("mic-call")
}

/// When several apps hold the mic at once, the most specific answer wins: a
/// named call app, then a browser, then anything else.
fn mic_call_rank(app: &str) -> u8 {
    match app {
        "browser-call" => 1,
        "mic-call" => 2,
        _ => 0,
    }
}

/// "discord" -> "Discord". Only reached for a stem nothing better names.
fn display_name_for_stem(stem: &str) -> String {
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn is_browser(exe_stem: &str) -> bool {
    matches!(exe_stem, "chrome" | "msedge" | "brave" | "firefox" | "safari")
}

/// A call hosted in a browser tab rather than a native app window. Both things
/// that follow from it are about tabs: a tab switch hides the title without
/// ending the call, so leaving needs the long threshold, and the per-event
/// watch has to lean on the calendar end instead of the title disappearing.
/// `browser-call` is here for the per-event watch's sake; the ambient scanner
/// times it out by its mic evidence instead (`gone_threshold`).
fn is_browser_hosted(app: &str) -> bool {
    app.ends_with("web") || app == "google-meet" || app == "browser-call"
}

/// Teams window titles that contain "meeting" or "call" and are definitively
/// NOT a live call. `contains("meeting") || contains("call")` on any Teams
/// window was the loosest matcher in this file: opening Teams on the Calls
/// tab, a channel named "Weekly Meeting", or a missed-call row in the activity
/// feed each raised the record prompt with nobody on a call.
const TEAMS_NOT_A_CALL: &[&str] = &[
    "chat | microsoft teams",
    "calls | microsoft teams",
    "calendar | microsoft teams",
    "activity | microsoft teams",
    "teams | microsoft teams",
    "files | microsoft teams",
    "apps | microsoft teams",
    "missed call",
];

/// Exclusion only, never a new requirement: a real meeting whose title happens
/// to carry neither word was already invisible to this matcher, and tightening
/// the positive side here would drop calls rather than noise.
fn teams_title_is_a_call(title_lower: &str) -> bool {
    if title_lower.trim() == "microsoft teams" {
        return false;
    }
    if TEAMS_NOT_A_CALL.iter().any(|chrome| title_lower.contains(chrome)) {
        return false;
    }
    title_lower.contains("meeting") || title_lower.contains("call")
}

fn meeting_app_for_window<'a>(exe_stem: &str, title_lower: &'a str) -> Option<&'a str> {
    if exe_stem == "zoom"
        && (title_lower.contains("zoom meeting") || title_lower.contains("zoom webinar"))
    {
        return Some("zoom");
    }
    if (exe_stem == "ms-teams" || exe_stem == "teams") && teams_title_is_a_call(title_lower) {
        return Some("teams");
    }
    if !is_browser(exe_stem) {
        return None;
    }
    if title_lower.contains("google meet") || title_lower.starts_with("meet -") {
        return Some("google-meet");
    }
    if title_lower.contains("microsoft teams") && teams_title_is_a_call(title_lower) {
        return Some("teams-web");
    }
    if title_lower.contains("zoom meeting") || title_lower.contains("zoom webinar") {
        return Some("zoom-web");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::meeting_app_for_window;

    #[test]
    fn recognizes_native_and_browser_meeting_windows() {
        assert_eq!(
            meeting_app_for_window("zoom", "weekly sync - zoom meeting"),
            Some("zoom")
        );
        assert_eq!(
            meeting_app_for_window("chrome", "meet - abc-defg-hij - google chrome"),
            Some("google-meet")
        );
        assert_eq!(
            meeting_app_for_window("msedge", "project call | microsoft teams"),
            Some("teams-web")
        );
        assert_eq!(meeting_app_for_window("chrome", "google calendar"), None);
    }
}

/// The platform scan: every visible window as (app stem, title).
///
/// Windows walks the desktop with EnumWindows and resolves each window's exe
/// stem. Win32 discipline mirrors win_focus.rs: HWNDs are collected as raw
/// isize, consumed inside this same scan, never stored, never crossing threads.
#[cfg(windows)]
mod scan {
    use super::IconSource;
    use std::collections::HashMap;
    use windows::core::Interface;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::Media::Audio::{
        eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    pub(super) fn visible_windows() -> Vec<(String, String, IconSource)> {
        let mut windows: Vec<(isize, String)> = Vec::new();
        unsafe {
            let _ = EnumWindows(
                Some(enum_callback),
                LPARAM(&mut windows as *mut Vec<(isize, String)> as isize),
            );
        }
        windows
            .into_iter()
            .filter_map(|(hwnd_raw, title)| {
                process_stem_for_window(hwnd_raw)
                    .map(|(stem, path)| (stem, title, IconSource::Exe(path)))
            })
            .collect()
    }

    unsafe extern "system" fn enum_callback(
        hwnd: HWND,
        lparam: LPARAM,
    ) -> windows::core::BOOL {
        unsafe {
            let windows = &mut *(lparam.0 as *mut Vec<(isize, String)>);
            if !IsWindowVisible(hwnd).as_bool() {
                return true.into();
            }
            let length = GetWindowTextLengthW(hwnd);
            if length <= 0 {
                return true.into();
            }
            let mut buffer = vec![0u16; length as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut buffer);
            if copied > 0 {
                let title = String::from_utf16_lossy(&buffer[..copied as usize]);
                windows.push((hwnd.0 as isize, title));
            }
            true.into()
        }
    }

    /// The processes holding an ACTIVE microphone session right now, our own
    /// excluded, each resolved to the app the user would name.
    ///
    /// The one signal in this file that does not read a window title. It first
    /// existed because `EnumWindows` exposes a browser's ACTIVE TAB title and
    /// nothing else, so a Google Meet running in a background tab was invisible
    /// to every matcher above for its first twenty-two minutes. It now also
    /// covers every call app the title table has never heard of.
    ///
    /// Every active capture endpoint, not just the default one: a headset is
    /// routinely not the default device, and the call would be invisible again.
    /// Our own PID is skipped, which is not tidiness - Aura holds the mic
    /// during dictation and during a meeting capture, so counting ourselves
    /// would make the signal true forever and turn a dictation hold into a
    /// detected call. So is our own WebView2: Buddy's voice call captures from
    /// a msedgewebview2.exe child, not from our PID, which is why WebView2
    /// holders are walked up to their host before anything else is decided.
    /// That walk is also what names new Teams, which renders in WebView2.
    pub(super) fn microphone_users(_own_voice_live: bool) -> Vec<super::MicUser> {
        // Idempotent on this long-lived polling thread: every later call
        // returns S_FALSE or RPC_E_CHANGED_MODE, both fine to ignore.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        match collect_microphone_users() {
            Ok(stems) => stems,
            // Never louder than a debug line. A failed probe means the title
            // matcher is the only signal, which is exactly where this started.
            Err(error) => {
                log::debug!("meeting.detect: microphone probe failed: {error}");
                Vec::new()
            }
        }
    }

    fn collect_microphone_users() -> windows::core::Result<Vec<super::MicUser>> {
        let own_pid = std::process::id();
        let mut users: Vec<super::MicUser> = Vec::new();
        // Built only when a WebView2 process holds the mic, which is rare.
        let mut parents: Option<HashMap<u32, u32>> = None;
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
            for device_index in 0..devices.GetCount()? {
                let device = devices.Item(device_index)?;
                let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
                let sessions = manager.GetSessionEnumerator()?;
                for index in 0..sessions.GetCount()? {
                    let control: IAudioSessionControl2 = sessions.GetSession(index)?.cast()?;
                    if control.GetState()? != AudioSessionStateActive {
                        continue;
                    }
                    let pid = control.GetProcessId()?;
                    if pid == 0 || pid == own_pid {
                        continue;
                    }
                    let Some((mut stem, mut path)) = process_stem(pid) else {
                        continue;
                    };
                    if stem == WEBVIEW2_STEM {
                        let parents = parents.get_or_insert_with(parent_pids);
                        let Some(host) = webview2_host(pid, parents) else {
                            continue;
                        };
                        if host == own_pid {
                            continue;
                        }
                        let Some(resolved) = process_stem(host) else {
                            continue;
                        };
                        (stem, path) = resolved;
                    }
                    if users.iter().any(|user| user.stem == stem) {
                        continue;
                    }
                    users.push(super::MicUser {
                        display_name: super::display_name_for_stem(&stem),
                        stem,
                        icon_source: IconSource::Exe(path),
                    });
                }
            }
        }
        Ok(users)
    }

    const WEBVIEW2_STEM: &str = "msedgewebview2";

    /// The first ancestor of a WebView2 process that is not itself WebView2:
    /// the app hosting it. A WebView2 tree is host -> browser process ->
    /// utility processes, so a few hops always suffice; the cap only guards a
    /// recycled parent PID that happens to point back into the chain.
    fn webview2_host(pid: u32, parents: &HashMap<u32, u32>) -> Option<u32> {
        let own_pid = std::process::id();
        let mut current = pid;
        for _ in 0..8 {
            let parent = *parents.get(&current)?;
            if parent == 0 {
                return None;
            }
            if parent == own_pid {
                return Some(parent);
            }
            match process_stem(parent) {
                Some((stem, _)) if stem == WEBVIEW2_STEM => current = parent,
                Some(_) => return Some(parent),
                None => return None,
            }
        }
        None
    }

    /// PID -> parent PID for every running process, from one Toolhelp snapshot.
    fn parent_pids() -> HashMap<u32, u32> {
        let mut parents = HashMap::new();
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return parents;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        parents
    }

    /// PID -> (lowercase exe file stem like "zoom" or "ms-teams", full exe
    /// path) for one window.
    fn process_stem_for_window(hwnd_raw: isize) -> Option<(String, String)> {
        unsafe {
            let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            process_stem(pid)
        }
    }

    /// The half of the lookup above that only needs a PID, split out for the
    /// microphone probe, which has a PID and no window.
    fn process_stem(pid: u32) -> Option<(String, String)> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buffer = vec![0u16; 1024];
            let mut size = buffer.len() as u32;
            let result = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(process);
            result.ok()?;
            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            let stem = std::path::Path::new(&path)
                .file_stem()?
                .to_string_lossy()
                .to_lowercase();
            Some((stem, path))
        }
    }
}

/// macOS has no permission-free EnumWindows analogue, so this is assembled from
/// two sources rather than one:
///
/// - `NSWorkspace.runningApplications` gives every running app's bundle id with
///   no TCC grant at all. `bundle_stem` maps those onto the same stems the
///   Windows exe names produce, so the matching table needs no macOS branch.
/// - Window TITLES come from the accessibility tree, which needs the
///   Accessibility grant dictation already asks for.
///
/// Without that grant the titles come back empty and detection simply never
/// fires. That is the correct failure direction: a missed auto-join is a
/// nuisance, a false one would start recording a meeting the user is not in.
#[cfg(target_os = "macos")]
mod scan {
    use super::IconSource;
    use objc2_app_kit::NSWorkspace;

    pub(super) fn visible_windows() -> Vec<(String, String, IconSource)> {
        let mut found = Vec::new();
        // Titles would all come back empty anyway; skip the AX walk entirely.
        if !crate::macos_ax::is_trusted(false) {
            return found;
        }
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        for app in apps.iter() {
            let Some(bundle_id) = app.bundleIdentifier() else {
                continue;
            };
            let Some(stem) = bundle_stem(&bundle_id.to_string().to_lowercase()) else {
                continue;
            };
            let pid = app.processIdentifier();
            for title in crate::macos_ax::window_titles(pid) {
                found.push((stem.to_string(), title, IconSource::Pid(pid)));
            }
        }
        found
    }

    /// The processes running audio INPUT right now, from Core Audio's process
    /// objects (macOS 14.2+, and the bundle's minimum is 14.4). This reads
    /// process metadata only, never audio, and needs neither the Microphone
    /// nor the Accessibility grant, which is why the ambient tick keeps running
    /// without the latter.
    ///
    /// Helper processes are reported as their host app: Chrome, Discord,
    /// Slack and Teams all capture from a `<bundle id>.helper` process. WebKit
    /// helpers are the one ambiguous case, because Safari's calls and Aura's
    /// own Buddy call both run in them. They count as Safari only while Safari
    /// is running and no Buddy call is live.
    pub(super) fn microphone_users(own_voice_live: bool) -> Vec<super::MicUser> {
        use objc2_core_audio::{
            kAudioHardwarePropertyProcessObjectList, kAudioProcessPropertyBundleID,
            kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyPID,
        };

        let own_pid = std::process::id() as i32;
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        let app_for_bundle = |bundle_id: &str| {
            apps.iter().find(|app| {
                app.bundleIdentifier()
                    .is_some_and(|id| id.to_string().to_lowercase() == bundle_id)
            })
        };
        let safari_running = app_for_bundle("com.apple.safari").is_some();

        let mut users: Vec<super::MicUser> = Vec::new();
        for object in read_object_list(kAudioObjectSystemObject as AudioObjectID, kAudioHardwarePropertyProcessObjectList) {
            if read_u32(object, kAudioProcessPropertyIsRunningInput) != Some(1) {
                continue;
            }
            let Some(pid) = read_u32(object, kAudioProcessPropertyPID).map(|pid| pid as i32) else {
                continue;
            };
            if pid <= 0 || pid == own_pid {
                continue;
            }
            // Daemons carry no bundle id, and none of them is a call.
            let Some(bundle_id) = read_string(object, kAudioProcessPropertyBundleID) else {
                continue;
            };
            let bundle_id = bundle_id.to_lowercase();
            let host_id = if bundle_id.starts_with("com.apple.webkit.") {
                if own_voice_live || !safari_running {
                    continue;
                }
                "com.apple.safari"
            } else {
                bundle_id.find(".helper").map_or(bundle_id.as_str(), |at| &bundle_id[..at])
            };
            let stem = bundle_stem(host_id)
                .or_else(|| mic_only_stem(host_id))
                .map_or_else(|| host_id.to_string(), str::to_string);
            if users.iter().any(|user| user.stem == stem) {
                continue;
            }
            // The host app's own pid, so the card gets its real icon and name
            // rather than a helper's.
            let host = app_for_bundle(host_id);
            let icon_pid = host.as_ref().map_or(pid, |app| app.processIdentifier());
            let display_name = host
                .and_then(|app| app.localizedName())
                .map_or_else(|| super::display_name_for_stem(&stem), |name| name.to_string());
            users.push(super::MicUser {
                stem,
                display_name,
                icon_source: IconSource::Pid(icon_pid),
            });
        }
        users
    }

    /// Call apps the mic pass names but the title scan does not walk: listing
    /// them in `bundle_stem` would put every Slack and Discord window through
    /// the accessibility tree on every tick for titles no matcher reads.
    fn mic_only_stem(bundle_id: &str) -> Option<&'static str> {
        Some(match bundle_id {
            "com.hnc.discord" => "discord",
            "com.tinyspeck.slackmacgap" => "slack",
            "net.whatsapp.whatsapp" | "desktop.whatsapp" => "whatsapp",
            "cisco-systems.spark" => "webex",
            "com.skype.skype" => "skype",
            "org.whispersystems.signal-desktop" => "signal",
            "ru.keepcoder.telegram" | "org.telegram.desktop" => "telegram",
            "com.apple.facetime" => "facetime",
            "com.apple.safari" => "safari",
            _ => return None,
        })
    }

    use objc2_core_audio::{
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
        AudioObjectPropertyAddress, AudioObjectPropertySelector,
    };

    fn address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    fn read_object_list(object: AudioObjectID, selector: AudioObjectPropertySelector) -> Vec<AudioObjectID> {
        let mut address = address(selector);
        let mut size: u32 = 0;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                object,
                std::ptr::NonNull::from(&mut address),
                0,
                std::ptr::null(),
                std::ptr::NonNull::from(&mut size),
            )
        };
        if status != 0 || size == 0 {
            return Vec::new();
        }
        let mut ids: Vec<AudioObjectID> = vec![0; size as usize / std::mem::size_of::<AudioObjectID>()];
        if ids.is_empty() {
            return ids;
        }
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                std::ptr::NonNull::from(&mut address),
                0,
                std::ptr::null(),
                std::ptr::NonNull::from(&mut size),
                std::ptr::NonNull::from(&mut ids[0]).cast(),
            )
        };
        if status != 0 {
            return Vec::new();
        }
        // A process can exit between the two calls, which shrinks the answer.
        ids.truncate(size as usize / std::mem::size_of::<AudioObjectID>());
        ids
    }

    /// A UInt32 property, which is also how Core Audio returns a pid_t.
    fn read_u32(object: AudioObjectID, selector: AudioObjectPropertySelector) -> Option<u32> {
        let mut address = address(selector);
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                std::ptr::NonNull::from(&mut address),
                0,
                std::ptr::null(),
                std::ptr::NonNull::from(&mut size),
                std::ptr::NonNull::from(&mut value).cast(),
            )
        };
        (status == 0).then_some(value)
    }

    /// A CFString property, returned +1 like `macos_audio::default_input_uid`'s
    /// device UID, so it is taken and released on drop.
    fn read_string(object: AudioObjectID, selector: AudioObjectPropertySelector) -> Option<String> {
        use objc2_core_foundation::{CFRetained, CFString};
        let mut address = address(selector);
        let mut value: *const CFString = std::ptr::null();
        let mut size = std::mem::size_of::<*const CFString>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                std::ptr::NonNull::from(&mut address),
                0,
                std::ptr::null(),
                std::ptr::NonNull::from(&mut size),
                std::ptr::NonNull::from(&mut value).cast(),
            )
        };
        if status != 0 || value.is_null() {
            return None;
        }
        let value = unsafe { CFRetained::from_raw(std::ptr::NonNull::new(value as *mut CFString)?) };
        let text = value.to_string();
        (!text.is_empty()).then_some(text)
    }

    /// Bundle id -> the same stem the Windows exe name yields, so
    /// `meeting_app_for_window`'s table is genuinely shared rather than
    /// duplicated. Anything not listed is not an app this detector cares about.
    fn bundle_stem(bundle_id: &str) -> Option<&'static str> {
        Some(match bundle_id {
            "us.zoom.xos" => "zoom",
            "com.microsoft.teams" | "com.microsoft.teams2" => "ms-teams",
            "com.google.chrome" | "com.google.chrome.beta" => "chrome",
            "com.microsoft.edgemac" => "msedge",
            "com.brave.browser" => "brave",
            "org.mozilla.firefox" => "firefox",
            _ => return None,
        })
    }
}
