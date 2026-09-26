//! Session lock/unlock watcher.
//!
//! Capture must pause while the machine is locked (recording a locked
//! machine's audio is exactly the ambient-surveillance pattern this feature's
//! trust model forbids) and resume on unlock. The engine polls `is_locked()`
//! each mixing cycle; a one-cycle (~100ms) detection lag is irrelevant at
//! speech timescales.
//!
//! Both platforms need their own thread for this and for the same reason: the
//! notification wants a run loop, and the app's own belongs to Tauri.
//! Windows registers a message-only window for WTS session notifications;
//! macOS observes the two distributed notifications the login window posts.
//! Neither can be polled cheaply, so both push into `LOCKED`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use log::error;

static LOCKED: AtomicBool = AtomicBool::new(false);
static WATCHER: OnceLock<()> = OnceLock::new();

pub fn is_locked() -> bool {
    LOCKED.load(Ordering::Relaxed)
}

/// Suspend and resume, delivered by the same watcher thread because both
/// platforms hand them to whoever already owns a run loop or a message
/// window. Nothing here reacts to them; the listeners registered at launch
/// (`lib.rs`) do, so this file stays about the OS edge and not about audio
/// or keyboard hooks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerEvent {
    Suspend,
    Resume,
}

/// Plain fn pointers on purpose: no captured handles, so registering from
/// setup cannot keep an `AppHandle` alive on a thread that never exits.
type PowerListener = fn(PowerEvent);
static POWER_LISTENERS: OnceLock<Mutex<Vec<PowerListener>>> = OnceLock::new();

pub fn on_power(listener: fn(PowerEvent)) {
    let listeners = POWER_LISTENERS.get_or_init(|| Mutex::new(Vec::new()));
    crate::util::lock(listeners).push(listener);
}

fn fire_power(event: PowerEvent) {
    log::info!("meeting.session: power {event:?}");
    let Some(listeners) = POWER_LISTENERS.get() else { return };
    let snapshot: Vec<PowerListener> = crate::util::lock(listeners).clone();
    for listener in snapshot {
        listener(event);
    }
}

/// Starts the watcher thread on first call; later calls are no-ops. Failure
/// to start degrades to "never reports locked" - capture then keeps running
/// through a lock, which is the pre-existing behavior, not a crash.
pub fn ensure_watcher() {
    WATCHER.get_or_init(|| {
        if let Err(e) = std::thread::Builder::new()
            .name("meeting-session-watch".to_string())
            .spawn(platform::run_watcher)
        {
            error!("meeting.session: failed to spawn watcher thread: {e}");
        }
    });
}

#[cfg(windows)]
mod platform {

use std::sync::atomic::Ordering;

use log::{error, info};
use windows::core::w;
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::RegisterSuspendResumeNotification;
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, HWND_MESSAGE, MSG, WINDOW_EX_STYLE,
    WINDOW_STYLE, WNDCLASSW,
};

/// WM_WTSSESSION_CHANGE and its wParam codes; the windows crate scatters
/// these across features, so the raw values (stable since XP) are used
/// directly with their names pinned here.
const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WTS_SESSION_LOCK: usize = 0x7;
const WTS_SESSION_UNLOCK: usize = 0x8;
/// WM_POWERBROADCAST and the two wParam codes that matter. Pinned the same
/// way. PBT_APMRESUMEAUTOMATIC fires on EVERY resume; PBT_APMRESUMESUSPEND
/// only when the user caused it, so the automatic one is the reliable edge.
const WM_POWERBROADCAST: u32 = 0x0218;
const PBT_APMSUSPEND: usize = 0x4;
const PBT_APMRESUMEAUTOMATIC: usize = 0x12;

use super::{fire_power, PowerEvent, LOCKED};

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_WTSSESSION_CHANGE {
        match wparam.0 {
            WTS_SESSION_LOCK => {
                info!("meeting.session: session locked");
                LOCKED.store(true, Ordering::Relaxed);
            }
            WTS_SESSION_UNLOCK => {
                info!("meeting.session: session unlocked");
                LOCKED.store(false, Ordering::Relaxed);
            }
            _ => {}
        }
    }
    if msg == WM_POWERBROADCAST {
        match wparam.0 {
            PBT_APMSUSPEND => fire_power(PowerEvent::Suspend),
            PBT_APMRESUMEAUTOMATIC => fire_power(PowerEvent::Resume),
            _ => {}
        }
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

pub(super) fn run_watcher() {
    unsafe {
        let class_name = w!("AuraMeetingSessionWatch");
        let instance = match GetModuleHandleW(None) {
            Ok(instance) => instance,
            Err(e) => {
                error!("meeting.session: GetModuleHandleW failed: {e}");
                return;
            }
        };
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            error!("meeting.session: RegisterClassW failed");
            return;
        }
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!(""),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE), // message-only: never visible, never focusable
            None,
            Some(instance.into()),
            None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                error!("meeting.session: CreateWindowExW failed: {e}");
                return;
            }
        };
        if let Err(e) = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) {
            error!("meeting.session: WTSRegisterSessionNotification failed: {e}");
            return;
        }
        // WM_POWERBROADCAST is a broadcast, and broadcasts never reach a
        // message-only window. This explicit registration delivers it to this
        // exact hwnd instead. Never unregistered: the thread lives for the
        // process. A failure only costs the resume handling, so it is logged
        // and the lock watcher carries on.
        if let Err(e) = RegisterSuspendResumeNotification(
            HANDLE(hwnd.0),
            DEVICE_NOTIFY_WINDOW_HANDLE,
        ) {
            error!("meeting.session: RegisterSuspendResumeNotification failed: {e}");
        }
        info!("meeting.session: watcher running");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

}

/// macOS posts screen lock and unlock as distributed notifications from the
/// login window. There is no polling API for the state, so the initial value
/// comes from the window server's own session dictionary and every later
/// change comes from these two notifications.
///
/// `CGSessionCopyCurrentDictionary` is the seed rather than the whole answer
/// because it is a snapshot: reading it on a timer would either miss short
/// locks or burn a wakeup every cycle.
#[cfg(target_os = "macos")]
mod platform {
    use std::sync::atomic::Ordering;

    use block2::RcBlock;
    use log::{error, info};
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSString};

    use super::{fire_power, PowerEvent, LOCKED};

    const SCREEN_LOCKED: &str = "com.apple.screenIsLocked";
    const SCREEN_UNLOCKED: &str = "com.apple.screenIsUnlocked";

    pub(super) fn run_watcher() {
        use objc2_core_foundation::{CFRunLoop, CFString};

        seed_initial_state();

        let center = NSDistributedNotificationCenter::defaultCenter();
        let observe = |name: &str, locked: bool| {
            let block = RcBlock::new(move |_notification: std::ptr::NonNull<NSNotification>| {
                info!(
                    "meeting.session: session {}",
                    if locked { "locked" } else { "unlocked" }
                );
                LOCKED.store(locked, Ordering::Relaxed);
            });
            // Leaked deliberately: the observer lives for the rest of the
            // process, exactly like the Windows message-only window, and the
            // token is never needed again.
            let _token = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(&NSString::from_str(name)),
                    None,
                    None,
                    &block,
                )
            };
            std::mem::forget(block);
            std::mem::forget(_token);
        };
        observe(SCREEN_LOCKED, true);
        observe(SCREEN_UNLOCKED, false);

        // Sleep and wake come from the workspace center, not the distributed
        // one. Same leak-for-life pattern as the observers above.
        let workspace_center = unsafe { NSWorkspace::sharedWorkspace().notificationCenter() };
        let observe_power = |name: &objc2_foundation::NSNotificationName, event: PowerEvent| {
            let block = RcBlock::new(move |_notification: std::ptr::NonNull<NSNotification>| {
                fire_power(event);
            });
            let _token = unsafe {
                workspace_center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    None,
                    &block,
                )
            };
            std::mem::forget(block);
            std::mem::forget(_token);
        };
        unsafe {
            observe_power(NSWorkspaceWillSleepNotification, PowerEvent::Suspend);
            observe_power(NSWorkspaceDidWakeNotification, PowerEvent::Resume);
        }

        let Some(_) = CFRunLoop::current() else {
            error!("meeting.session: no run loop on the watcher thread");
            return;
        };
        // Keep the name in scope so the linker resolves CFString; the run loop
        // below is what actually delivers the notifications.
        let _ = CFString::from_str("");
        info!("meeting.session: watcher running");
        CFRunLoop::run();
    }

    /// The lock state at the moment the watcher starts, so a capture armed
    /// while the screen is already locked does not begin recording.
    fn seed_initial_state() {
        use objc2_core_foundation::{CFDictionary, CFRetained, CFString};

        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGSessionCopyCurrentDictionary() -> *const CFDictionary;
        }

        let raw = unsafe { CGSessionCopyCurrentDictionary() };
        let Some(raw) = std::ptr::NonNull::new(raw as *mut CFDictionary) else {
            return;
        };
        let session = unsafe { CFRetained::from_raw(raw) };
        let key = CFString::from_str("CGSSessionScreenIsLocked");
        let value = unsafe {
            session.value(
                (&*key as *const CFString).cast::<std::ffi::c_void>(),
            )
        };
        // The key is absent entirely when the screen is unlocked, so presence
        // is the signal and its boolean value only confirms it.
        LOCKED.store(!value.is_null(), Ordering::Relaxed);
    }
}

/// No other desktop target ships. Never reporting locked matches what every
/// platform did before this watcher existed.
#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    pub(super) fn run_watcher() {}
}
