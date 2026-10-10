//! The Operator's `run_command`: one PowerShell command line, run the way a
//! coding agent runs one in a terminal, with its output fed back as the next
//! observation.
//!
//! Two calls into `powershell.exe` per command. The first never runs the
//! command: it hands the text to PowerShell's own parser and reports what the
//! syntax tree contains (every command name, redirections, method calls,
//! dynamic invocation, assignments to anything but a plain variable). The
//! guard decides from that report whether the command is read-only, so a
//! delete hidden in a script block, a subexpression or a string is seen the
//! same as one written plainly. A regex over the text could not do that. The
//! second call runs it, from the user's home folder, with no window, killed
//! with its whole tree after `RUN_TIMEOUT`.
//!
//! Both pass their text through an environment variable or `-EncodedCommand`,
//! never through the command line's own quoting.

use std::time::Duration;

use base64::Engine;
use serde::Deserialize;

pub const MAX_COMMAND_CHARS: usize = 2000;
/// Output past this is cut, with a line saying so.
pub const MAX_OUTPUT_CHARS: usize = 12_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(30);
const SCAN_TIMEOUT: Duration = Duration::from_secs(10);

/// What PowerShell's parser found in a command. Built by `SCAN_SCRIPT`.
#[derive(Debug, Default, Deserialize)]
pub struct CommandScan {
    /// The text did not parse. Never run.
    #[serde(default)]
    pub error: bool,
    /// Every command name, lower-cased, in source order.
    #[serde(default)]
    pub names: Vec<String>,
    /// `&`, `.`, or a command whose name is computed at run time.
    #[serde(default)]
    pub dynamic: bool,
    /// Any `>`, `>>` or stream redirection to a file.
    #[serde(default)]
    pub redirect: bool,
    /// `ForEach-Object` given a member name, which invokes that method.
    #[serde(default)]
    pub member: bool,
    /// Every method called, instance or static, lower-cased.
    #[serde(default)]
    pub methods: Vec<String>,
    /// An assignment to a property, an environment variable or a drive path.
    #[serde(default)]
    pub assign: bool,
}

/// Reads the command from `AURA_OP_SRC` and prints one JSON line. It walks the
/// whole tree (`FindAll(..., $true)` descends into script blocks and the
/// subexpressions inside strings), and runs nothing it finds.
const SCAN_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$src = $env:AURA_OP_SRC
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)
$out = [ordered]@{ error = ($errors.Count -gt 0); names = @(); dynamic = $false; redirect = $false; member = $false; methods = @(); assign = $false }
foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
  $name = $c.GetCommandName()
  if (-not $name -or $c.InvocationOperator -ne 'Unknown') { $out.dynamic = $true }
  if ($name) {
    $lower = $name.ToLowerInvariant()
    $out.names += $lower
    if ($lower -in @('foreach-object', '%', 'foreach')) {
      foreach ($e in ($c.CommandElements | Select-Object -Skip 1)) {
        if (-not ($e -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) -and -not ($e -is [System.Management.Automation.Language.CommandParameterAst])) { $out.member = $true }
      }
    }
  }
}
if ($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst] }, $true).Count -gt 0) { $out.redirect = $true }
foreach ($m in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) {
  $member = $m.Member.ToString().Trim("'", '"').ToLowerInvariant()
  if ($m.Static) { $member = 'static:' + $member }
  $out.methods += $member
}
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
  $left = $a.Left
  if ($left -is [System.Management.Automation.Language.ConvertExpressionAst]) { $left = $left.Child }
  if (-not ($left -is [System.Management.Automation.Language.VariableExpressionAst]) -or $left.VariablePath.DriveName) { $out.assign = $true }
}
[Console]::Out.Write(($out | ConvertTo-Json -Compress))
"#;

/// A script as `-EncodedCommand` takes it: UTF-16LE, then base64.
fn encode(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Asks PowerShell's parser what the command contains. Runs nothing.
pub fn scan(command: &str) -> Result<CommandScan, String> {
    let output = run_powershell(&encode(SCAN_SCRIPT), &[("AURA_OP_SRC", command)], SCAN_TIMEOUT)?;
    if output.timed_out {
        return Err("scan_timeout".to_string());
    }
    serde_json::from_str(output.text.trim()).map_err(|_| "scan_unreadable".to_string())
}

/// Runs the command and returns what it printed, stdout and stderr merged,
/// with its exit code and a note when it was cut or timed out.
pub fn run(command: &str) -> Result<String, String> {
    // UTF-8 out, no progress bars, and every stream merged, so an error the
    // command prints reaches the model as data it can act on.
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n& {{\n{command}\n}} *>&1 | Out-String -Width 220"
    );
    let output = run_powershell(&encode(&script), &[], RUN_TIMEOUT)?;
    let mut text = output.text;
    let total = text.chars().count();
    if total > MAX_OUTPUT_CHARS {
        text = text.chars().take(MAX_OUTPUT_CHARS).collect();
        text.push_str(&format!(
            "\n(clipped: {total} characters in all. Narrow it with Select-String, Select-Object -First or a more specific path.)"
        ));
    }
    if text.trim().is_empty() {
        text = "(no output)".to_string();
    }
    if output.timed_out {
        text.push_str(&format!("\n(stopped after {} seconds)", RUN_TIMEOUT.as_secs()));
    } else if let Some(code) = output.exit_code.filter(|code| *code != 0) {
        text.push_str(&format!("\n(exit code {code})"));
    }
    Ok(text)
}

struct RunOutput {
    text: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

#[cfg(windows)]
fn run_powershell(encoded: &str, env: &[(&str, &str)], timeout: Duration) -> Result<RunOutput, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded])
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|error| format!("spawn_failed: {error}"))?;
    let pid = child.id();
    // Drained on their own threads so a chatty command cannot fill a pipe and
    // block forever before the timeout is checked.
    let mut stdout = child.stdout.take().ok_or("no_stdout")?;
    let mut stderr = child.stderr.take().ok_or("no_stderr")?;
    let out_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                timed_out = true;
                // The whole tree: a command can start children of its own.
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(error) => return Err(format!("wait_failed: {error}")),
        }
    };
    let mut bytes = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if !err.is_empty() {
        bytes.push(b'\n');
        bytes.extend(err);
    }
    Ok(RunOutput { text: String::from_utf8_lossy(&bytes).into_owned(), exit_code, timed_out })
}

#[cfg(not(windows))]
fn run_powershell(_encoded: &str, _env: &[(&str, &str)], _timeout: Duration) -> Result<RunOutput, String> {
    Err("unsupported_platform".to_string())
}
