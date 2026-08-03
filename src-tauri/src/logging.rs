use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

/// File + stdout logging so every `log::error!`/`log::warn!` call (and every
/// frontend catch block via `@tauri-apps/plugin-log`) lands somewhere durable
/// under the app's data directory, not just the dev console.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: None }),
        ])
        .level(log::LevelFilter::Info)
        // Bound the on-disk log: previously it grew unbounded across sessions.
        // Rotate at ~5 MB and keep only the one prior file, so the durable log is
        // capped at ~10 MB while still holding plenty of recent sessions.
        .max_file_size(5_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
        .build()
}

/// Rust panics are otherwise silent in a windowed (non-console) release
/// build; route them into the same durable log.
///
/// Chains whatever hook is already installed rather than replacing it wholesale
/// with `std::panic::set_hook` outright: if `sentry_setup::init()` already ran
/// (it does, at the very top of `run()`, before this is called from `.setup()`),
/// the previous hook is Sentry's own, and `std::panic::set_hook` alone would
/// silently discard it - the same class of bug as two things stepping on each
/// other's state, just via a global hook instead of a mutex this time. Taking
/// and calling through to whatever was there first means both this log line
/// and Sentry's own capture happen for every panic, regardless of whether
/// Sentry ended up initialized or not.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if panicking_thread_handles_speech() {
            // PanicHookInfo's Display embeds the panic payload, and on these
            // threads that payload can carry transcript text. This log file is
            // plaintext (redact.rs runs on the READ path only, and its
            // key=value/JWT rules would never match prose), so the panic is
            // recorded without it. Sentry still receives the full event through
            // the chained hook below, where sentry_setup's before_send drops
            // anything originating in the dictation module.
            log::error!("panic: on a dictation thread, details withheld");
        } else {
            log::error!("panic: {info}");
        }
        previous(info);
    }));
}

/// True when the currently panicking thread is one that holds decoded speech in
/// memory. Matched by thread name because a panic hook has no other handle on
/// where it came from.
fn panicking_thread_handles_speech() -> bool {
    matches!(
        std::thread::current().name(),
        // "aura-dictation-decode" owns the recognizer, the stream and every
        // decoded string in the process, so it is the MOST important name here,
        // not an afterthought: a panic raised there is the one most likely to
        // carry a transcript in its payload. "aura-dictation-trace" holds the
        // same class of content - raw transcripts, inserted text, and the
        // user's corrections - for as long as a field is being watched, so its
        // panic payload is exactly as sensitive.
        Some("aura-dictation")
            | Some("aura-dictation-model")
            | Some("aura-dictation-decode")
            | Some("aura-dictation-trace")
    )
}

/// Hard ceiling on how many lines a single read may return, regardless of
/// what the caller asked for - the log is a diagnostic tail for the feedback
/// email, never a bulk-export channel.
const MAX_LOG_LINES: usize = 200;
/// Byte budget for the tail read: the file is never loaded whole (it grows
/// unbounded across sessions), only this much is ever seeked into memory.
const MAX_LOG_BYTES: u64 = 64 * 1024;

/// Reads the last `count` lines of the durable app log for the in-app
/// feedback button - async per this repo's main-thread-blocking rule.
///
/// Hardened: requires a signed-in session (security.rs ReadLogs - redaction
/// lowers the tail's exposure but does not make it public-safe, and the
/// feedback button that calls this only renders signed-in), the requested
/// count is clamped to `MAX_LOG_LINES`, at most `MAX_LOG_BYTES` are read
/// (seek-from-end, whole file never in memory), and every line is redacted
/// in Rust (redact.rs) BEFORE it crosses IPC into JavaScript - the
/// frontend's own redactSecrets pass in feedback.ts is a second layer, not
/// the boundary.
#[tauri::command]
pub async fn read_recent_log_lines(
    app: tauri::AppHandle,
    count: usize,
) -> Result<Vec<String>, String> {
    let ticket = crate::security::authorize(&app, crate::security::Operation::ReadLogs)?;
    let blocking_app = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || read_redacted_log_tail(&blocking_app, count))
            .await
            .map_err(|e| e.to_string())?;
    // Same rule as read_segment: the tail is the sensitive return value, so
    // a sign-out that landed during the file read drops it.
    crate::security::recheck(&app, crate::security::Operation::ReadLogs, &ticket)?;
    result
}

/// Shared by the signed-in feedback command and the explicit meeting incident
/// bundle export. Callers must perform their own authorization before invoking
/// this blocking helper.
pub(crate) fn read_redacted_log_tail(
    app: &tauri::AppHandle,
    count: usize,
) -> Result<Vec<String>, String> {
    // Matches tauri-plugin-log's own LogDir{file_name: None} naming:
    // <app_log_dir>/<product name>.log.
    let file_name = format!("{}.log", app.package_info().name);
    let path = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?
        .join(file_name);
    let bytes = read_tail_bytes(&path, MAX_LOG_BYTES)?;
    Ok(tail_lines(&bytes, count.min(MAX_LOG_LINES))
        .into_iter()
        .map(|line| crate::redact::redact_line(&line))
        .collect())
}

/// At most `budget` bytes from the end of the file. When the read starts
/// mid-file, everything up to the first newline is discarded so no partial
/// line ever leaks into the output.
fn read_tail_bytes(path: &Path, budget: u64) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(budget);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if start > 0 {
        if let Some(newline) = buf.iter().position(|&b| b == b'\n') {
            buf.drain(..=newline);
        } else {
            buf.clear();
        }
    }
    Ok(buf)
}

/// Pure tail over a byte buffer (lossy UTF-8), factored out of the command so
/// the clamping behavior is unit-testable without an AppHandle or a real file.
fn tail_lines(bytes: &[u8], count: usize) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(count);
    lines[start..].iter().map(|line| line.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::{tail_lines, MAX_LOG_LINES};

    fn log_of(n: usize) -> Vec<u8> {
        (0..n)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes()
    }

    #[test]
    fn returns_the_last_count_lines() {
        let lines = tail_lines(&log_of(10), 3);
        assert_eq!(lines, vec!["line 7", "line 8", "line 9"]);
    }

    #[test]
    fn short_files_return_everything() {
        assert_eq!(tail_lines(&log_of(2), 40).len(), 2);
        assert!(tail_lines(&[], 40).is_empty());
    }

    #[test]
    fn an_oversized_request_is_clamped() {
        // The command clamps with count.min(MAX_LOG_LINES); pin the ceiling
        // itself so a future edit can't silently unbound it.
        assert!(MAX_LOG_LINES <= 200);
        let clamped = usize::MAX.min(MAX_LOG_LINES);
        assert_eq!(tail_lines(&log_of(500), clamped).len(), MAX_LOG_LINES);
    }

    #[test]
    fn invalid_utf8_never_panics() {
        let mut bytes = log_of(3);
        bytes.extend_from_slice(&[0xff, 0xfe, b'\n', b'o', b'k']);
        let lines = tail_lines(&bytes, 10);
        assert_eq!(lines.last().map(String::as_str), Some("ok"));
    }
}
