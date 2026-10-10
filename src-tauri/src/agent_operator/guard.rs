//! The gates a window cannot talk to (future-features.txt, "OPERATOR HANDS +
//! DYNAMIC STEPPING", section 3). The prompt asks the model to avoid these;
//! this file is what stops them, in code, before anything reaches another
//! application. Mirrors `agent_browser/guard.rs`:
//!
//! - A click, a type or a scroll may only target a ref from the LAST snapshot.
//! - Clicking, or pressing Enter into, anything that reads as send / buy /
//!   delete / sign out pauses for the user's explicit yes. No answer means no.
//! - A password field is never typed into.
//! - Some apps are never acted in at all: Windows sign-in and elevation
//!   prompts, Windows Security, password managers.
//! - Typing into a terminal runs commands, so it always asks first, the same
//!   rule as the Operator design's `shell.run`.
//! - `launch_app` opens only an exact entry of the installed-app catalog,
//!   never a path, a URI or a command line.
//! - `run_command` runs on its own only when PowerShell's parser shows nothing
//!   but read-only cmdlets (`shell.rs` builds that report): no redirection, no
//!   method that changes anything, no computed command, no assignment outside
//!   a plain variable, and no path that holds a secret or crosses the network.
//!   Everything else shows the exact command and waits for a yes. A command
//!   that does not parse never runs.
//! - `fetch_url` asks once per website per task, which is what keeps a page
//!   from steering the task into sending what it read somewhere new.
//!
//! The decision reads roles, names and executable stems, which the apps
//! control, but the outcome of a match is a pause or a refusal, never an
//! action.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::app_catalog::AppEntry;
use crate::native_ui::{RefInfo, WindowEntry};

use super::shell::{CommandScan, MAX_COMMAND_CHARS};

/// One action as the backend returned it, already shape-checked there.
#[derive(Clone, Debug, Default)]
pub struct Action {
    pub kind: String,
    pub why: String,
    pub command: String,
    pub query: String,
    pub url: String,
    pub ref_id: String,
    pub text: String,
    pub submit: bool,
    pub direction: String,
    pub app: String,
    pub window: String,
    pub keys: String,
    pub ms: u64,
    pub answer: String,
    pub reason: String,
    pub detail: String,
}

pub const MAX_TEXT_CHARS: usize = 2000;

pub enum Gate {
    Allow,
    NeedsApproval { description: String },
    Refuse(&'static str),
}

/// What the guard knows about the moment: the last snapshot's refs, the
/// window list the model was shown, the window being worked in, and the
/// installed-app catalog.
pub struct Context<'a> {
    pub refs: &'a HashMap<String, RefInfo>,
    pub windows: &'a HashMap<String, WindowEntry>,
    pub target_app: &'a str,
    pub target_title: &'a str,
    pub catalog: &'a [AppEntry],
    /// What the parser found in `action.command`, for `run_command` only.
    /// `Err` when the scan itself failed, which refuses the command.
    pub command_scan: Option<&'a Result<CommandScan, String>>,
    /// Websites the user already allowed in this task.
    pub allowed_hosts: &'a HashSet<String>,
}

/// Never acted in: the OS's own security surfaces and password managers.
const BLOCKED_APPS: &[&str] = &[
    "consent", "credentialuibroker", "logonui", "lockapp", "sechealthui",
    "securityhealthhost", "useraccountcontrolsettings", "keepass", "keepassxc", "1password",
    "bitwarden", "lastpass", "dashlane", "proton pass", "enpass",
];
/// Typing here runs commands, so every keystroke asks first.
const TERMINAL_APPS: &[&str] = &[
    "cmd", "powershell", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "bash",
    "wsl", "mintty", "alacritty", "wezterm-gui", "putty", "regedit", "mmc",
];
/// App names in the catalog that open one of the above, or install software.
const ASK_BEFORE_LAUNCH: &[&str] = &[
    "terminal", "powershell", "command prompt", "registry editor", "installer", "setup",
    "uninstall", "windows security",
];
/// Chords that close, quit or delete. Lower-case, as written by the model.
const ASK_CHORDS: &[&str] = &[
    "alt+f4", "ctrl+w", "ctrl+q", "ctrl+shift+w", "delete", "del", "shift+delete", "shift+del",
    "ctrl+enter", "ctrl+return", "alt+s",
];

/// Read-only cmdlets and their stock aliases. Nothing here can write a file,
/// change a setting, start a process or reach the network on its own.
const READ_ONLY_COMMANDS: &[&str] = &[
    "get-childitem", "gci", "ls", "dir", "get-content", "gc", "cat", "type", "get-item", "gi",
    "get-itemproperty", "gp", "get-itempropertyvalue", "gpv", "test-path", "resolve-path", "rvpa",
    "join-path", "split-path", "get-location", "gl", "pwd", "select-string", "sls",
    "select-object", "select", "where-object", "where", "?", "foreach-object", "foreach", "%",
    "sort-object", "sort", "measure-object", "measure", "group-object", "group", "format-list",
    "fl", "format-table", "ft", "format-wide", "fw", "out-string", "convertfrom-json",
    "convertto-json", "convertfrom-csv", "import-csv", "get-date", "get-process", "gps", "ps",
    "get-service", "gsv", "get-command", "gcm", "get-startapps", "get-appxpackage",
    "get-winevent", "get-ciminstance", "get-filehash", "get-member", "gm", "write-output",
    "echo", "get-unique", "compare-object", "get-help",
];
/// Methods that only compute a value from what they are called on.
const READ_ONLY_METHODS: &[&str] = &[
    "tostring", "trim", "trimstart", "trimend", "split", "replace", "substring", "tolower",
    "toupper", "tolowerinvariant", "toupperinvariant", "contains", "startswith", "endswith",
    "indexof", "lastindexof", "padleft", "padright", "equals", "compareto", "gettype",
    "static:join", "static:getfolderpath", "static:combine", "static:getfilename",
    "static:getextension", "static:getdirectoryname", "static:getfilenamewithoutextension",
];

/// Paths and drives a read-only command still asks about: credentials, browser
/// profiles, Aura's own keys, environment variables, and UNC paths (which
/// reach another machine and hand it the user's Windows sign-in).
fn sensitive_path() -> &'static Regex {
    static SENSITIVE: OnceLock<Regex> = OnceLock::new();
    SENSITIVE.get_or_init(|| {
        Regex::new(
            r#"(?i)\.ssh\b|\.aws\b|\.azure\b|\.gnupg\b|\.kube\b|\.docker\b|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.env\b|\.kdbx|\.pem\b|\.pfx\b|\.p12\b|id_rsa|id_ed25519|login data|cookies|local state|web data|credentials|microsoft.protect|com\.aura\.desktop|key\.bin|master\.salt|\benv:|\bcert:|^\s*\\\\|[\s'"(=,]\\\\[a-z0-9]"#,
        )
        .expect("sensitive-path regex")
    })
}

/// Why a scanned command cannot run without asking, or None when it can.
fn command_needs_approval(command: &str, scan: &CommandScan) -> Option<&'static str> {
    if scan.dynamic || scan.redirect || scan.member || scan.assign {
        return Some("changes");
    }
    if scan.names.iter().any(|name| !READ_ONLY_COMMANDS.contains(&name.as_str())) {
        return Some("changes");
    }
    if scan.methods.iter().any(|method| !READ_ONLY_METHODS.contains(&method.as_str())) {
        return Some("changes");
    }
    if sensitive_path().is_match(command) {
        return Some("sensitive");
    }
    None
}

fn risky() -> &'static Regex {
    static RISKY: OnceLock<Regex> = OnceLock::new();
    RISKY.get_or_init(|| {
        Regex::new(
            r"(?i)\b(submit|buy|pay|order|checkout|subscribe|unsubscribe|sign ?up|sign ?out|log ?out|register|apply|send|post|publish|share|book|reserve|place order|purchase|confirm|donate|add to cart|delete|remove|uninstall|discard|erase|reset|format|empty|deactivate|close account|transfer|merge|deploy|permanently|move to trash)\b",
        )
        .expect("risky-target regex")
    })
}

fn is_blocked(app: &str, title: &str) -> bool {
    let app = app.to_ascii_lowercase();
    if BLOCKED_APPS.iter().any(|blocked| app == *blocked) {
        return true;
    }
    // Settings itself is a fair target ("turn on dark mode"); its privacy and
    // security pages are where an app's permissions are granted.
    app == "systemsettings" && {
        let title = title.to_ascii_lowercase();
        title.contains("privacy") || title.contains("security")
    }
}

fn is_terminal(app: &str) -> bool {
    let app = app.to_ascii_lowercase();
    TERMINAL_APPS.iter().any(|terminal| app == *terminal)
}

fn describe(info: &RefInfo) -> String {
    if info.name.is_empty() {
        info.role.clone()
    } else {
        format!("{} \"{}\"", info.role, info.name)
    }
}

/// The catalog entry `launch_app` named, matched exactly, ignoring case.
pub fn catalog_match<'a>(catalog: &'a [AppEntry], name: &str) -> Option<&'a AppEntry> {
    let wanted = name.trim().to_lowercase();
    catalog.iter().find(|entry| entry.name.to_lowercase() == wanted)
}

pub fn check(action: &Action, context: &Context<'_>) -> Gate {
    let acts_in_target = matches!(action.kind.as_str(), "click" | "type" | "key" | "scroll");
    if acts_in_target {
        if context.target_app.is_empty() {
            return Gate::Refuse("no_window");
        }
        if is_blocked(context.target_app, context.target_title) {
            return Gate::Refuse("blocked_app");
        }
    }
    match action.kind.as_str() {
        "click" | "type" => {
            let Some(target) = context.refs.get(&action.ref_id) else {
                return Gate::Refuse("ref_not_found");
            };
            if action.kind == "type" {
                if action.text.chars().count() > MAX_TEXT_CHARS {
                    return Gate::Refuse("text_too_long");
                }
                if target.password {
                    return Gate::Refuse("password_field");
                }
                if is_terminal(context.target_app) {
                    return Gate::NeedsApproval {
                        description: format!(
                            "Allow typing into {}? Whatever is typed there runs as a command.",
                            context.target_app
                        ),
                    };
                }
            }
            // Typing without Enter cannot commit anything; a click or an
            // Enter can.
            let commits = action.kind == "click" || action.submit;
            if commits && risky().is_match(&format!("{} {}", target.role, target.name)) {
                return Gate::NeedsApproval {
                    description: format!(
                        "Allow {} {} in {}?",
                        if action.kind == "click" { "clicking" } else { "submitting" },
                        describe(target),
                        context.target_app
                    ),
                };
            }
            Gate::Allow
        }
        "key" => {
            let chord = action.keys.trim().to_ascii_lowercase().replace(' ', "");
            if crate::native_ui::parse_chord(&chord).is_err() {
                return Gate::Refuse("unknown_key");
            }
            if is_terminal(context.target_app) || ASK_CHORDS.contains(&chord.as_str()) {
                return Gate::NeedsApproval {
                    description: format!("Allow pressing {} in {}?", action.keys.trim(), context.target_app),
                };
            }
            Gate::Allow
        }
        "scroll" => {
            if !action.ref_id.is_empty() && !context.refs.contains_key(&action.ref_id) {
                return Gate::Refuse("ref_not_found");
            }
            Gate::Allow
        }
        "launch_app" => {
            let Some(entry) = catalog_match(context.catalog, &action.app) else {
                return Gate::Refuse("app_not_found");
            };
            let lower = entry.name.to_lowercase();
            if BLOCKED_APPS.iter().any(|blocked| lower.contains(blocked)) {
                return Gate::Refuse("blocked_app");
            }
            if ASK_BEFORE_LAUNCH.iter().any(|needle| lower.contains(needle)) {
                return Gate::NeedsApproval { description: format!("Allow opening {}?", entry.name) };
            }
            Gate::Allow
        }
        "focus_window" => {
            let Some(window) = context.windows.get(&action.window) else {
                return Gate::Refuse("window_not_found");
            };
            if is_blocked(&window.app, &window.title) {
                return Gate::Refuse("blocked_app");
            }
            Gate::Allow
        }
        "run_command" => {
            let command = action.command.trim();
            if command.is_empty() {
                return Gate::Refuse("missing_command");
            }
            if command.chars().count() > MAX_COMMAND_CHARS {
                return Gate::Refuse("command_too_long");
            }
            let scan = match context.command_scan {
                Some(Ok(scan)) if !scan.error => scan,
                Some(Ok(_)) => return Gate::Refuse("command_unparsed"),
                _ => return Gate::Refuse("command_unchecked"),
            };
            match command_needs_approval(command, scan) {
                None => Gate::Allow,
                Some(why) => Gate::NeedsApproval {
                    description: format!(
                        "{}\n{}",
                        if why == "sensitive" {
                            "Allow Aura to read this? It touches something private."
                        } else {
                            "Allow Aura to run this command?"
                        },
                        command.chars().take(600).collect::<String>()
                    ),
                },
            }
        }
        "fetch_url" => match super::web::host_of(&action.url) {
            Err(code) => Gate::Refuse(code),
            Ok(host) if context.allowed_hosts.contains(&host) => Gate::Allow,
            Ok(host) => Gate::NeedsApproval { description: format!("Let Aura read {host} for this task?") },
        },
        "web_search" => {
            if action.query.trim().is_empty() {
                return Gate::Refuse("missing_query");
            }
            Gate::Allow
        }
        "look" | "read_more" | "wait" | "done" | "blocked" => Gate::Allow,
        _ => Gate::Refuse("unknown_action"),
    }
}
