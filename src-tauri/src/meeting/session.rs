//! Windows session lock/unlock watcher.
//!
//! Capture must pause while the workstation is locked (recording a locked
//! machine's audio is exactly the ambient-surveillance pattern this feature's
//! trust model forbids) and resume on unlock. WTSRegisterSessionNotification
//! needs an HWND with a message pump, and the main window's wndproc belongs
//! to Tauri, so this runs its own message-only window on a dedicated thread
//! that lives for the rest of the process. The engine polls `is_locked()`
//! each mixing cycle; a one-cycle (~100ms) detection lag is irrelevant at
//! speech timescales.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use log::{error, info};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
};

/// WM_WTSSESSION_CHANGE and its wParam codes; the windows crate scatters
/// these across features, so the raw values (stable since XP) are used
/// directly with their names pinned here.
const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WTS_SESSION_LOCK: usize = 0x7;
const WTS_SESSION_UNLOCK: usize = 0x8;

static LOCKED: AtomicBool = AtomicBool::new(false);
static WATCHER: OnceLock<()> = OnceLock::new();

pub fn is_locked() -> bool {
    LOCKED.load(Ordering::Relaxed)
}

/// Starts the watcher thread on first call; later calls are no-ops. Failure
/// to start degrades to "never reports locked" - capture then keeps running
/// through a lock, which is the pre-existing behavior, not a crash.
pub fn ensure_watcher() {
    WATCHER.get_or_init(|| {
        if let Err(e) = std::thread::Builder::new()
            .name("meeting-session-watch".to_string())
            .spawn(run_watcher)
        {
            error!("meeting.session: failed to spawn watcher thread: {e}");
        }
    });
}

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
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn run_watcher() {
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
        info!("meeting.session: watcher running");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
