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
use std::time::Duration;

use core_foundation::base::TCFType;
use core_foundation::error::{CFError, CFErrorRef};
use core_foundation::url::{CFURL, CFURLRef};
use log::{error, info, warn};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication};
use objc2_foundation::NSString;

const APPLICATIONS: &str = "/Applications";

/// How recent a guard relaunch has to be for a fresh launch to count as the
/// same cycle. Comfortably longer than the two second delay in
/// `relaunch_and_exit` plus a cold start, short enough that a genuine relaunch
/// hours later is never mistaken for a loop.
const RELAUNCH_WINDOW: Duration = Duration::from_secs(60);

/// The attribute that arms App Translocation. Everything else a downloaded
/// bundle carries (com.apple.macl for TCC, com.apple.provenance) must survive,
/// so this is removed by name rather than clearing the lot.
const QUARANTINE: &str = "com.apple.quarantine";

// SecTranslocate, Security.framework, public since 10.12. Apple's own answer to
// "where does this translocated bundle really live", and it stays right even
// when the original has been renamed, which parsing the mount table does not.
// Boolean here is unsigned char, not C99 bool, hence the u8 return.
#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecTranslocateIsTranslocatedURL(
        path: CFURLRef,
        is_translocated: *mut bool,
        error: *mut CFErrorRef,
    ) -> u8;
    fn SecTranslocateCreateOriginalPathForURL(
        translocated: CFURLRef,
        error: *mut CFErrorRef,
    ) -> CFURLRef;
}

/// Gets a misplaced bundle into /Applications and relaunches from there.
/// Silent for a first install off the disk image, where there is nothing to
/// lose and macOS has already made this launch useless for updates; asks first
/// in every other case. Returns normally when the app is already installed,
/// the user declines, the move fails, or a previous guard relaunch just came
/// back unfixed; exits the process after a successful move.
pub fn ensure_in_applications() {
    if cfg!(debug_assertions) {
        return;
    }
    // Resolved before misplaced_bundle, which cannot tell a translocated
    // launch from an ordinary one: the mirror lives under /private/var/folders,
    // so it fails the /Applications test and the copy path below would be
    // handed a path that vanishes with the mount. Which of the two translocated
    // cases this is depends on where the ORIGIN lives, not on the fact of
    // translocation.
    let translocated = translocation_origin();
    let misplaced = if translocated.is_none() { misplaced_bundle() } else { None };

    // Installed, and running from where it was installed. The ordinary case,
    // and the one that must NOT consult the relaunch stamp: the launch right
    // after a SUCCESSFUL guard relaunch lands here about three seconds after
    // the stamp was written, and telling a correctly installed app that it
    // "cannot update itself from here" would be worse than the loop the stamp
    // exists to stop.
    if translocated.is_none() && misplaced.is_none() {
        return;
    }
    // Something still needs fixing AND the guard already relaunched us for it
    // moments ago, so that relaunch did not work. Going round again is how this
    // turns into an app that never opens at all.
    if relaunched_recently() {
        loop_broken();
        return;
    }

    let was_translocated = translocated.is_some();
    let bundle = match translocated {
        // Already installed, so there is nothing to copy and the attribute is
        // the whole problem.
        Some(origin) if is_installed(&origin) => {
            repair_translocated(&origin);
            return;
        }
        // Still on the disk image or in Downloads. The quarantine that armed
        // the translocation is on the MOUNT here, not on the bundle, so
        // clear_quarantine has nothing to remove and reports success anyway;
        // relaunching in place just translocates again. A copy is the only way
        // out.
        Some(origin) => origin,
        None => match misplaced {
            Some(bundle) => bundle,
            None => return,
        },
    };

    // move_to_applications DELETES whatever is already at the destination, and
    // nothing here checks versions, so a user opening an old disk image while a
    // newer build is installed would silently lose it and be downgraded. Ask
    // whenever there is an install to lose. Staying silent is only right for
    // the case this guard was written for: a first install off the disk image,
    // where macOS has already made this launch useless for updates and
    // /Applications holds nothing.
    let replacing = destination_for(&bundle).is_some_and(|dest| dest.exists());
    if (!was_translocated || replacing) && !confirm_move(&bundle, replacing) {
        return;
    }

    info!("install guard: copying into Applications from {}", describe(&bundle));
    match move_to_applications(&bundle) {
        Ok(dest) => relaunch_and_exit(&dest),
        Err(e) => {
            error!("install guard: move failed: {e}");
            sentry::capture_message(
                &format!("install guard: move failed: {e}"),
                sentry::Level::Warning,
            );
            let Some(mtm) = MainThreadMarker::new() else {
                warn!("install guard: not on the main thread, skipping");
                return;
            };
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

/// Asks whether to move a bundle that is misplaced but running normally, so
/// nothing about its situation is obvious to the user yet. Returns whether they
/// accepted.
fn confirm_move(bundle: &Path, replacing: bool) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        warn!("install guard: not on the main thread, skipping");
        return false;
    };
    let location = describe(bundle);
    info!("install guard: running from {location}, replacing={replacing}");

    let (message, detail, primary) = if replacing {
        (
            "Replace the copy in your Applications folder?",
            format!(
                "Aura is running from {location}, and there is already a copy in your \
                 Applications folder. Replacing it puts this version in its place, which \
                 may be older."
            ),
            "Replace",
        )
    } else {
        (
            "Move Aura Desktop to the Applications folder?",
            format!(
                "Aura is running from {location}. It can only keep itself up to date from \
                 the Applications folder. Move it there now and relaunch?"
            ),
            "Move to Applications",
        )
    };
    let accepted = ask(mtm, message, &detail, primary, Some("Not Now"));
    if !accepted {
        info!("install guard: user declined the move");
    }
    accepted
}

/// For an origin that is ALREADY installed, where there is nothing to copy: the
/// bundle at `origin` is the very thing macOS mounted read-only over. Copying
/// onto it would set a live mount source aside and then fail, which is how this
/// guard used to die with "ditto exited with 1". Drop the attribute that armed
/// the translocation and come back from the real path instead. Silent on the
/// way through, because it takes under a second and the user asked for none of
/// it; the alert is only for the case that cannot be repaired without them.
///
/// Only ever called for an installed origin. A bundle still on the disk image
/// has no attribute to drop, because there the quarantine is on the mount, so
/// this would relaunch it in place unchanged and be handed the same read-only
/// mirror on the way back round. The caller makes that distinction.
fn repair_translocated(origin: &Path) {
    info!("install guard: running translocated, clearing quarantine on the real bundle");
    if clear_quarantine(origin) {
        relaunch_and_exit(origin);
    }
    error!("install guard: the bundle is still quarantined, translocation will repeat");
    sentry::capture_message(
        "install guard: could not clear quarantine on a translocated bundle",
        sentry::Level::Warning,
    );
    let Some(mtm) = MainThreadMarker::new() else {
        warn!("install guard: not on the main thread, skipping");
        return;
    };
    ask(
        mtm,
        "Aura cannot update itself from here",
        "Drag Aura Desktop into your Applications folder, then open it from there.",
        "OK",
        None,
    );
}

/// The real path behind a translocated launch, or None when this launch is not
/// translocated. macOS runs a still-quarantined app from a read-only nullfs
/// mirror of itself, so current_exe lands under /private/var/folders and the
/// updater's in-place bundle swap can only ever fail with EROFS.
fn translocation_origin() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // <name>.app/Contents/MacOS/<executable>
    let bundle = exe.parent()?.parent()?.parent()?;
    if bundle.extension()?.to_str()? != "app" {
        return None;
    }
    let url = CFURL::from_path(bundle, true)?;
    let mut translocated = false;
    let mut error: CFErrorRef = std::ptr::null_mut();
    unsafe {
        let ok = SecTranslocateIsTranslocatedURL(
            url.as_concrete_TypeRef(),
            &mut translocated,
            &mut error,
        );
        if !error.is_null() {
            let _ = CFError::wrap_under_create_rule(error);
            error = std::ptr::null_mut();
        }
        if ok == 0 || !translocated {
            return None;
        }
        let origin = SecTranslocateCreateOriginalPathForURL(url.as_concrete_TypeRef(), &mut error);
        if !error.is_null() {
            let _ = CFError::wrap_under_create_rule(error);
        }
        if origin.is_null() {
            warn!("install guard: translocated but the original path is unavailable");
            return None;
        }
        CFURL::wrap_under_create_rule(origin).to_path()
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
    if is_installed(bundle) {
        None
    } else {
        Some(bundle.to_path_buf())
    }
}

/// Whether a bundle sits somewhere the updater can write its replacement, which
/// means /Applications or ~/Applications and nowhere else. Asked of the running
/// bundle to decide whether the guard has anything to do, and of a translocation
/// origin to tell an installed app that kept its quarantine attribute from one
/// still sitting on the disk image.
fn is_installed(bundle: &Path) -> bool {
    let Some(path) = bundle.to_str() else {
        return false;
    };
    let home_apps = std::env::var("HOME").ok().map(|home| format!("{home}/Applications/"));
    path.starts_with(&format!("{APPLICATIONS}/"))
        || home_apps.as_deref().is_some_and(|dir| path.starts_with(dir))
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
/// volumes; ditto also preserves the code signature. It preserves
/// com.apple.quarantine too, which is the one attribute that must NOT survive
/// the move, so the copy is de-quarantined before it is handed back.
fn move_to_applications(bundle: &Path) -> Result<PathBuf, String> {
    let name = bundle
        .file_name()
        .ok_or_else(|| "bundle has no name".to_string())?;
    let dest = destination_for(bundle).ok_or_else(|| "bundle has no name".to_string())?;
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
    if !clear_quarantine(&dest) {
        warn!("install guard: the copy is still quarantined and will be translocated again");
    }

    if had_previous {
        if let Err(e) = std::fs::remove_dir_all(&aside) {
            warn!("install guard: could not remove the previous copy: {e}");
        }
    }
    Ok(dest)
}

/// Where `move_to_applications` would put this bundle. Shared with the caller
/// so the question "is an existing install about to be replaced" is asked of
/// the very path that would be overwritten, rather than of one built the same
/// way and free to drift from it.
fn destination_for(bundle: &Path) -> Option<PathBuf> {
    Some(Path::new(APPLICATIONS).join(bundle.file_name()?))
}

/// Finder clears an app's translocation eligibility when the user drags it in.
/// ditto does not: it copies com.apple.quarantine across with everything else,
/// and a bundle that keeps that attribute is mounted read-only through
/// AppTranslocation on its next launch, which is the exact state this guard
/// exists to get out of. Returns whether the bundle ended up quarantine-free.
///
/// Quarantine-free is NOT the same question as "will not be translocated". A
/// bundle on a mounted disk image carries no attribute of its own, because the
/// volume is what is flagged, so this returns true for it having removed
/// nothing. Only ask it about a path the caller can write to.
fn clear_quarantine(bundle: &Path) -> bool {
    // -r because the attribute sits on the nested files as well as the bundle
    // root, and a non-zero exit here only means there was nothing to remove.
    if let Err(e) = xattr(&["-d", "-r", QUARANTINE], bundle) {
        warn!("install guard: could not run xattr: {e}");
    }
    !matches!(xattr(&["-p", QUARANTINE], bundle), Ok(true))
}

/// Runs xattr quietly and reports whether it exited zero, which for `-p` is the
/// same question as "does the bundle still carry this attribute".
fn xattr(args: &[&str], bundle: &Path) -> Result<bool, std::io::Error> {
    Command::new("/usr/bin/xattr")
        .args(args)
        .arg(bundle)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
}

/// Opens the installed copy from a detached shell after a short delay and
/// exits. The delay matters twice over: the single-instance plugin would
/// otherwise hand the new launch to this still-running process, which is about
/// to die, and a translocation mount is only torn down once the last process
/// using it has gone, so opening too early can be handed the read-only mirror
/// again.
fn relaunch_and_exit(dest: &Path) -> ! {
    stamp_relaunch();
    let script = format!("sleep 2; /usr/bin/open \"{}\"", dest.display());
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

/// The stamp that says a guard relaunch is in flight. Lives with the app's
/// other state rather than in the bundle, which is read-only in exactly the
/// cases this matters. Spelled out for the same reason `crypto`'s copy is:
/// there is no `AppHandle` this early to ask for `app_local_data_dir()`.
fn relaunch_stamp() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("com.aura.desktop")
            .join(".install-guard-relaunch"),
    )
}

/// Records that the guard is about to relaunch. Best effort: a stamp that
/// cannot be written costs the loop protection, not the relaunch.
fn stamp_relaunch() {
    let Some(path) = relaunch_stamp() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, b"") {
        warn!("install guard: could not stamp the relaunch: {e}");
    }
}

/// Whether the guard relaunched us within the last minute. A second guard pass
/// that soon means the relaunch did not fix anything, and going round again is
/// how this turns into an app that never opens at all. No cleanup: the stamp is
/// only ever read inside this window and is overwritten on each relaunch, so it
/// goes stale on its own.
fn relaunched_recently() -> bool {
    let Some(path) = relaunch_stamp() else {
        return false;
    };
    std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < RELAUNCH_WINDOW)
}

/// Reports a relaunch that came straight back and stops. Returning rather than
/// exiting is the point: the app still opens and is fully usable, it just
/// cannot update itself until it is dragged into /Applications by hand.
fn loop_broken() {
    error!("install guard: the relaunch came back unfixed, not relaunching again");
    sentry::capture_message(
        "install guard: relaunch loop broken, the app is still not installed",
        sentry::Level::Warning,
    );
    let Some(mtm) = MainThreadMarker::new() else {
        warn!("install guard: not on the main thread, skipping");
        return;
    };
    ask(
        mtm,
        "Aura cannot update itself from here",
        "Drag Aura Desktop into your Applications folder, then open it from there.",
        "OK",
        None,
    );
}

/// A modal alert with one or two buttons. Returns true when the first button
/// was chosen. Activates the app first: this runs before any window exists, so
/// the app is not frontmost and the alert would otherwise open behind whatever
/// the user is looking at. Still needed now the policy is Regular, because a
/// Dock icon does not make an app active.
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
