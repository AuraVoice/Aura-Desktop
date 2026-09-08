use std::sync::Arc;
use std::time::Duration;

/// Public/client-safe ingestion key, not a secret to protect - a DSN is a
/// write-only endpoint identifier, same reasoning `analytics.ts` already
/// documents for its PostHog project token. Sentry's own onboarding snippets
/// embed the DSN directly in shipped source for exactly this reason.
const DSN: &str = "https://eac19fd147547b09aa774070f00b18f8@o4511685555519488.ingest.us.sentry.io/4511685630361600";

/// Every report is bounded: a hung ingest endpoint can hold the transport
/// thread for this long and no longer. Shutdown waits at most two seconds
/// for the queue to drain before the process goes.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// The argument `sentry-rust-minidump` relaunches this binary with; its
/// presence is what makes a process the crash reporter.
const CRASH_REPORTER_ARG: &str = "--crash-reporter-server";

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
///
/// This also runs in the crash reporter child process (see telemetry.rs), so
/// the `before_send` below is what filters a native crash report too.
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
        transport: Some(Arc::new(TimedTransportFactory)),
        shutdown_timeout: SHUTDOWN_TIMEOUT,
        before_send: Some(std::sync::Arc::new(|event| {
            if drop_for_dictation_privacy(&event) {
                None
            } else {
                Some(event)
            }
        })),
        ..Default::default()
    })
}

/// The stock reqwest transport, with request deadlines. A builder failure
/// (no TLS backend, which cannot happen with the pinned features) falls back
/// to the default client rather than taking the reporter down with it.
struct TimedTransportFactory;

impl sentry::TransportFactory for TimedTransportFactory {
    fn create_transport_with_options(
        &self,
        options: sentry::TransportOptions,
    ) -> Arc<dyn sentry::Transport> {
        let client = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|e| {
                log::warn!("sentry: transport client without deadlines: {e}");
                reqwest::Client::new()
            });
        Arc::new(
            sentry::transports::ReqwestHttpTransportOptions::from(options)
                .with_client(client)
                .build(),
        )
    }
}

pub fn is_crash_reporter_process() -> bool {
    std::env::args().any(|arg| arg.starts_with(CRASH_REPORTER_ARG))
}

/// Module path prefix of everything that can hold speech in memory.
const DICTATION_MODULE: &str = "aura_desktop_lib::dictation";

/// Three gates, all LOAD BEARING for the promise that transcript text never
/// leaves the machine; none is defense in depth for another.
///
/// 1. In the crash reporter process, the event is a native crash of the main
///    app with a minidump attached. A dump taken while a dictation hold was
///    in flight can carry transcript bytes from that thread's stack, so the
///    hold marker (telemetry.rs) decides: present, or unreadable for any
///    reason other than "not there", and the report is dropped. The crash
///    is still recorded locally first, because the crash-loop beacon needs
///    to know it happened even when the dump must not be sent.
/// 2. Any event tagged `dictation_hold` (the same signal forwarded over the
///    reporter's ipc channel) is dropped, which covers the window where the
///    marker file could not be written.
/// 3. Any event that originated inside the dictation module is dropped.
///    `..Default::default()` above means `default_integrations: true`, which
///    installs Sentry's panic capture, and dictation handles transcripts in
///    this same process: the partial and the final both pass through the
///    worker thread and the HUD publish path. A panic anywhere in that code
///    path would ship a report whose message, frames or locals can carry
///    transcript text. The message check catches the `capture_message` path,
///    the frame check catches the panic path.
fn drop_for_dictation_privacy(event: &sentry::protocol::Event<'static>) -> bool {
    if is_crash_reporter_process() {
        record_crash_locally();
        if hold_marker_present_or_unreadable() {
            return true;
        }
    }
    if event.tags.get("dictation_hold").is_some_and(|v| v == "1") {
        return true;
    }
    mentions_dictation(event)
}

/// Written before the privacy decision so a dropped report still counts as
/// a crash on the next launch (telemetry::startup_marker reads it).
fn record_crash_locally() {
    let path = crate::telemetry::crash_marker_path();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, now.to_string());
}

/// Fail closed: only a confirmed "no such file" lets the report through.
fn hold_marker_present_or_unreadable() -> bool {
    match std::fs::metadata(crate::telemetry::hold_marker_path()) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

fn mentions_dictation(event: &sentry::protocol::Event<'static>) -> bool {
    if event
        .message
        .as_deref()
        .is_some_and(|message| message.contains("dictation"))
    {
        return true;
    }
    event.exception.values.iter().any(|exception| {
        exception.stacktrace.iter().any(|stacktrace| {
            stacktrace.frames.iter().any(|frame| {
                frame
                    .module
                    .as_deref()
                    .is_some_and(|module| module.starts_with(DICTATION_MODULE))
                    || frame
                        .function
                        .as_deref()
                        .is_some_and(|function| function.starts_with(DICTATION_MODULE))
            })
        })
    })
}
