//! The installed-app catalog: what can be launched by name on this machine.
//!
//! Moved verbatim out of `dictation/command_brain.rs` on 2026-10-09, when the
//! desktop Operator (`agent_operator/`) became its second caller. The bodies
//! are unchanged; only their visibility and the module they live in moved.

/// Jev choices cap at 255 options, so this is the ceiling the list is cut to.
/// Beware what the cut MEANS: `enumerate_apps` collects into a `BTreeMap` keyed
/// by lowercase name, so truncating is ALPHABETICAL and silently drops the tail
/// (a machine over the cap loses "Spotify", "Teams", "VS Code" while keeping
/// every "Adobe ..."). What keeps a normal machine clear of the cap is the
/// filtering, not the number: measured on a working Windows 11 install, 189
/// AppsFolder entries plus 111 shortcuts come to 180 after the non-app and
/// noise filters. If this ever does start biting, the fix is a ranking signal,
/// not a bigger number.
pub const MAX_APPS: usize = 250;

#[derive(Clone)]
pub struct AppEntry {
    /// What Jev chooses between and what the caption shows.
    pub name: String,
    /// What the platform launcher is handed: the .lnk path on Windows, the
    /// application name on macOS.
    pub launch: String,
}

#[cfg(windows)]
mod backend {
    use std::path::{Path, PathBuf};

    use super::{AppEntry, MAX_APPS};

    /// Where a launchable app can be found on Windows: the Start Menu shortcut
    /// tree, plus the virtual AppsFolder. Both are needed. A Store (MSIX/AppX)
    /// app has no .lnk anywhere on disk, so the shortcut walk alone cannot see
    /// one at all, which is exactly how "open spotify" used to reach Jev with
    /// no Spotify anywhere in its choice list and fall through to typing.
    pub fn enumerate_apps() -> Vec<AppEntry> {
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Ok(program_data) = std::env::var("ProgramData") {
            roots.push(Path::new(&program_data).join("Microsoft\\Windows\\Start Menu\\Programs"));
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            roots.push(Path::new(&app_data).join("Microsoft\\Windows\\Start Menu\\Programs"));
        }
        let mut seen = std::collections::BTreeMap::new();
        for root in roots {
            collect_shortcuts(&root, 0, &mut seen);
        }
        // Second, so a .lnk wins a name tie: its target is a real path, which
        // the shell resolves without going through an AppUserModelID.
        collect_apps_folder(&mut seen);
        seen.into_values().take(MAX_APPS).collect()
    }

    /// Entries nobody asks for by name. Shape only, never meaning: dropping
    /// these is what keeps a normal machine under `MAX_APPS`, whose cut is
    /// alphabetical and therefore not something to rely on.
    fn is_noise(lower: &str) -> bool {
        const NOISE: [&str; 5] = [
            "uninstall",
            "readme",
            "release notes",
            "documentation",
            "website",
        ];
        NOISE.iter().any(|needle| lower.contains(needle))
    }

    fn collect_shortcuts(
        dir: &Path,
        depth: usize,
        out: &mut std::collections::BTreeMap<String, AppEntry>,
    ) {
        if depth > 3 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_shortcuts(&path, depth + 1, out);
                continue;
            }
            let is_shortcut = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("lnk"));
            if !is_shortcut {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let lower = name.to_lowercase();
            // Shape filter only: installer leftovers are not launch targets.
            if is_noise(&lower) {
                continue;
            }
            out.entry(lower).or_insert_with(|| AppEntry {
                name: name.to_string(),
                launch: path.to_string_lossy().into_owned(),
            });
        }
    }

    /// Everything under here is an AppUserModelID, not a path.
    const APPS_FOLDER_PREFIX: &str = "shell:AppsFolder\\";

    /// The Store half of the list. AppsFolder is virtual, so it is read through
    /// the shell's item enumerator rather than the file system: a child's
    /// display name is what a person calls the app, and its parsing name is
    /// `shell:AppsFolder\<AppUserModelID>`, which is what `launch` hands to
    /// explorer.exe.
    fn collect_apps_folder(out: &mut std::collections::BTreeMap<String, AppEntry>) {
        use windows::core::HSTRING;
        use windows::Win32::System::Com::{
            CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::{
            IEnumShellItems, IShellItem, SHCreateItemFromParsingName, BHID_EnumItems,
            SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
        };

        // SAFETY: the calling thread may already own an apartment, in which
        // case this returns an error and we simply reuse it. CoUninitialize
        // runs only when this call is the one that initialized.
        let owned = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();

        unsafe {
            let folder: windows::core::Result<IShellItem> =
                SHCreateItemFromParsingName(&HSTRING::from("shell:AppsFolder"), None);
            if let Ok(folder) = folder {
                let items: windows::core::Result<IEnumShellItems> =
                    folder.BindToHandler(None::<&IBindCtx>, &BHID_EnumItems);
                if let Ok(items) = items {
                    // Bounded: a virtual folder that never reports exhaustion
                    // must not spin the dictation worker.
                    for _ in 0..2_000 {
                        let mut batch: [Option<IShellItem>; 1] = [None];
                        let mut fetched = 0u32;
                        if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                            break;
                        }
                        let Some(item) = batch[0].take() else {
                            break;
                        };
                        // Both strings are shell-allocated, so each is freed on
                        // every path out, including the one where the second
                        // call is the one that failed.
                        let Ok(display) = item.GetDisplayName(SIGDN_NORMALDISPLAY) else {
                            continue;
                        };
                        let Ok(parsing) = item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING) else {
                            CoTaskMemFree(Some(display.0 as *const _));
                            continue;
                        };
                        let name = display.to_string().unwrap_or_default();
                        let aumid = parsing.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(display.0 as *const _));
                        CoTaskMemFree(Some(parsing.0 as *const _));

                        // A child of AppsFolder parses to its AppUserModelID,
                        // which never contains a path separator. The ones that
                        // do are the folder's non-app members (a .chm, a .msi,
                        // an example folder: 57 of the 189 entries on a normal
                        // machine) and launching those is not what anyone means
                        // by "open X".
                        if name.is_empty() || aumid.is_empty() || aumid.contains('\\') {
                            continue;
                        }
                        let lower = name.to_lowercase();
                        if is_noise(&lower) {
                            continue;
                        }
                        out.entry(lower).or_insert(AppEntry {
                            name,
                            launch: format!("{APPS_FOLDER_PREFIX}{aumid}"),
                        });
                    }
                }
            }
        }

        if owned {
            unsafe { CoUninitialize() };
        }
    }

    /// Launches a shortcut path, an AppsFolder AUMID, or a URI via the shell.
    /// The path and URI shapes are the same cmd-start as
    /// system_control::spawn_launch: App Paths tokens, .lnk files and URI
    /// protocols all resolve uniformly, and the argument is always a registry
    /// entry, an enumerated app or a URI this module built, never user input
    /// handed to a parser.
    pub fn launch(target: &str) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // `start` cannot resolve an AppUserModelID. explorer.exe is the
        // documented launcher for one, and it takes the whole shell: token.
        let mut command = if target.starts_with(APPS_FOLDER_PREFIX) {
            let mut c = std::process::Command::new("explorer.exe");
            c.arg(target);
            c
        } else {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "start", "", target]);
            c
        };
        command
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_child| ())
            .map_err(|e| format!("launch failed: {e}"))
    }
}

#[cfg(target_os = "macos")]
mod backend {
    use std::path::{Path, PathBuf};

    use super::{AppEntry, MAX_APPS};

    pub fn enumerate_apps() -> Vec<AppEntry> {
        let mut roots = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            roots.push(Path::new(&home).join("Applications"));
        }
        let mut seen = std::collections::BTreeMap::new();
        for root in roots {
            collect_bundles(&root, 0, &mut seen);
        }
        seen.into_values().take(MAX_APPS).collect()
    }

    fn collect_bundles(
        dir: &Path,
        depth: usize,
        out: &mut std::collections::BTreeMap<String, AppEntry>,
    ) {
        if depth > 1 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let is_bundle = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("app"));
            if !is_bundle {
                // One level of folders (Utilities and the like).
                collect_bundles(&path, depth + 1, out);
                continue;
            }
            let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            out.entry(name.to_lowercase()).or_insert_with(|| AppEntry {
                name: name.to_string(),
                launch: name.to_string(),
            });
        }
    }

    /// `open -a <name>`: Launch Services resolves the bundle, exactly what
    /// the jev-voice demo does. The name is always a registry entry.
    pub fn launch(target: &str) -> Result<(), String> {
        std::process::Command::new("open")
            .args(["-a", target])
            .spawn()
            .map(|_child| ())
            .map_err(|e| format!("launch failed: {e}"))
    }
}

pub use backend::{enumerate_apps, launch};
