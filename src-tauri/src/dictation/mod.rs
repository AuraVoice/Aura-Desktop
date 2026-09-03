//! Hold-to-talk dictation.
//!
//! Hold the chord (`chord::DICTATION_CHORD`; Ctrl + Win on Windows, the same
//! two physical keys as Control + Command on macOS), speak,
//! release, and the words are typed into whatever application had focus before
//! the keys went down. Still completely separate from the screen-aware voice
//! buddy: no LiveKit, no OpenAI, no voice bar, no overlay presentation, no
//! clipboard, no analytics, and no speech-bearing crash report. It shares
//! nothing with that system but the microphone device.
//!
//! Transcription is a streaming cloud recognizer behind the `asr` provider
//! boundary, one socket per hold. It used to be an on-device model bundled
//! into the installer; that model was 650MB of resources for accuracy that was
//! not good enough, and it is gone.
//!
//! WHAT THAT CHANGED, and it is not small. The old module header argued that
//! dictation must work "signed out, offline, on first launch, before any
//! account exists", which is why there is no `security::Operation` here. Half
//! of that is now impossible: a cloud recognizer needs a credential, and the
//! credential needs an account. Signed out or offline, the chord shows a
//! compact HUD error and types nothing. That is a deliberate, accepted
//! regression, not an oversight, and it is why `DictationStatus::reason` now
//! carries a sign-in prompt.
//!
//! There is still no `security::Operation`: every operation in security.rs
//! also requires a LIVE VOICE CALL (security.rs:181-244), which dictation
//! neither has nor wants. The credential check in `run_utterance` is the gate.
//!
//! The privacy posture is now upheld by four things rather than by locality:
//! one-time explicit consent before any audio is captured (`consent`), a
//! short-lived scoped credential that never touches disk (`credential`), a
//! provider configured not to retain audio, and the logging discipline below.
//! The transcript still never touches disk unencrypted, nothing here is logged
//! at any level, and sentry_setup.rs drops any event originating in this
//! module.
//!
//! Local history (`history`) is the one deliberate change to what "unencrypted"
//! used to imply in practice, which was "not stored at all". Finished
//! dictations and their audio ARE retained on this PC, sealed under the
//! dictation key with per-row associated data, capped at 90 days and 512 MB,
//! and erased on every session transition. They never leave the machine, a
//! password-field dictation is never recorded, and the toggle to stop it lives
//! on the Dictation page. Everything above still holds: nothing readable
//! reaches the disk and nothing about a transcript reaches a log.
//!
//! Logging discipline (copied from meeting/audio.rs): counts, durations, byte
//! sizes and outcomes only. Never a transcript, a partial, a hotword, or a
//! correction, at any level. redact.rs runs on the log READ path only
//! (logging.rs:99) and its rules are key=value/JWT shaped, so free-form prose
//! would sail straight through it.

pub mod chord;

pub(crate) mod asr;
mod audio;
mod consent;
mod credential;
#[cfg(windows)]
pub mod import_traces;
pub mod history;
mod hud;
mod insert;
mod usage;
mod vocab;
pub mod polish;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

pub use chord::DICTATION_CHORD;

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    /// A hold would actually transcribe right now: consented, signed in, and
    /// the worker is running. Not a promise that the network is up, which
    /// cannot be known until a socket is opened.
    pub available: bool,
    /// Rendered verbatim in every user-facing surface.
    pub chord_label: &'static str,
    /// Why it is unavailable, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Tier 0 contextual biasing is usable in this install. True since the
    /// switch to the cloud recognizer, which accepts key term prompting; the
    /// on-device decoder this replaced could not.
    pub biasing_available: bool,
    /// The one thing standing in the way when `reason` names an OS grant the
    /// UI can act on, so it can offer the right button instead of parsing
    /// prose. `"inputMonitoring"`: the macOS keystroke grant is missing.
    /// `"relaunch"`: the grant landed after launch and only a restart picks
    /// it up. Absent for every other reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker: Option<&'static str>,
}

impl DictationStatus {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            chord_label: DICTATION_CHORD.label(),
            reason: Some(reason.into()),
            biasing_available: false,
            blocker: None,
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub use platform::{is_holding_text, signal, start, DictationHandle};

/// Whether the user has turned dictation on. Read by `voice_toggle_key::start`
/// on macOS to decide if the Input Monitoring prompt is owed at launch: the
/// event tap serves dictation, so the grant is only demanded of someone who
/// asked for dictation.
#[cfg(target_os = "macos")]
pub(crate) fn consent_accepted(app: &tauri::AppHandle) -> bool {
    consent::is_accepted(app)
}

#[cfg(target_os = "macos")]
const INPUT_MONITORING_REASON: &str =
    "Aura needs Input Monitoring to hear the dictation keys. Allow it under Privacy & Security > Input Monitoring, then restart Aura.";

#[cfg(target_os = "macos")]
const RELAUNCH_REASON: &str =
    "Input Monitoring is allowed. Restart Aura so it can start listening for the dictation keys.";

#[cfg(any(windows, target_os = "macos"))]
mod platform {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use log::{error, info, warn};
    use tauri::AppHandle;

    use super::asr::{self, AsrError, AsrEvent, SessionConfig};
    use super::audio::{self, Capture};
    use super::chord::ChordSignal;
    use super::consent;
    use super::credential;
    use super::history;
    use super::hud::{self, HudPhase, HudUpdate};
    use super::insert::{self, InsertOutcome};
    use super::polish;
    use super::usage;
    use super::vocab;
    use super::{DictationStatus, DICTATION_CHORD};

    /// How long a terminal caption (inserted, or a failure explanation) stays
    /// on screen before the HUD hides itself.
    const CAPTION_LINGER: Duration = Duration::from_millis(2200);
    const FAILURE_LINGER: Duration = Duration::from_millis(4000);
    const RECOVERY_LINGER: Duration = Duration::from_millis(15_000);
    /// How long the one-time consent pill stays up. Much longer than a failure
    /// caption because it is asking a question rather than reporting an
    /// outcome, and the user has to read it before answering. It auto-dismisses
    /// rather than sticking: an unanswered prompt should not become permanent
    /// furniture on someone's screen.
    const CONSENT_LINGER: Duration = Duration::from_millis(15_000);
    /// How long the finalized utterance may take to come back after the chord
    /// is up and the audio tail has been flushed. The provider has all the
    /// audio by this point, so this is a round trip and a decode of the last
    /// segment, not a transcription of the whole utterance. Generous enough to
    /// survive a slow link, short enough that a wedged socket does not leave
    /// the user staring at a HUD.
    const FINAL_TIMEOUT: Duration = Duration::from_millis(2500);
    /// Budget for draining the packet the audio device still holds when the
    /// chord comes up. Without it a user who releases the instant they stop
    /// speaking loses the last word.
    const TAIL_DRAIN: Duration = Duration::from_millis(80);
    /// How often the microphone level is pushed at the HUD's waveform. The
    /// device delivers every 20 to 30ms, which is more than the canvas can use:
    /// it smooths across frames anyway, so 20 updates a second reads as live
    /// while keeping the event traffic trivial. Only ever sent during a hold.
    const LEVEL_EVERY: Duration = Duration::from_millis(50);
    /// How long a finished transcript waits for a text box when none had focus
    /// as the chord came up. Long enough to alt-tab and click into a reply box,
    /// short enough that text can never appear somewhere the user has stopped
    /// associating with what they said.
    const PENDING_WINDOW: Duration = Duration::from_secs(10);
    /// How often the held text re-asks where focus is. Each ask is a single
    /// cross-process property read, and it is skipped outright whenever the UIA
    /// worker is busy with a voice turn.
    const PROBE_TICK: Duration = Duration::from_millis(250);
    const SIGN_IN_REASON: &str = "Sign in to use dictation.";
    const UNAVAILABLE_REASON: &str = "Dictation credential unavailable. Try again shortly.";
    const UNAVAILABLE_HUD: &str = "Dictation credential unavailable. Nothing was typed.";
    /// Shown once the user has been prompted for Accessibility and has not
    /// granted it yet. Names the pane rather than the API, since that is what
    /// they have to go and find.
    #[cfg(target_os = "macos")]
    const ACCESSIBILITY_HUD: &str =
        "Allow Aura under Privacy & Security > Accessibility to type what you say.";

    enum Message {
        Chord(ChordSignal),
        Shutdown,
    }

    /// What the capture loop learned from the signal channel this iteration.
    enum Signal {
        None,
        /// The hold is over: released, cancelled, or the channel is gone.
        Ended,
        Shutdown,
    }

    fn poll_signal(rx: &Receiver<Message>) -> Signal {
        match rx.try_recv() {
            Ok(Message::Shutdown) => Signal::Shutdown,
            Ok(Message::Chord(ChordSignal::Release)) | Ok(Message::Chord(ChordSignal::Cancel)) => {
                Signal::Ended
            }
            Ok(Message::Chord(_)) => Signal::None,
            Err(TryRecvError::Empty) => Signal::None,
            Err(TryRecvError::Disconnected) => Signal::Shutdown,
        }
    }

    /// Set once at startup, read from the low-level keyboard hook. A OnceLock
    /// rather than a Mutex on purpose: the hook callback runs on every key the
    /// user presses anywhere in Windows and must never contend on a lock.
    static CHORD_TX: OnceLock<Sender<Message>> = OnceLock::new();

    /// Bumped for every hold, so a delayed HUD hide from an earlier utterance
    /// cannot close the HUD of the one the user just started.
    static HUD_GENERATION: AtomicU64 = AtomicU64::new(0);

    pub struct DictationHandle {
        status: Arc<Mutex<DictationStatus>>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl DictationHandle {
        pub fn status(&self) -> DictationStatus {
            self.status
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }

        /// Recomputes availability. Called after anything that could have
        /// changed the answer: a credential arriving or being cleared, or
        /// consent being given or withdrawn.
        pub fn refresh(&self, app: &AppHandle) {
            refresh_status(app, &self.status);
            super::emit_status_changed(app);
        }
    }

    impl Drop for DictationHandle {
        fn drop(&mut self) {
            if let Some(tx) = CHORD_TX.get() {
                let _ = tx.send(Message::Shutdown);
            }
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    /// Called from the low-level keyboard hook in voice_toggle_key.rs. Must
    /// stay allocation-light and never block: a send on an unbounded channel
    /// with no live contention is the whole body.
    pub fn signal(chord_signal: ChordSignal) {
        if let Some(tx) = CHORD_TX.get() {
            let _ = tx.send(Message::Chord(chord_signal));
        }
    }

    /// True while text or failed audio is waiting for dismissal or resolution.
    /// Read by the keyboard hook on Escape so the common case is one relaxed
    /// atomic load and no channel traffic.
    pub fn is_holding_text() -> bool {
        HOLDING_PENDING.load(Ordering::Relaxed)
    }

    static HOLDING_PENDING: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    pub fn start(app: AppHandle) -> DictationHandle {
        let (tx, rx) = std::sync::mpsc::channel::<Message>();
        if CHORD_TX.set(tx).is_err() {
            return DictationHandle {
                status: Arc::new(Mutex::new(DictationStatus::unavailable(
                    "dictation was already started once in this process",
                ))),
                worker: None,
            };
        }

        // Replaced by `refresh_status` as soon as the worker thread is up,
        // which is immediate: there is no model to load any more.
        let status = Arc::new(Mutex::new(DictationStatus::unavailable(
            "Dictation is still starting up.",
        )));
        let worker_status = status.clone();
        let worker = std::thread::Builder::new()
            .name("aura-dictation".to_string())
            .spawn(move || worker_thread(app, rx, worker_status));

        match worker {
            Ok(worker) => DictationHandle {
                status,
                worker: Some(worker),
            },
            Err(e) => {
                let reason = format!("dictation worker could not start: {e}");
                error!("dictation: {reason}");
                DictationHandle {
                    status: Arc::new(Mutex::new(DictationStatus::unavailable(reason))),
                    worker: None,
                }
            }
        }
    }

    /// The dedicated worker. Everything expensive lives here and never on the
    /// thread that pumps the native window's messages: WASAPI, the socket
    /// handshake wait, and the SendInput burst.
    fn worker_thread(
        app: AppHandle,
        rx: Receiver<Message>,
        status: Arc<Mutex<DictationStatus>>,
    ) {
        // WASAPI is COM, and every call below happens on this thread. macOS
        // has no apartment to join, so this is the whole of the difference.
        #[cfg(windows)]
        if wasapi::initialize_mta().is_err() {
            set_status(&status, DictationStatus::unavailable("COM init failed"));
            return;
        }

        // There is nothing to probe at startup any more: no bundled runtime, no
        // model files, no load. What decides availability now is whether the
        // user has consented and whether a credential has arrived from the
        // webview, and both can change at any moment, so it is recomputed
        // rather than latched here.
        refresh_status(&app, &status);
        info!("dictation: worker ready, chord={}", DICTATION_CHORD.label());

        let mut capture: Option<Capture> = None;
        // A finished transcript with nowhere to go yet. Held HERE, in the loop
        // that also receives chord signals, so waiting for a text box can never
        // swallow a signal: a message arriving mid-hold cancels the hold and is
        // then handled normally, exactly as if nothing had been pending.
        let mut pending: Option<PendingText> = None;
        // Audio from a failed utterance stays memory-only until the error HUD
        // is dismissed, Escape is pressed, or a new hold supersedes it.
        let mut failed: Option<FailedUtterance> = None;
        loop {
            // Nothing to expire in the background now that there is no model to
            // unload, so the worker blocks indefinitely unless it is holding
            // text and has to keep re-probing for a text box.
            let timeout = if pending.is_some() || failed.is_some() {
                Some(PROBE_TICK)
            } else {
                None
            };
            let received = if let Some(timeout) = timeout {
                match rx.recv_timeout(timeout) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match rx.recv() {
                    Ok(message) => Some(message),
                    Err(_) => break,
                }
            };
            let Some(message) = received else {
                // A quiet tick, which only happens while text is held: ask
                // again whether a text box has appeared.
                if let Some(held) = pending.take() {
                    pending = advance_pending(&app, held);
                }
                if failed
                    .as_ref()
                    .is_some_and(|utterance| Instant::now() >= utterance.expires_at)
                {
                    discard_failed(failed.take().expect("failed utterance exists"), "dismissed");
                }
                set_holding(pending.is_some() || failed.is_some());
                continue;
            };
            // A new dictation supersedes held text: words from an earlier hold
            // must never land inside a newer one. Escape drops it outright.
            //
            // Chord NOISE deliberately does not. Prewarm, and the Cancel that
            // an ordinary Ctrl+C produces, both arrive constantly while the
            // user works, and losing held text to a copy shortcut would make
            // the hold feel arbitrary.
            if matches!(
                message,
                Message::Chord(ChordSignal::Arm) | Message::Chord(ChordSignal::CancelPending)
            ) {
                if let Some(held) = pending.take() {
                    discard_pending(&app, held, "superseded");
                }
                if let Some(utterance) = failed.take() {
                    discard_failed(utterance, "superseded");
                }
                set_holding(false);
            }
            match message {
                Message::Shutdown => break,
                Message::Chord(ChordSignal::CancelPending) => {
                    // Already dropped above. The signal only fires while
                    // something is held, so there is nothing else to do.
                }
                Message::Chord(ChordSignal::Prewarm) => {
                    // Deliberately inert. Prewarm means "one chord key is down",
                    // and this hook cannot see mouse input, so a Ctrl-click or a
                    // Ctrl-drag through a file list is indistinguishable from a
                    // long deliberate Ctrl hold. Nothing expensive may hang off
                    // it: not the microphone (a device handle would light the
                    // Windows "in use" indicator) and not a transcription
                    // socket either, which is billed from the moment it opens
                    // and would be opened over and over by a user who never
                    // dictates.
                    //
                    // Both the device and the socket start only once the FULL
                    // chord is down (`handle_arm`). The WASAPI cold start and
                    // the TLS handshake both hide behind the 200 to 400ms a
                    // human takes before their first phoneme, and audio sent
                    // before the handshake completes is buffered rather than
                    // dropped, so nothing needs warming ahead of a guess.
                }
                Message::Chord(ChordSignal::Cancel) | Message::Chord(ChordSignal::Release) => {
                    // Either an abandoned prewarm, or a release with no matching
                    // arm. Drop the device so no "mic in use" indicator lingers.
                    capture = None;
                }
                Message::Chord(ChordSignal::Arm) => {
                    let mut held = None;
                    let shutting_down =
                        handle_arm(&app, &mut capture, &rx, &status, &mut held, &mut failed);
                    if let Some(payload) = held {
                        pending = Some(PendingText::new(payload));
                    }
                    set_holding(pending.is_some() || failed.is_some());
                    if shutting_down {
                        break;
                    }
                }
            }
        }
        if let Some(held) = pending.take() {
            discard_pending(&app, held, "shutting down");
        }
        if let Some(utterance) = failed.take() {
            discard_failed(utterance, "shutting down");
        }
        set_holding(false);
        hud::hide(&app);
    }

    /// A transcript waiting for somewhere to land.
    struct PendingPayload {
        text: String,
    }

    struct PendingText {
        text: String,
        expires_at: Instant,
        /// The HUD generation of the hold that produced it, so the closing
        /// caption cannot be hidden by a stale timer from an earlier utterance.
        generation: u64,
    }

    impl PendingText {
        fn new(payload: PendingPayload) -> Self {
            Self {
                text: payload.text,
                expires_at: Instant::now() + PENDING_WINDOW,
                generation: HUD_GENERATION.load(Ordering::SeqCst),
            }
        }
    }

    struct FailedUtterance {
        samples: Vec<f32>,
        expires_at: Instant,
        category: &'static str,
    }

    fn hold_failure(
        app: &AppHandle,
        generation: u64,
        failed: &mut Option<FailedUtterance>,
        samples: Vec<f32>,
        category: &'static str,
        message: &'static str,
    ) {
        warn!(
            "dictation: phase=failure failure={category} frames={}",
            samples.len()
        );
        finish_with(
            app,
            generation,
            HudUpdate::new(HudPhase::Error).with_message(message),
            FAILURE_LINGER,
        );
        *failed = Some(FailedUtterance {
            samples,
            expires_at: Instant::now() + FAILURE_LINGER,
            category,
        });
    }

    fn discard_failed(utterance: FailedUtterance, reason: &str) {
        info!(
            "dictation: phase=failure_buffer state=released failure={} reason={reason} frames={}",
            utterance.category,
            utterance.samples.len()
        );
    }

    fn set_holding(holding: bool) {
        HOLDING_PENDING.store(holding, Ordering::Relaxed);
    }

    /// One tick of the hold: land the text if a text box now has focus, expire
    /// it if the window has run out, otherwise keep waiting. Returns the text
    /// still being held, or None once it is resolved either way.
    fn advance_pending(app: &AppHandle, held: PendingText) -> Option<PendingText> {
        // Only a CONFIDENT yes lands the text. Unknown deliberately does not:
        // on the insert path Unknown means "type, refusing is worse", but here
        // the user has already been told the text is waiting for a text box,
        // and dropping it into an ambiguous pane instead would be exactly the
        // surprise this whole path exists to avoid.
        let probe = crate::uia::probe_focus(app);
        if matches!(probe.verdict, crate::uia::FocusVerdict::Typable) {
            match insert::insert_text_here(&held.text) {
                InsertOutcome::Inserted => {
                    info!(
                        "dictation: held text landed role={} chars={}",
                        probe.role,
                        held.text.chars().count()
                    );
                    usage::record_later(app, usage::word_count(&held.text));
                    finish_with(
                        app,
                        held.generation,
                        HudUpdate::new(HudPhase::Inserted).with_text(held.text),
                        CAPTION_LINGER,
                    );
                    return None;
                }
                // A modifier is down, or the click landed on an elevated
                // window. Neither is final: keep waiting for a better moment.
                InsertOutcome::KeysHeld | InsertOutcome::Blocked => {}
                other => {
                    warn!("dictation: held text could not be typed ({other:?})");
                }
            }
        }
        if Instant::now() >= held.expires_at {
            discard_pending(app, held, "no text box appeared");
            return None;
        }
        Some(held)
    }

    /// Stops waiting for a text box and offers the held transcript for copying.
    /// The transcript itself is never logged, only the reason.
    fn discard_pending(app: &AppHandle, held: PendingText, reason: &str) {
        info!(
            "dictation: held text released for recovery ({reason}) chars={}",
            held.text.chars().count()
        );
        finish_with(
            app,
            held.generation,
            HudUpdate::new(HudPhase::Recovery)
                .with_text(held.text)
                .with_message("No text box appeared, so nothing was typed."),
            RECOVERY_LINGER,
        );
    }

    /// One hold, with the device always released afterwards. Returns true when
    /// the process is shutting down.
    fn handle_arm(
        app: &AppHandle,
        capture: &mut Option<Capture>,
        rx: &Receiver<Message>,
        status: &Arc<Mutex<DictationStatus>>,
        held: &mut Option<PendingPayload>,
        failed: &mut Option<FailedUtterance>,
    ) -> bool {
        if capture.is_none() {
            *capture = open_capture();
        }
        // A panic inside one utterance must not take dictation down for the
        // rest of the session. The hook in logging.rs additionally refuses to
        // format a panic raised on this thread, so no payload that might carry
        // transcript text reaches the plaintext log.
        let shutting_down = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_utterance(app, capture, rx, status, held, failed)
        }))
        .unwrap_or_else(|_| {
            error!("dictation: an utterance panicked, the worker is continuing");
            hud::publish(
                app,
                HudUpdate::new(HudPhase::Error)
                    .with_message("Dictation stopped unexpectedly. Nothing was typed."),
            );
            false
        });
        // The device goes back either way. The transcription socket does too:
        // the session is owned inside `run_utterance` and dropping it closes a
        // stream that is billed for as long as it stays open.
        *capture = None;
        refresh_status(app, status);
        shutting_down
    }

    fn open_capture() -> Option<Capture> {
        match Capture::open() {
            Ok(capture) => Some(capture),
            Err(e) => {
                warn!("dictation: capture device unavailable: {e}");
                None
            }
        }
    }

    fn set_status(status: &Arc<Mutex<DictationStatus>>, next: DictationStatus) {
        *status.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }

    /// Recomputes what the UI should say about dictation right now.
    ///
    /// Availability is no longer a property of the install, so it cannot be
    /// decided once at startup: it depends on consent (persisted, revocable
    /// from Settings) and on a credential the webview pushes down and lets
    /// expire. Both change while the app is running, so every caller that
    /// might have observed a change calls this rather than latching a value.
    pub(super) fn refresh_status(app: &AppHandle, status: &Arc<Mutex<DictationStatus>>) {
        let next = if !consent::is_accepted(app) {
            DictationStatus::unavailable(
                "Turn on online dictation to use the dictation chord.",
            )
        } else if !credential::is_present() {
            DictationStatus::unavailable(if crate::security::current_uid(app).is_some() {
                UNAVAILABLE_REASON
            } else {
                SIGN_IN_REASON
            })
        } else {
            DictationStatus {
                available: true,
                chord_label: DICTATION_CHORD.label(),
                reason: None,
                // Key term prompting is a real biasing mechanism, unlike the
                // on-device decoder this replaced.
                biasing_available: true,
                blocker: None,
            }
        };
        set_status(status, next);
    }

    /// One hold, start to finish. Returns true when the process is shutting
    /// down and the worker loop should exit.
    ///
    /// The order of the first three steps is load bearing: consent is checked
    /// before the HUD, the HUD before the microphone, and the microphone
    /// before the socket. A user who has not consented never has a microphone
    /// opened on their behalf, and nobody's audio is streamed to a provider by
    /// a code path that got as far as capturing it "just in case".
    fn run_utterance(
        app: &AppHandle,
        capture: &mut Option<Capture>,
        rx: &Receiver<Message>,
        status: &Arc<Mutex<DictationStatus>>,
        held: &mut Option<PendingPayload>,
        failed: &mut Option<FailedUtterance>,
    ) -> bool {
        let generation = HUD_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        // Snapshot the target BEFORE the HUD exists on screen, so nothing this
        // module does can change what "the app the user was in" means.
        let target = insert::foreground_window();
        let app_key = crate::system_control::process_stem_for_window(target);

        // Preflight 0 (macOS): the Accessibility grant. Without it CGEvent
        // cannot post keystrokes and the focus probe reads nothing, so the
        // hold would capture and transcribe and then have nowhere to put the
        // words. Prompting HERE rather than at launch means the system dialog
        // appears the first time the user actually reaches for dictation,
        // instead of ambushing everyone who never uses it.
        #[cfg(target_os = "macos")]
        if !crate::macos_ax::is_trusted(true) {
            let shutting_down = drain_until_release(rx);
            hud::show(app, target);
            info!("dictation: phase=preflight blocked=accessibility_not_granted");
            hold_failure(
                app,
                generation,
                failed,
                Vec::new(),
                "permission",
                ACCESSIBILITY_HUD,
            );
            refresh_status(app, status);
            return shutting_down;
        }

        // Preflight 1: consent. No microphone is opened, no HUD "listening"
        // state is entered, and no byte of audio exists at this point.
        if !consent::is_accepted(app) {
            let shutting_down = drain_until_release(rx);
            hud::show(app, target);
            info!("dictation: phase=preflight blocked=consent_required");
            finish_with(
                app,
                generation,
                HudUpdate::new(HudPhase::Consent),
                CONSENT_LINGER,
            );
            refresh_status(app, status);
            return shutting_down;
        }

        // Preflight 2: the credential. Checked before the device so a signed
        // out user never lights the Windows microphone indicator for an
        // utterance that was never going to be transcribed.
        let Some(token) = credential::usable() else {
            let signed_in = crate::security::current_uid(app).is_some();
            let shutting_down = drain_until_release(rx);
            hud::show(app, target);
            hold_failure(
                app,
                generation,
                failed,
                Vec::new(),
                if signed_in {
                    "unavailable"
                } else {
                    AsrError::NotAuthenticated.category()
                },
                if signed_in {
                    UNAVAILABLE_HUD
                } else {
                    AsrError::NotAuthenticated.hud_message()
                },
            );
            refresh_status(app, status);
            return shutting_down;
        };

        hud::show(app, target);
        hud::publish(app, HudUpdate::new(HudPhase::Listening));
        // Fire-and-forget onto the ducking worker thread; it reads the user's
        // preference itself and no-ops when off. Never inline: enumerating
        // audio sessions would add COM latency to the top of every hold.
        crate::audio_ducking::mute_others(app);

        let Some(active_capture) = capture.as_mut() else {
            let shutting_down = drain_until_release(rx);
            hold_failure(
                app,
                generation,
                failed,
                Vec::new(),
                "capture_open",
                "No microphone is available right now.",
            );
            return shutting_down;
        };
        // Drop whatever WASAPI had already buffered when the device opened, so
        // the utterance starts at the chord and not before it.
        if active_capture.discard_pending().is_err() {
            let shutting_down = drain_until_release(rx);
            hold_failure(
                app,
                generation,
                failed,
                Vec::new(),
                "capture_read",
                "The microphone stopped responding. Nothing was typed.",
            );
            return shutting_down;
        }

        let vocabulary = vocab::load_vocab(app).unwrap_or_default();
        let corrections = vocab::load_corrections(app).unwrap_or_default();
        // Tier 0: the user's own vocabulary and their confirmed corrections go
        // INTO recognition for this utterance. Read before the socket opens
        // because they are part of the handshake.
        let keyterms = vocab::keyterms_for(
            &vocabulary,
            &corrections,
            app_key.as_deref(),
            asr::deepgram::MAX_KEYTERMS,
        );
        let keyterm_count = keyterms.len();

        // Opens without blocking: the handshake runs on the async runtime and
        // audio sent before it lands is buffered, not dropped. A handshake
        // failure arrives as a session event a moment later.
        let mut session = match asr::provider().start(SessionConfig {
            sample_rate: asr::SAMPLE_RATE,
            keyterms,
            credential: token,
        }) {
            Ok(session) => session,
            Err(error) => {
                let shutting_down = drain_until_release(rx);
                hold_failure(
                    app,
                    generation,
                    failed,
                    Vec::new(),
                    error.category(),
                    error.hud_message(),
                );
                return shutting_down;
            }
        };

        let started_at = Instant::now();
        info!("dictation: phase=capture keyterms={keyterm_count}");
        let mut last_level = Instant::now();
        let mut captured_frames = 0usize;
        let mut heard_speech = false;
        let mut shutting_down = false;
        let mut capped = false;
        let mut utterance: Vec<f32> = Vec::new();
        // When the chord actually came up, so the "key up to text on screen"
        // budget is measured from the release rather than from this line.
        // Always set before the loop exits.
        let released_at: Option<Instant>;

        loop {
            match poll_signal(rx) {
                Signal::Shutdown => {
                    shutting_down = true;
                    released_at = Some(Instant::now());
                    break;
                }
                Signal::Ended => {
                    released_at = Some(Instant::now());
                    break;
                }
                Signal::None => {}
            }

            let samples = match active_capture.drain() {
                Ok(samples) => samples,
                Err(_) => {
                    session.cancel();
                    let shutting_down = shutting_down || drain_until_release(rx);
                    hold_failure(
                        app,
                        generation,
                        failed,
                        utterance,
                        "capture_read",
                        "The microphone stopped responding. Nothing was typed.",
                    );
                    return shutting_down;
                }
            };
            if !samples.is_empty() {
                captured_frames += samples.len();
                if !audio::is_silence(&samples) {
                    heard_speech = true;
                }
                if session.send_pcm(&audio::to_i16(&samples)).is_err() {
                    session.cancel();
                    let shutting_down = shutting_down || drain_until_release(rx);
                    hold_failure(
                        app,
                        generation,
                        failed,
                        utterance,
                        AsrError::Network.category(),
                        AsrError::Network.hud_message(),
                    );
                    return shutting_down;
                }
                // Accumulated for two consumers: the failure paths, which
                // report how much audio was affected, and history.rs, which
                // encodes it to a replayable clip once the insert succeeds.
                utterance.extend_from_slice(&samples);
            }

            // Non-blocking, so a quiet network costs this loop nothing.
            let mut mid_hold_failure = None;
            while let Some(event) = session.poll() {
                match event {
                    AsrEvent::Partial(_) => {}
                    // A final before the chord is up means the provider ended
                    // the stream on its own. Treated as a failure rather than
                    // typed: the user is still speaking, so whatever arrived
                    // is not the utterance they are in the middle of.
                    AsrEvent::Final(_) => {
                        mid_hold_failure = Some(AsrError::Provider);
                    }
                    AsrEvent::Failed(error) => {
                        mid_hold_failure = Some(error);
                    }
                }
            }
            if let Some(error) = mid_hold_failure {
                session.cancel();
                let shutting_down = shutting_down || drain_until_release(rx);
                if matches!(error, AsrError::Rejected) {
                    // The token the webview gave us was refused. Drop it so the
                    // next press re-mints instead of replaying a bad credential.
                    credential::clear();
                }
                hold_failure(
                    app,
                    generation,
                    failed,
                    utterance,
                    error.category(),
                    error.hud_message(),
                );
                refresh_status(app, status);
                return shutting_down;
            }

            // An empty drain publishes 0.0 rather than being skipped: flat bars
            // are the honest reading for a muted or dead device, and that is
            // the whole reason the waveform is here.
            if last_level.elapsed() >= LEVEL_EVERY {
                last_level = Instant::now();
                hud::publish_level(app, audio::level(&samples));
            }

            if started_at.elapsed() >= audio::MAX_HOLD {
                capped = true;
                released_at = Some(Instant::now());
                break;
            }
        }

        // The chord came up, but WASAPI still holds the packet that carried the
        // last word. Drain the tail and send it BEFORE finalizing, or a user who
        // releases the instant they stop speaking loses it. This is the whole
        // reason `Finalize` is not sent the moment the keys come up.
        let tail_deadline = Instant::now() + TAIL_DRAIN;
        let finalization_started_at = released_at.unwrap_or_else(Instant::now);
        let mut empty_drains = 0u8;
        while empty_drains < 2 && Instant::now() < tail_deadline {
            let samples = match active_capture.drain() {
                Ok(samples) => samples,
                Err(_) => {
                    session.cancel();
                    hold_failure(
                        app,
                        generation,
                        failed,
                        utterance,
                        "capture_read",
                        "The microphone stopped responding. Nothing was typed.",
                    );
                    return shutting_down;
                }
            };
            if samples.is_empty() {
                empty_drains += 1;
                continue;
            }
            empty_drains = 0;
            captured_frames += samples.len();
            if !audio::is_silence(&samples) {
                heard_speech = true;
            }
            let _ = session.send_pcm(&audio::to_i16(&samples));
            utterance.extend_from_slice(&samples);
        }
        // Release the device now. The rest of this function is waiting on the
        // network, and the Windows microphone indicator must not stay lit
        // through it.
        active_capture.stop();

        // The utterance was silent. Nothing to finalize, and no reason to pay
        // for a round trip or show a failure: releasing without speaking is a
        // neutral cancel.
        if !heard_speech {
            session.cancel();
            info!(
                "dictation: nothing to insert (frames={captured_frames} hold_ms={})",
                started_at.elapsed().as_millis()
            );
            finish_with(app, generation, HudUpdate::new(HudPhase::Idle), Duration::ZERO);
            return shutting_down;
        }

        hud::publish(app, HudUpdate::new(HudPhase::Transcribing));

        if let Err(error) = session.finish() {
            session.cancel();
            hold_failure(
                app,
                generation,
                failed,
                utterance,
                error.category(),
                error.hud_message(),
            );
            return shutting_down;
        }

        let decoded = match session.await_final(Instant::now() + FINAL_TIMEOUT) {
            Ok(text) => text,
            Err(error) => {
                session.cancel();
                if matches!(error, AsrError::Rejected) {
                    credential::clear();
                }
                hold_failure(
                    app,
                    generation,
                    failed,
                    utterance,
                    error.category(),
                    error.hud_message(),
                );
                refresh_status(app, status);
                return shutting_down;
            }
        };
        // Closes the socket immediately. An open stream is billed, and this one
        // has nothing left to say.
        drop(session);

        let hold_ms = started_at.elapsed().as_millis();
        let audio_ms = captured_frames as f64 * 1000.0 / asr::SAMPLE_RATE as f64;
        let finalization_ms = finalization_started_at.elapsed().as_millis();
        info!(
            "dictation: phase=finalize audio_ms={audio_ms:.0} finalization_ms={finalization_ms} hold_ms={hold_ms}"
        );
        if finalization_ms > 1200 {
            warn!(
                "dictation: phase=finalize target_miss=keyup_to_insert finalization_ms={finalization_ms}"
            );
        }
        if capped {
            warn!(
                "dictation: hold hit the {}s cap, finalizing the bounded utterance",
                audio::MAX_HOLD.as_secs()
            );
        }

        if decoded.trim().is_empty() {
            info!(
                "dictation: empty transcription result (frames={captured_frames} hold_ms={hold_ms})"
            );
            finish_with(app, generation, HudUpdate::new(HudPhase::Idle), Duration::ZERO);
            return shutting_down;
        }

        // Tier 1 still runs on the final text, after recognition. Biasing gets
        // the term into the decode; this fixes what biasing did not catch.
        let corrected =
            vocab::apply_corrections(&decoded, &corrections, &vocabulary, app_key.as_deref());

        // Optional AI cleanup (polish.rs): opt-in, user's own Groq key,
        // bounded wait. Every failure falls back to the corrected text, so
        // this step can never hang the utterance or lose words. Runs before
        // the focus probe so the pending path below inherits the result.
        let polish_result = if polish::wants(app) {
            polish::format_transcript(app, &corrected, app_key.as_deref())
        } else {
            None
        };
        // Kept only when polish actually changed the text, so history can show
        // "original speech" next to what was typed; otherwise it would just
        // duplicate the row's text.
        let raw_for_history = match &polish_result {
            Some(polished) if *polished != corrected => Some(corrected.clone()),
            _ => None,
        };
        let final_text = polish_result.unwrap_or(corrected);

        // Asked here, at the last possible moment, because this is the only
        // point at which "where would these keystrokes go" has its final
        // answer. Bounded and fails open; see uia/focus.rs.
        let probe = crate::uia::probe_focus(app);
        let outcome = insert::insert_text(&final_text, target, probe.verdict);
        info!(
            "dictation: phase=insert hold_ms={hold_ms} frames={captured_frames} chars={} role={} \
             verdict={:?} outcome={outcome:?}",
            final_text.chars().count(),
            probe.role,
            probe.verdict
        );

        // Local history (history.rs). The one call site, placed here because
        // this is the last point at which both the final text and the captured
        // samples are still owned, and because the outcome is now known: a
        // password field is never archived, and the deferred NoTextField path
        // below must not record the same utterance twice. Everything past the
        // gate happens on the blocking pool, so the caption is already on
        // screen while the clip encodes.
        if !matches!(outcome, InsertOutcome::PasswordField) {
            history::record_later(
                app,
                final_text.clone(),
                raw_for_history,
                std::mem::take(&mut utterance),
                hold_ms as i64,
                usage::word_count(&final_text),
            );
        }

        // The one outcome that does not end the utterance. The words are kept
        // and the HUD says so; the worker loop waits for a text box and types
        // them there. The caption is published directly rather than through
        // finish_with, which would schedule the HUD's own hide.
        if matches!(outcome, InsertOutcome::NoTextField) {
            hud::publish(
                app,
                HudUpdate::new(HudPhase::Pending)
                    .with_text(final_text.clone())
                    .with_message("Waiting for a text box"),
            );
            *held = Some(PendingPayload { text: final_text });
            return shutting_down;
        }

        if matches!(outcome, InsertOutcome::Inserted) {
            usage::record_later(app, usage::word_count(&final_text));
        }

        let (update, linger) = match outcome {
            InsertOutcome::Inserted => (
                HudUpdate::new(HudPhase::Inserted).with_text(final_text),
                CAPTION_LINGER,
            ),
            InsertOutcome::NoTextField => unreachable!("handled above"),
            InsertOutcome::PasswordField => (
                HudUpdate::new(HudPhase::Error)
                    .with_message("Aura does not type into password fields."),
                FAILURE_LINGER,
            ),
            InsertOutcome::FocusChanged => (
                HudUpdate::new(HudPhase::Recovery)
                    .with_text(final_text)
                    .with_message("Focus changed, so nothing was typed."),
                RECOVERY_LINGER,
            ),
            InsertOutcome::KeysHeld => (
                HudUpdate::new(HudPhase::Recovery)
                    .with_text(final_text)
                    .with_message(format!(
                        "Release {}. Nothing was typed.",
                        DICTATION_CHORD.label()
                    )),
                RECOVERY_LINGER,
            ),
            InsertOutcome::Blocked => (
                HudUpdate::new(HudPhase::Recovery)
                    .with_text(final_text)
                    .with_message(
                        "Windows blocked typing into that window because it runs as administrator.",
                    ),
                RECOVERY_LINGER,
            ),
        };
        finish_with(app, generation, update, linger);
        shutting_down
    }

    /// Consumes signals until the hold ends, for the failure paths that have
    /// nothing to decode. Returns true when the process is shutting down.
    fn drain_until_release(rx: &Receiver<Message>) -> bool {
        let deadline = Instant::now() + audio::MAX_HOLD;
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Message::Shutdown) => return true,
                Ok(Message::Chord(ChordSignal::Release))
                | Ok(Message::Chord(ChordSignal::Cancel)) => return false,
                Ok(Message::Chord(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return true,
            }
            if Instant::now() >= deadline {
                return false;
            }
        }
    }

    /// Publishes the closing caption and schedules the HUD to return to its
    /// resting pill, unless a newer hold has started in the meantime.
    fn finish_with(app: &AppHandle, generation: u64, update: HudUpdate, linger: Duration) {
        // Every terminal path funnels through here, so this is the one place
        // the waveform has to be told the hold is over. Without it the bars
        // would hold their last spike for the whole caption linger.
        hud::publish_level(app, 0.0);
        let phase = update.phase;
        hud::publish(app, update);
        // Same "one place every terminal path funnels through" argument as the
        // level reset above: unmuting here means an error or an aborted hold
        // gives the user their audio back exactly like a clean insert does.
        crate::audio_ducking::restore(app);
        // Every other phase is a status the user reads and forgets, so timing
        // out to the resting pill is right. Consent is a QUESTION, and nothing
        // here cancels or extends the timer, so a user still reading the
        // disclosure watched it vanish mid-sentence with no way to answer.
        // It leaves on its own terms instead: dictation_set_consent publishes
        // Idle the moment either button is pressed.
        if phase == HudPhase::Consent {
            return;
        }
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(linger).await;
            if HUD_GENERATION.load(Ordering::SeqCst) == generation {
                hud::publish(&handle, HudUpdate::new(HudPhase::Idle));
            }
        });
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub use stub::{is_holding_text, signal, start, DictationHandle};

#[cfg(not(any(windows, target_os = "macos")))]
mod stub {
    use tauri::AppHandle;

    use super::chord::ChordSignal;
    use super::DictationStatus;

    pub struct DictationHandle {
        status: DictationStatus,
    }

    impl DictationHandle {
        pub fn status(&self) -> DictationStatus {
            self.status.clone()
        }
    }

    impl DictationHandle {
        pub fn refresh(&self, _app: &AppHandle) {}
    }

    pub fn signal(_chord_signal: ChordSignal) {}

    pub fn is_holding_text() -> bool {
        false
    }

    pub fn start(_app: AppHandle) -> DictationHandle {
        DictationHandle {
            status: DictationStatus::unavailable(
                "Dictation is available on Windows and macOS only.",
            ),
        }
    }
}

#[tauri::command]
pub fn dictation_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, DictationHandle>,
) -> DictationStatus {
    state.refresh(&app);
    #[cfg(any(windows, target_os = "macos"))]
    {
        with_listener_health(&app, state.status())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        state.status()
    }
}

#[cfg(any(windows, target_os = "macos"))]
const LISTENER_UNAVAILABLE_REASON: &str =
    "Keyboard listener unavailable. Restart Aura. If this continues, another security tool may be blocking keyboard access.";

/// Appends the listener's OWN failure text to the guidance above. The four
/// install failures in `voice_toggle_key::platform::start` are already logged
/// and sent to Sentry, but the UI flattened all of them into one sentence, so
/// the one question a support report needs to answer - WHICH step failed -
/// was the only thing the user could not see.
#[cfg(any(windows, target_os = "macos"))]
fn listener_unavailable_reason(detail: Option<String>) -> String {
    match detail {
        Some(detail) if !detail.trim().is_empty() => {
            format!("{LISTENER_UNAVAILABLE_REASON} (Details: {})", detail.trim())
        }
        _ => LISTENER_UNAVAILABLE_REASON.to_string(),
    }
}

#[cfg(any(windows, target_os = "macos"))]
static LAST_EMITTED_STATUS: std::sync::OnceLock<std::sync::Mutex<Option<DictationStatus>>> =
    std::sync::OnceLock::new();

#[cfg(any(windows, target_os = "macos"))]
fn with_listener_health(app: &tauri::AppHandle, mut status: DictationStatus) -> DictationStatus {
    // macOS gates the event tap behind Input Monitoring, and the grant only
    // takes effect after a relaunch. Both are checked SILENTLY here (no
    // prompt) and named outright, because the generic "listener unavailable,
    // restart" text below would send the user to the wrong fix. The listener
    // handle's own reason describes the double-tap voice trigger, which is not
    // what a Mac user staring at the dictation page needs to hear about.
    #[cfg(target_os = "macos")]
    {
        if !crate::voice_toggle_key::input_monitoring_granted() {
            status.available = false;
            status.reason = Some(INPUT_MONITORING_REASON.to_string());
            status.biasing_available = false;
            status.blocker = Some("inputMonitoring");
            return status;
        }
        let listener_down = app
            .try_state::<crate::voice_toggle_key::VoiceToggleKeyHandle>()
            .is_some_and(|listener| !listener.status().available);
        if listener_down {
            status.available = false;
            status.reason = Some(RELAUNCH_REASON.to_string());
            status.biasing_available = false;
            status.blocker = Some("relaunch");
            return status;
        }
    }
    if let Some(listener) = app.try_state::<crate::voice_toggle_key::VoiceToggleKeyHandle>() {
        let listener_status = listener.status();
        if !listener_status.available {
            status.available = false;
            status.reason = Some(listener_unavailable_reason(listener_status.reason));
            status.biasing_available = false;
        }
    }
    // The Accessibility grant, checked SILENTLY here. This runs on every status
    // poll, including the Dictation settings page's, and the prompting form
    // belongs to the first hold instead (see run_utterance's preflight 0) - a
    // status read must never put a system dialog on screen.
    #[cfg(target_os = "macos")]
    if status.available && !crate::macos_ax::is_trusted(false) {
        status.available = false;
        status.reason = Some(
            "Aura needs Accessibility access to type what you say. Allow it under \
             Privacy & Security > Accessibility."
                .to_string(),
        );
        status.biasing_available = false;
    }
    status
}

#[cfg(any(windows, target_os = "macos"))]
pub fn emit_status_changed(app: &tauri::AppHandle) {
    let Some(handle) = app.try_state::<DictationHandle>() else { return };
    let next = with_listener_health(app, handle.status());
    let last = LAST_EMITTED_STATUS.get_or_init(|| std::sync::Mutex::new(None));
    let mut previous = last.lock().unwrap_or_else(|error| error.into_inner());
    if previous.as_ref() == Some(&next) {
        return;
    }
    *previous = Some(next.clone());
    let _ = app.emit(crate::events::DICTATION_STATUS_CHANGED, next);
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationUsageEntry {
    pub recorded_at_ms: i64,
    pub words: u64,
}

#[tauri::command]
pub async fn dictation_usage_entries(
    app: tauri::AppHandle,
) -> Result<Vec<DictationUsageEntry>, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let Some(uid) = crate::security::current_uid(&app) else {
            return Ok(Vec::new());
        };
        tauri::async_runtime::spawn_blocking(move || usage::entries(&app, &uid))
            .await
            .map_err(|error| format!("dictation usage task failed: {error}"))?
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

/// The online-dictation consent state, for the HUD prompt and the Settings
/// page. Both surfaces read the same value so they can never disagree.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentState {
    pub accepted: bool,
}

#[tauri::command]
pub async fn dictation_consent_state(app: tauri::AppHandle) -> Result<ConsentState, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        Ok(ConsentState {
            accepted: consent::is_accepted(&app),
        })
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Ok(ConsentState { accepted: false })
    }
}

/// Records or withdraws consent for online dictation.
///
/// Deliberately WITHOUT a `security::Operation`, for the same reason as the
/// rest of this module: every operation in security.rs also requires a live
/// voice call. This is a local privacy preference for a local feature, and the
/// nothing it unlocks is reachable without a credential anyway.
#[tauri::command]
pub async fn dictation_set_consent(
    app: tauri::AppHandle,
    state: tauri::State<'_, DictationHandle>,
    accepted: bool,
) -> Result<ConsentState, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        log::info!("dictation: consent answered accepted={accepted}");
        let accepted = consent::set_accepted(&app, accepted)?;
        // Turning dictation on is the moment the keystroke grant is owed on
        // macOS: the event tap that hears the chord is gated behind Input
        // Monitoring. This fires the one-time system prompt (or just lists
        // Aura in that pane), and the refresh below publishes the blocker so
        // Settings can say the grant still needs a relaunch to land.
        #[cfg(target_os = "macos")]
        if accepted && !crate::voice_toggle_key::input_monitoring_granted() {
            crate::voice_toggle_key::request_input_monitoring();
        }
        state.refresh(&app);
        // Take the prompt off screen the moment it is answered, rather than
        // leaving the user looking at a question they have already resolved.
        hud::publish(&app, hud::HudUpdate::new(hud::HudPhase::Idle));
        Ok(ConsentState { accepted })
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, state, accepted);
        Err(NOT_SUPPORTED.to_string())
    }
}

/// Hands Rust the short-lived transcription credential the webview minted.
///
/// The permanent provider key is never in this process; see `credential.rs`.
/// `ttlSeconds` comes from the provider's own grant response, not from a
/// number the client picked.
#[tauri::command]
pub async fn dictation_set_credential(
    app: tauri::AppHandle,
    state: tauri::State<'_, DictationHandle>,
    access_token: String,
    ttl_seconds: u64,
) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        if access_token.trim().is_empty() {
            return Err("the dictation credential is empty".to_string());
        }
        credential::set(access_token, std::time::Duration::from_secs(ttl_seconds));
        state.refresh(&app);
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, state, access_token, ttl_seconds);
        Err(NOT_SUPPORTED.to_string())
    }
}

/// Drops the credential. Called on sign-out, and whenever the webview decides
/// the session it was minted for is no longer valid.
#[tauri::command]
pub async fn dictation_clear_credential(
    app: tauri::AppHandle,
    state: tauri::State<'_, DictationHandle>,
) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        credential::clear();
        state.refresh(&app);
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, state);
        Ok(())
    }
}

/// The HUD's current state. The persistent window calls this once on mount so
/// it does not depend on winning a race with its first event. A couple of cheap
/// synchronous reads behind one mutex, so this one stays non-async.
#[cfg(any(windows, target_os = "macos"))]
#[tauri::command]
pub fn dictation_hud_state() -> hud::HudUpdate {
    hud::last_update()
}

#[cfg(any(windows, target_os = "macos"))]
#[tauri::command]
pub fn dictation_set_hud_hovered(app: tauri::AppHandle, hovered: bool) {
    hud::set_hovered(&app, hovered);
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn show_hud(app: &tauri::AppHandle) {
    hud::show_idle(app);
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn refresh_hud_placement(app: &tauri::AppHandle) {
    hud::refresh_placement(app);
}

/// Mutual exclusivity with the Buddy agent overlay: called from
/// `overlay::apply_result` on every real presentation transition.
#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn set_overlay_visible(app: &tauri::AppHandle, visible: bool) {
    hud::set_overlay_suppressed(app, visible);
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn show_hud(_app: &tauri::AppHandle) {}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn refresh_hud_placement(_app: &tauri::AppHandle) {}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn set_overlay_visible(_app: &tauri::AppHandle, _visible: bool) {}

#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub fn dictation_hud_state() -> DictationStatus {
    DictationStatus::unavailable(NOT_SUPPORTED)
}

#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub fn dictation_set_hud_hovered(_hovered: bool) {}

/// The user's saved biasing phrases, split into the global list and the
/// per-app lists keyed by exe stem.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyView {
    pub global: Vec<String>,
    pub apps: std::collections::HashMap<String, Vec<String>>,
}

#[cfg(not(any(windows, target_os = "macos")))]
const NOT_SUPPORTED: &str = "Dictation is available on Windows and macOS only.";

#[tauri::command]
pub async fn dictation_vocabulary(app: tauri::AppHandle) -> Result<VocabularyView, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let store = vocab::load_vocab(&app)?;
        Ok(VocabularyView {
            global: store.global,
            apps: store.apps,
        })
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Err(NOT_SUPPORTED.to_string())
    }
}

/// Adds biasing phrases, globally when `appKey` is omitted. Returns how many
/// were newly stored.
#[tauri::command]
pub async fn dictation_add_vocabulary(
    app: tauri::AppHandle,
    app_key: Option<String>,
    phrases: Vec<String>,
) -> Result<usize, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        vocab::add_phrases(&app, app_key.as_deref(), &phrases)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, app_key, phrases);
        Err(NOT_SUPPORTED.to_string())
    }
}

/// AI-formatting settings for the dashboard page, plus the credential push
/// from the webview's refresh pump. Registered in `lib.rs` by their full path
/// (`dictation::polish_commands::*`) rather than re-exported:
/// `#[tauri::command]` generates companion items alongside each function that
/// `generate_handler!` resolves by module path, so a plain `pub use` of the
/// functions alone leaves those behind.
pub mod polish_commands {
    use serde::Serialize;

    use super::polish;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PolishSettingsView {
        pub enabled: bool,
    }

    impl PolishSettingsView {
        fn build(app: &tauri::AppHandle) -> Self {
            let settings = polish::handle(app)
                .map(|handle| handle.snapshot())
                .unwrap_or_default();
            Self {
                enabled: settings.enabled,
            }
        }
    }

    #[tauri::command]
    pub async fn dictation_polish_settings(
        app: tauri::AppHandle,
    ) -> Result<PolishSettingsView, String> {
        Ok(PolishSettingsView::build(&app))
    }

    /// Saves the opt-in. Returns what was actually stored.
    #[tauri::command]
    pub async fn dictation_set_polish_settings(
        app: tauri::AppHandle,
        enabled: bool,
    ) -> Result<PolishSettingsView, String> {
        let next = polish::PolishSettings { enabled };
        let blocking_app = app.clone();
        let saved =
            tauri::async_runtime::spawn_blocking(move || polish::save_settings(&blocking_app, next))
                .await
                .map_err(|e| e.to_string())??;
        if let Some(handle) = polish::handle(&app) {
            handle.apply_settings(saved);
        }
        Ok(PolishSettingsView::build(&app))
    }

    /// A fresh Firebase ID token from the webview, held in RAM only. Mirrors
    /// `dictation_set_credential` for transcription.
    #[tauri::command]
    pub async fn dictation_set_polish_credential(
        app: tauri::AppHandle,
        id_token: String,
        ttl_seconds: u32,
    ) -> Result<(), String> {
        if let Some(handle) = polish::handle(&app) {
            handle.set_token(id_token, std::time::Duration::from_secs(ttl_seconds.into()));
        }
        Ok(())
    }

    /// Drops the token on sign-out.
    #[tauri::command]
    pub async fn dictation_clear_polish_credential(app: tauri::AppHandle) -> Result<(), String> {
        if let Some(handle) = polish::handle(&app) {
            handle.clear_token();
        }
        Ok(())
    }
}

/// Records one confirmed correction. It only starts being applied once the same
/// pair has been confirmed three times.
#[tauri::command]
pub async fn dictation_record_correction(
    app: tauri::AppHandle,
    heard: String,
    replacement: String,
) -> Result<u32, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        vocab::record_correction(&app, &heard, &replacement)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, heard, replacement);
        Err(NOT_SUPPORTED.to_string())
    }
}
