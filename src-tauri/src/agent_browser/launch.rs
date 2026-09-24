//! Finds an installed Chromium browser, launches it with Aura's OWN profile,
//! and owns its lifetime.
//!
//! Never the user's browser (entry section 8.1): since Chrome 136 the default
//! profile refuses remote debugging, and attaching to it would put the agent
//! inside every account the user is signed in to. The profile under
//! `app_local_data/agent-browser/profile` is created by the browser itself on
//! first launch (`--no-first-run`) and reused after, so a site the user signs
//! in to by hand later stays signed in. Pick order is Chrome, Edge, Brave
//! (section 9.4); Firefox and Safari have no CDP.
//!
//! Two things that are easy to get wrong:
//! - `DevToolsActivePort` is written AFTER the port binds, but a stale file
//!   from a crashed run can sit in the profile. It is deleted before the
//!   spawn and its mtime must postdate the spawn. A child that exits within
//!   three seconds is the profile-lock case: Chrome hands the URL to a
//!   running instance and exits 0.
//! - The browser must die with Aura. On Windows the child is assigned to a
//!   Job Object with `KILL_ON_JOB_CLOSE`, so a crash of this process takes
//!   the whole tree down; a pid file covers the case the job could not be
//!   created and the macOS side, where the startup sweep terminates a leftover.
//!
//! Only this file has a platform seam. Both halves are real.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use log::{info, warn};

const PORT_FILE: &str = "DevToolsActivePort";
const PID_FILE: &str = "aura-agent.pid";
const PORT_WAIT: Duration = Duration::from_secs(10);
const EARLY_EXIT_WINDOW: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Browser {
    Chrome,
    Edge,
    Brave,
}

impl Browser {
    pub fn label(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Edge => "msedge",
            Self::Brave => "brave",
        }
    }

    const ORDER: [Browser; 3] = [Browser::Chrome, Browser::Edge, Browser::Brave];
}

/// Why no browser could be launched, as the task's failure code.
#[derive(Debug)]
pub enum LaunchError {
    /// No Chromium browser is installed (or none could be found).
    NotInstalled,
    /// Every installed browser has remote debugging disabled by policy.
    PolicyBlocked,
    /// The profile is held by another instance and this one exited at once.
    ProfileLocked,
    /// Spawn or port discovery failed for another reason.
    Other(String),
}

impl LaunchError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotInstalled => "browser_not_installed",
            Self::PolicyBlocked => "browser_policy_blocked",
            Self::ProfileLocked => "browser_profile_locked",
            Self::Other(_) => "browser_launch_failed",
        }
    }

    /// The underlying message for the log line; the code above is what the
    /// row and the card carry.
    pub fn detail(&self) -> &str {
        match self {
            Self::Other(detail) => detail,
            _ => "",
        }
    }
}

pub struct Launched {
    pub browser: Browser,
    pub port: u16,
    pub browser_ws_path: String,
    pub pid: u32,
    child: Child,
    // Held for its Drop: closing the job handle kills the tree.
    #[cfg(target_os = "windows")]
    _job: Option<platform::JobGuard>,
}

impl Launched {
    /// Ends the browser process. `Browser.close` over CDP is tried first by
    /// the caller; this is the hard stop behind it.
    pub fn kill(&mut self) {
        if let Err(error) = self.child.kill() {
            // Already gone is the common case after a clean Browser.close.
            info!("agent_browser.launch: kill: {error}");
        }
        let _ = self.child.wait();
    }
}

impl Drop for Launched {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn profile_dir(root: &Path) -> PathBuf {
    root.join("profile")
}

/// Launches the first installed browser whose policy allows CDP, with a
/// fresh (or reused) profile under `root`, and waits for its debugging port.
pub fn launch(root: &Path) -> Result<Launched, LaunchError> {
    std::fs::create_dir_all(root).map_err(|e| LaunchError::Other(e.to_string()))?;
    let profile = profile_dir(root);
    let mut any_installed = false;
    let mut any_blocked = false;
    for browser in Browser::ORDER {
        let Some(exe) = platform::find_executable(browser) else { continue };
        any_installed = true;
        if platform::policy_blocks_debugging(browser) {
            warn!("agent_browser.launch: browser={} blocked by policy", browser.label());
            any_blocked = true;
            continue;
        }
        match spawn(browser, &exe, root, &profile) {
            Ok(launched) => return Ok(launched),
            Err(LaunchError::ProfileLocked) => return Err(LaunchError::ProfileLocked),
            Err(error) => {
                warn!("agent_browser.launch: browser={} failed: {error:?}", browser.label());
            }
        }
    }
    if any_blocked {
        return Err(LaunchError::PolicyBlocked);
    }
    if !any_installed {
        return Err(LaunchError::NotInstalled);
    }
    Err(LaunchError::Other("every browser failed to start".to_string()))
}

fn spawn(browser: Browser, exe: &Path, root: &Path, profile: &Path) -> Result<Launched, LaunchError> {
    let port_file = profile.join(PORT_FILE);
    let _ = std::fs::remove_file(&port_file);
    let spawned_at = SystemTime::now();
    let mut command = Command::new(exe);
    command
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--remote-debugging-port=0")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-sync")
        .arg("--disable-extensions")
        .arg("--disable-background-networking")
        .arg("--disable-session-crashed-bubble")
        .arg("--hide-crash-restore-bubble")
        .arg("--no-service-autorun")
        .arg("--password-store=basic")
        // Off screen from the first frame, so nothing flashes before the
        // window is hidden (Windows) or minimized (macOS) after connect.
        .arg("--window-position=-32000,-32000")
        .arg("--window-size=1280,900")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    platform::before_spawn(&mut command);
    let mut child = command.spawn().map_err(|e| LaunchError::Other(format!("spawn: {e}")))?;
    let pid = child.id();
    #[cfg(target_os = "windows")]
    let job = platform::assign_job(&child);
    let _ = std::fs::write(root.join(PID_FILE), pid.to_string());

    let started = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let _ = std::fs::remove_file(root.join(PID_FILE));
            return if started.elapsed() < EARLY_EXIT_WINDOW {
                Err(LaunchError::ProfileLocked)
            } else {
                Err(LaunchError::Other(format!("browser exited: {status}")))
            };
        }
        if let Some((port, path)) = read_port_file(&port_file, spawned_at) {
            info!(
                "agent_browser.launch: browser={} pid={pid} port_ms={}",
                browser.label(),
                started.elapsed().as_millis()
            );
            return Ok(Launched {
                browser,
                port,
                browser_ws_path: path,
                pid,
                child,
                #[cfg(target_os = "windows")]
                _job: job,
            });
        }
        if started.elapsed() > PORT_WAIT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(root.join(PID_FILE));
            return Err(LaunchError::Other("debugging port never appeared".to_string()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn read_port_file(path: &Path, spawned_at: SystemTime) -> Option<(u16, String)> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.modified().ok()? < spawned_at {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let ws_path = lines.next()?.trim().to_string();
    if port == 0 || !ws_path.starts_with("/devtools/browser/") {
        return None;
    }
    Some((port, ws_path))
}

/// Startup sweep: a browser left behind by a crash is still holding the
/// profile, so the next task would fail with `ProfileLocked`. Terminates it
/// only when the pid still names one of the three browsers.
pub fn kill_orphan(root: &Path) {
    let pid_path = root.join(PID_FILE);
    let Ok(text) = std::fs::read_to_string(&pid_path) else { return };
    let _ = std::fs::remove_file(&pid_path);
    let Ok(pid) = text.trim().parse::<u32>() else { return };
    if pid == 0 || pid == std::process::id() {
        return;
    }
    if platform::terminate_if_browser(pid) {
        warn!("agent_browser.launch: terminated orphaned browser pid={pid}");
    }
}

pub fn clear_pid_file(root: &Path) {
    let _ = std::fs::remove_file(root.join(PID_FILE));
}

/// Windows: the browser window is hidden at the HWND level (a minimized
/// Chrome still owns a taskbar button). macOS has no such lever short of
/// the protocol's minimize, which the caller applies instead.
pub fn set_windows_visible(pid: u32, visible: bool) {
    platform::set_windows_visible(pid, visible);
}

#[cfg(target_os = "windows")]
mod platform {
    use std::path::PathBuf;
    use std::process::{Child, Command};

    use log::warn;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD,
        RRF_RT_REG_SZ,
    };
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE,
    };

    use super::Browser;

    /// Owns the job handle; dropping it closes the handle, and with
    /// KILL_ON_JOB_CLOSE that ends every process assigned to it.
    pub struct JobGuard(HANDLE);

    impl Drop for JobGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn reg_string(root: HKEY, path: &str, value: Option<&str>) -> Option<String> {
        let path_w = wide(path);
        let value_w = value.map(wide);
        let mut size: u32 = 0;
        unsafe {
            let value_ptr = value_w
                .as_ref()
                .map(|v| PCWSTR(v.as_ptr()))
                .unwrap_or(PCWSTR::null());
            if RegGetValueW(root, PCWSTR(path_w.as_ptr()), value_ptr, RRF_RT_REG_SZ, None, None, Some(&mut size))
                .is_err()
                || size == 0
            {
                return None;
            }
            let mut buffer = vec![0u16; (size as usize / 2) + 1];
            if RegGetValueW(
                root,
                PCWSTR(path_w.as_ptr()),
                value_ptr,
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
            .is_err()
            {
                return None;
            }
            let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            Some(String::from_utf16_lossy(&buffer[..end]))
        }
    }

    fn reg_dword(root: HKEY, path: &str, value: &str) -> Option<u32> {
        let path_w = wide(path);
        let value_w = wide(value);
        let mut data: u32 = 0;
        let mut size: u32 = std::mem::size_of::<u32>() as u32;
        unsafe {
            RegGetValueW(
                root,
                PCWSTR(path_w.as_ptr()),
                PCWSTR(value_w.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut data as *mut u32).cast()),
                Some(&mut size),
            )
            .ok()
            .ok()
            .map(|_| data)
        }
    }

    fn exe_name(browser: Browser) -> &'static str {
        match browser {
            Browser::Chrome => "chrome.exe",
            Browser::Edge => "msedge.exe",
            Browser::Brave => "brave.exe",
        }
    }

    pub fn find_executable(browser: Browser) -> Option<PathBuf> {
        let app_paths = format!(
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{}",
            exe_name(browser)
        );
        for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            if let Some(path) = reg_string(root, &app_paths, None) {
                let path = PathBuf::from(path.trim_matches('"'));
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        let suffix = match browser {
            Browser::Chrome => "Google\\Chrome\\Application\\chrome.exe",
            Browser::Edge => "Microsoft\\Edge\\Application\\msedge.exe",
            Browser::Brave => "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        };
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                let candidate = PathBuf::from(base).join(suffix);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    /// `RemoteDebuggingAllowed = 0` or `DeveloperToolsAvailability = 2` under
    /// the browser's policy key (machine or user) disables CDP outright.
    pub fn policy_blocks_debugging(browser: Browser) -> bool {
        let key = match browser {
            Browser::Chrome => "SOFTWARE\\Policies\\Google\\Chrome",
            Browser::Edge => "SOFTWARE\\Policies\\Microsoft\\Edge",
            Browser::Brave => "SOFTWARE\\Policies\\BraveSoftware\\Brave",
        };
        for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            if reg_dword(root, key, "RemoteDebuggingAllowed") == Some(0) {
                return true;
            }
            if reg_dword(root, key, "DeveloperToolsAvailability") == Some(2) {
                return true;
            }
        }
        false
    }

    pub fn before_spawn(_command: &mut Command) {}

    pub fn assign_job(child: &Child) -> Option<JobGuard> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            let job = match CreateJobObjectW(None, PCWSTR::null()) {
                Ok(job) => job,
                Err(error) => {
                    warn!("agent_browser.launch: CreateJobObject failed: {error}");
                    return None;
                }
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                warn!("agent_browser.launch: SetInformationJobObject failed: {error}");
                let _ = CloseHandle(job);
                return None;
            }
            let process = HANDLE(child.as_raw_handle());
            if let Err(error) = AssignProcessToJobObject(job, process) {
                // Nested jobs are allowed since Windows 8; a refusal here is a
                // legacy session. The pid file sweep still covers the orphan.
                warn!("agent_browser.launch: AssignProcessToJobObject failed: {error}");
                let _ = CloseHandle(job);
                return None;
            }
            Some(JobGuard(job))
        }
    }

    pub fn terminate_if_browser(pid: u32) -> bool {
        let Some(stem) = crate::system_control::process_stem_for_pid(pid) else { return false };
        if !matches!(stem.as_str(), "chrome" | "msedge" | "brave") {
            return false;
        }
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_TERMINATE, false, pid) else { return false };
            let killed = TerminateProcess(process, 1).is_ok();
            let _ = CloseHandle(process);
            killed
        }
    }

    struct Scan {
        pid: u32,
        hwnds: Vec<isize>,
    }

    unsafe extern "system" fn collect_windows_for_pid(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        unsafe {
            let scan = &mut *(lparam.0 as *mut Scan);
            let mut owner: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut owner));
            if owner == scan.pid {
                scan.hwnds.push(hwnd.0 as isize);
            }
            true.into()
        }
    }

    pub fn set_windows_visible(pid: u32, visible: bool) {
        let mut scan = Scan { pid, hwnds: Vec::new() };
        unsafe {
            let _ = EnumWindows(
                Some(collect_windows_for_pid),
                LPARAM(&mut scan as *mut Scan as isize),
            );
            for raw in scan.hwnds {
                let hwnd = HWND(raw as *mut std::ffi::c_void);
                let _ = ShowWindow(hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::PathBuf;
    use std::process::{Child, Command};

    use super::Browser;

    fn app_relative(browser: Browser) -> &'static str {
        match browser {
            Browser::Chrome => "Google Chrome.app/Contents/MacOS/Google Chrome",
            Browser::Edge => "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            Browser::Brave => "Brave Browser.app/Contents/MacOS/Brave Browser",
        }
    }

    fn bundle_id(browser: Browser) -> &'static str {
        match browser {
            Browser::Chrome => "com.google.Chrome",
            Browser::Edge => "com.microsoft.Edge",
            Browser::Brave => "com.brave.Browser",
        }
    }

    pub fn find_executable(browser: Browser) -> Option<PathBuf> {
        let relative = app_relative(browser);
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        roots
            .into_iter()
            .map(|root| root.join(relative))
            .find(|candidate| candidate.is_file())
    }

    /// `defaults read` exits non-zero when the key is absent, which is the
    /// allowed case; only an explicit 0 blocks.
    pub fn policy_blocks_debugging(browser: Browser) -> bool {
        let read = |key: &str| {
            Command::new("defaults")
                .args(["read", bundle_id(browser), key])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        };
        read("RemoteDebuggingAllowed").as_deref() == Some("0")
            || read("DeveloperToolsAvailability").as_deref() == Some("2")
    }

    pub fn before_spawn(command: &mut Command) {
        // A separate process group, so a signal aimed at Aura's group does
        // not reach the browser (and the reverse), matching the Windows job.
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    pub fn terminate_if_browser(pid: u32) -> bool {
        let Ok(output) = Command::new("ps").args(["-p", &pid.to_string(), "-o", "comm="]).output() else {
            return false;
        };
        let comm = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if !(comm.contains("google chrome") || comm.contains("microsoft edge") || comm.contains("brave browser")) {
            return false;
        }
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub fn set_windows_visible(_pid: u32, _visible: bool) {}

    #[allow(dead_code)]
    pub fn assign_job(_child: &Child) -> Option<()> {
        None
    }
}
