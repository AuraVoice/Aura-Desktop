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
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        log::error!("panic: {info}");
    }));
}
