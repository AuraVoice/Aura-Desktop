/// Public/client-safe ingestion key, not a secret to protect - a DSN is a
/// write-only endpoint identifier, same reasoning `analytics.ts` already
/// documents for its PostHog project token. Sentry's own onboarding snippets
/// embed the DSN directly in shipped source for exactly this reason.
const DSN: &str = "https://eac19fd147547b09aa774070f00b18f8@o4511685555519488.ingest.us.sentry.io/4511685630361600";

/// The returned guard must stay alive for the life of `run()` - it's held in
/// a local there for exactly that reason. Dropping it flushes and disables
/// the client. `sentry::init`'s default `ClientOptions` (default_integrations:
/// true) installs its own panic hook via the same take-previous-hook/chain
/// pattern `logging::install_panic_hook` uses for its own hook, so as long as
/// this runs first (it does - called at the very top of `run()`, before
/// `install_panic_hook` runs later inside `.setup()`), both the local log
/// line and the Sentry report happen for every panic, neither one clobbering
/// the other.
/// Dev builds init with no DSN, which is Sentry's own documented off switch:
/// the client, guard, and panic-hook wiring all behave identically, but every
/// event is dropped locally instead of sent. This keeps `tauri dev` crashes
/// (e.g. hotkey collisions with the installed build & local dev) out of the project so
/// its feed only ever shows real installs. `debug: true` in dev prints the
/// would-be events to the console, so the reporting path stays visible while
/// iterating on it.
pub fn init() -> sentry::ClientInitGuard {
    let dsn = if cfg!(debug_assertions) {
        None
    } else {
        Some(DSN.parse().expect("hardcoded Sentry DSN must parse"))
    };
    sentry::init(sentry::ClientOptions {
        dsn,
        release: sentry::release_name!(),
        debug: cfg!(debug_assertions),
        ..Default::default()
    })
}
