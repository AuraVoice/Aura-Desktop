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
        log::error!("panic: {info}");
        previous(info);
    }));
}
