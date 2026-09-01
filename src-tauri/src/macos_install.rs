//! Install-location guard, macOS only.
//!
//! A Mac user who double-clicks the app inside the mounted disk image, or runs
//! it straight out of ~/Downloads, gets a working app that can never update
//! itself. The updater swaps the bundle in place; the disk image is read-only,
//! and a quarantined bundle launched where it was downloaded runs from a
//! random read-only AppTranslocation path instead. Both surface as "read-only
//! filesystem (os error 30)" on the next update, which updater.rs turns into a
//! notice but cannot repair. Wispr Flow and Granola both insist on
//! /Applications for the same reason; Tauri's updater has no such guard, so
//! this is it.
//!
//! Runs first in setup, before any window or worker exists, on the main
//! thread, and only in release builds: `tauri dev` runs from target/debug and
//! must never see this dialog. It is the one native dialog in the app, because
//! there is no webview yet to draw one.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use log::{error, info, warn};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication};
use objc2_foundation::NSString;

const APPLICATIONS: &str = "/Applications";

/// Offers to move a misplaced bundle into /Applications and relaunch from
/// there. Returns normally when the app is already installed, the user
/// declines, or the move fails; exits the process after a successful move.
pub fn ensure_in_applications() {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(bundle) = misplaced_bundle() else {
        return;
    };
    let Some(mtm) = MainThreadMarker::new() else {
        warn!("install guard: not on the main thread, skipping");
        return;
    };
    let location = describe(&bundle);
    info!("install guard: running from {location}");

    let accepted = ask(
        mtm,
        "Move Aura Desktop to the Applications folder?",
        &format!(
            "Aura is running from {location}. It can only keep itself up to date from the \
             Applications folder. Move it there now and relaunch?"
        ),
        "Move to Applications",
        Some("Not Now"),
    );
    if !accepted {
        info!("install guard: user declined the move");
        return;
    }

    match move_to_applications(&bundle) {
        Ok(dest) => relaunch_and_exit(&dest),
        Err(e) => {
            error!("install guard: move failed: {e}");
            sentry::capture_message(
                &format!("install guard: move failed: {e}"),
                sentry::Level::Warning,
            );
            ask(
                mtm,
                "Aura could not move itself",
                "Drag Aura Desktop into your Applications folder, then open it from there.",
                "OK",
                None,
            );
        }
    }
}

/// The running bundle, if it lives somewhere the updater cannot write. None
/// when it is under /Applications or ~/Applications, or when the executable is
/// not inside a bundle at all (a bare binary during development).
fn misplaced_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // <name>.app/Contents/MacOS/<executable>
    let bundle = exe.parent()?.parent()?.parent()?;
    if bundle.extension()?.to_str()? != "app" {
        return None;
    }
    let path = bundle.to_str()?;
    let home_apps = std::env::var("HOME").ok().map(|home| format!("{home}/Applications/"));
    let installed = path.starts_with(&format!("{APPLICATIONS}/"))
        || home_apps.as_deref().is_some_and(|dir| path.starts_with(dir));
    if installed {
        None
    } else {
        Some(bundle.to_path_buf())
    }
}

/// A user-facing name for where the bundle is, never the path itself: the
/// path carries the user name and lands in logs.
fn describe(bundle: &Path) -> &'static str {
    let path = bundle.to_string_lossy();
    if path.starts_with("/Volumes/") {
        "the disk image"
    } else if path.contains("/AppTranslocation/") {
        "a temporary location"
    } else if path.contains("/Downloads/") {
        "the Downloads folder"
    } else {
        "outside the Applications folder"
    }
}

/// Copies the bundle into /Applications, setting any existing copy aside
/// first and dropping it only once the copy succeeded, so a failure halfway
/// never leaves the user without a launchable app. `ditto` rather than a
/// rename because the disk image is read-only and a rename cannot cross
/// volumes; ditto also preserves the signature and extended attributes.
fn move_to_applications(bundle: &Path) -> Result<PathBuf, String> {
    let name = bundle
        .file_name()
        .ok_or_else(|| "bundle has no name".to_string())?;
    let dest = Path::new(APPLICATIONS).join(name);
    let aside = Path::new(APPLICATIONS).join(format!("{}.previous", name.to_string_lossy()));

    if aside.exists() {
        std::fs::remove_dir_all(&aside)
            .map_err(|e| format!("could not clear a stale previous copy: {e}"))?;
    }
    let had_previous = dest.exists();
    if had_previous {
        std::fs::rename(&dest, &aside)
            .map_err(|e| format!("could not set aside the existing copy: {e}"))?;
    }

    let status = Command::new("/usr/bin/ditto")
        .arg(bundle)
        .arg(&dest)
        .status()
        .map_err(|e| format!("could not run ditto: {e}"))?;
    if !status.success() {
        if had_previous {
            let _ = std::fs::remove_dir_all(&dest);
            let _ = std::fs::rename(&aside, &dest);
        }
        return Err(format!("ditto exited with {status}"));
    }

    if had_previous {
        if let Err(e) = std::fs::remove_dir_all(&aside) {
            warn!("install guard: could not remove the previous copy: {e}");
        }
    }
    Ok(dest)
}

/// Opens the installed copy from a detached shell after a short delay and
/// exits. The delay matters: the single-instance plugin would otherwise hand
/// the new launch to this still-running process, which is about to die.
fn relaunch_and_exit(dest: &Path) -> ! {
    let script = format!("sleep 1; /usr/bin/open \"{}\"", dest.display());
    match Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => info!("install guard: moved to Applications, relaunching"),
        Err(e) => error!("install guard: moved but could not schedule the relaunch: {e}"),
    }
    std::process::exit(0);
}

/// A modal alert with one or two buttons. Returns true when the first button
/// was chosen. Activates the app first: an Accessory-policy app has no Dock
/// presence, and an alert from one appears behind the current window unless
/// the app is brought forward.
fn ask(
    mtm: MainThreadMarker,
    message: &str,
    detail: &str,
    primary: &str,
    secondary: Option<&str>,
) -> bool {
    let app = NSApplication::sharedApplication(mtm);
    app.activate();
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(message));
    alert.setInformativeText(&NSString::from_str(detail));
    let _ = alert.addButtonWithTitle(&NSString::from_str(primary));
    if let Some(title) = secondary {
        let _ = alert.addButtonWithTitle(&NSString::from_str(title));
    }
    alert.runModal() == NSAlertFirstButtonReturn
}
