//! Hold-to-talk dictation.
//!
//! Hold the chord (`chord::DICTATION_CHORD`, "Ctrl + Win" by default), speak,
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
//! Logging discipline (copied from meeting/audio.rs): counts, durations, byte
//! sizes and outcomes only. Never a transcript, a partial, a hotword, or a
//! correction, at any level. redact.rs runs on the log READ path only
//! (logging.rs:99) and its rules are key=value/JWT shaped, so free-form prose
//! would sail straight through it.

pub mod chord;

#[cfg(windows)]
mod asr;
#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod consent;
#[cfg(windows)]
mod credential;
#[cfg(windows)]
mod hud;
#[cfg(windows)]
mod insert;
#[cfg(windows)]
pub mod trace;
#[cfg(windows)]
mod usage;
#[cfg(windows)]
mod vocab;

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
}

impl DictationStatus {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            chord_label: DICTATION_CHORD.label(),
            reason: Some(reason.into()),
            biasing_available: false,
        }
    }
}

#[cfg(windows)]
pub use platform::{is_capturing, is_holding_text, signal, start, DictationHandle};

#[cfg(windows)]
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
    use super::hud::{self, HudPhase, HudUpdate};
    use super::insert::{self, InsertOutcome};
    use super::trace;
    use super::usage;
    use super::vocab;
    use super::{DictationStatus, DICTATION_CHORD};

    /// How long a terminal caption (inserted, or a failure explanation) stays
    /// on screen before the HUD hides itself.
    const CAPTION_LINGER: Duration = Duration::from_millis(2200);
    const FAILURE_LINGER: Duration = Duration::from_millis(4000);
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
    /// Budget for draining the packet WASAPI still holds when the chord comes
    /// up. Without it a user who releases the instant they stop speaking loses
    /// the last word.
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

    /// True from the moment a hold is armed until its text has been dealt with.
    ///
    /// Read by the training-trace worker so a background observation never
    /// claims the UI Automation apartment while the user is mid-utterance. The
    /// probe on the insert path already fails open to "type anyway", so this is
    /// not a correctness guard - it just stops the two features from routinely
    /// racing when there is no reason for them to.
    pub fn is_capturing() -> bool {
        CHORD_ACTIVE.load(Ordering::Relaxed)
    }

    static CHORD_ACTIVE: std::sync::atomic::AtomicBool =
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
    ///
    /// `raw` rides along unused on the normal path: it exists so that text
    /// which eventually lands in a text box the user clicked into is as
    /// complete a training trace as text that landed immediately. It is empty
    /// when trace capture is off.
    struct PendingPayload {
        text: String,
        samples: Vec<f32>,
        raw: String,
        app_hint: Option<String>,
    }

    struct PendingText {
        text: String,
        samples: Vec<f32>,
        raw: String,
        app_hint: Option<String>,
        expires_at: Instant,
        /// The HUD generation of the hold that produced it, so the closing
        /// caption cannot be hidden by a stale timer from an earlier utterance.
        generation: u64,
    }

    impl PendingText {
        fn new(payload: PendingPayload) -> Self {
            Self {
                text: payload.text,
                samples: payload.samples,
                raw: payload.raw,
                app_hint: payload.app_hint,
                expires_at: Instant::now() + PENDING_WINDOW,
                generation: HUD_GENERATION.load(Ordering::SeqCst),
            }
        }
    }

    /// Hands one finished utterance to the training-trace worker.
    ///
    /// Everything expensive about a trace - the UI Automation round trip that
    /// confirms where the text landed, the WAV encode, encryption, the index
    /// write - happens on that worker, so all this costs the dictation thread
    /// is building a struct and a channel send. The samples are moved, never
    /// copied.
    ///
    /// Per-token timings are no longer captured. The on-device decoder exposed
    /// them for free alongside the result it had already computed; asking the
    /// cloud provider for word timings would mean requesting, receiving and
    /// storing MORE speech-derived data than the transcript itself, on a
    /// path whose whole point is to send as little as possible. The trace
    /// still carries the audio, the raw transcript, the corrected text and
    /// where it landed, which is what the correction pass actually learns from.
    fn hand_to_trace(
        app: &AppHandle,
        raw: &str,
        inserted: &str,
        samples: Vec<f32>,
        app_hint: Option<String>,
    ) {
        let Some(handle) = trace::handle(app) else {
            return;
        };
        handle.capture(trace::Utterance {
            typed_at: Instant::now(),
            raw_transcript: raw.to_string(),
            inserted_text: inserted.to_string(),
            locally_corrected: raw != inserted,
            tokens: Vec::new(),
            samples,
            app_hint,
        });
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
    fn advance_pending(app: &AppHandle, mut held: PendingText) -> Option<PendingText> {
        // The baseline has to exist BEFORE the keystrokes, and this tick is the
        // only place that knows an insert is about to happen, so it is read on
        // every probe while text is held rather than only on the tick that
        // lands. That is a few milliseconds every 250ms for at most the ten
        // second holding window, and only while trace capture is on.
        let tracing = trace::wants_anchor(app);
        // Only a CONFIDENT yes lands the text. Unknown deliberately does not:
        // on the insert path Unknown means "type, refusing is worse", but here
        // the user has already been told the text is waiting for a text box,
        // and dropping it into an ambiguous pane instead would be exactly the
        // surprise this whole path exists to avoid.
        let probe = crate::uia::probe_focus(app, tracing);
        if matches!(probe.verdict, crate::uia::FocusVerdict::Typable) {
            match insert::insert_text_here(&held.text) {
                InsertOutcome::Inserted => {
                    info!(
                        "dictation: held text landed role={} chars={}",
                        probe.role,
                        held.text.chars().count()
                    );
                    if tracing {
                        hand_to_trace(
                            app,
                            &held.raw,
                            &held.text,
                            std::mem::take(&mut held.samples),
                            held.app_hint.clone(),
                        );
                    }
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

    /// Drops held text without typing it, and says so. The transcript itself is
    /// never logged, only the reason.
    fn discard_pending(app: &AppHandle, held: PendingText, reason: &str) {
        info!(
            "dictation: held text discarded ({reason}) chars={} frames={}",
            held.text.chars().count(),
            held.samples.len()
        );
        finish_with(
            app,
            held.generation,
            HudUpdate::new(HudPhase::Error)
                .with_message("No text box, so nothing was typed."),
            FAILURE_LINGER,
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
        CHORD_ACTIVE.store(true, Ordering::Relaxed);
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
        CHORD_ACTIVE.store(false, Ordering::Relaxed);
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
                // Kept for the opt-in training trace only. The provider already
                // has this audio; nothing downstream re-transcribes it.
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
        let final_text =
            vocab::apply_corrections(&decoded, &corrections, &vocabulary, app_key.as_deref());

        // Opt-in, default off. Read ONCE here so every later decision in this
        // utterance agrees about whether it is being traced, even if the user
        // toggles the setting while the words are being typed.
        let tracing = trace::wants_anchor(app);

        // Asked here, at the last possible moment, because this is the only
        // point at which "where would these keystrokes go" has its final
        // answer. Bounded and fails open; see uia/focus.rs. When tracing is on
        // this same round trip also reads the field's "before" text, so
        // verifying where the keystrokes landed costs no extra call in front of
        // them.
        let probe = crate::uia::probe_focus(app, tracing);
        let outcome = insert::insert_text(&final_text, target, probe.verdict);
        info!(
            "dictation: phase=insert hold_ms={hold_ms} frames={captured_frames} chars={} role={} \
             verdict={:?} outcome={outcome:?}",
            final_text.chars().count(),
            probe.role,
            probe.verdict
        );

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
            *held = Some(PendingPayload {
                text: final_text,
                samples: utterance,
                raw: decoded,
                app_hint: app_key,
            });
            return shutting_down;
        }

        // Training-trace capture, only on a real insert and only when the user
        // switched it on. `mem::take` rather than a move because the compiler
        // cannot see that the branch above already returned; the buffer is
        // never read again on this path either way.
        if tracing && matches!(outcome, InsertOutcome::Inserted) {
            hand_to_trace(
                app,
                &decoded,
                &final_text,
                std::mem::take(&mut utterance),
                app_key,
            );
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
                HudUpdate::new(HudPhase::Error)
                    .with_text(final_text)
                    .with_message("Focus changed, so nothing was typed."),
                FAILURE_LINGER,
            ),
            InsertOutcome::KeysHeld => (
                HudUpdate::new(HudPhase::Error)
                    .with_text(final_text)
                    .with_message(format!(
                        "Release {} and dictate again.",
                        DICTATION_CHORD.label()
                    )),
                FAILURE_LINGER,
            ),
            InsertOutcome::Blocked => (
                HudUpdate::new(HudPhase::Error)
                    .with_text(final_text)
                    .with_message(
                        "Windows blocked typing into that window because it runs as administrator.",
                    ),
                FAILURE_LINGER,
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

#[cfg(not(windows))]
pub use stub::{signal, start, DictationHandle};

#[cfg(not(windows))]
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

    pub fn start(_app: AppHandle) -> DictationHandle {
        DictationHandle {
            status: DictationStatus::unavailable("Dictation is available on Windows only."),
        }
    }
}

#[tauri::command]
pub fn dictation_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, DictationHandle>,
) -> DictationStatus {
    state.refresh(&app);
    #[cfg(windows)]
    {
        with_listener_health(&app, state.status())
    }
    #[cfg(not(windows))]
    {
        state.status()
    }
}

#[cfg(windows)]
const LISTENER_UNAVAILABLE_REASON: &str =
    "Keyboard listener unavailable. Restart Aura. If this continues, another security tool may be blocking keyboard access.";

/// Appends the listener's OWN failure text to the guidance above. The four
/// install failures in `voice_toggle_key::platform::start` are already logged
/// and sent to Sentry, but the UI flattened all of them into one sentence, so
/// the one question a support report needs to answer - WHICH step failed -
/// was the only thing the user could not see.
#[cfg(windows)]
fn listener_unavailable_reason(detail: Option<String>) -> String {
    match detail {
        Some(detail) if !detail.trim().is_empty() => {
            format!("{LISTENER_UNAVAILABLE_REASON} (Details: {})", detail.trim())
        }
        _ => LISTENER_UNAVAILABLE_REASON.to_string(),
    }
}

#[cfg(windows)]
static LAST_EMITTED_STATUS: std::sync::OnceLock<std::sync::Mutex<Option<DictationStatus>>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn with_listener_health(app: &tauri::AppHandle, mut status: DictationStatus) -> DictationStatus {
    if let Some(listener) = app.try_state::<crate::voice_toggle_key::VoiceToggleKeyHandle>() {
        let listener_status = listener.status();
        if !listener_status.available {
            status.available = false;
            status.reason = Some(listener_unavailable_reason(listener_status.reason));
            status.biasing_available = false;
        }
    }
    status
}

#[cfg(windows)]
pub fn emit_status_changed(app: &tauri::AppHandle) {
    let Some(handle) = app.try_state::<DictationHandle>() else { return };
    let next = with_listener_health(app, handle.status());
    let last = LAST_EMITTED_STATUS.get_or_init(|| std::sync::Mutex::new(None));
    let mut previous = last.lock().unwrap_or_else(|error| error.into_inner());
    if previous.as_ref() == Some(&next) {
        return;
    }
    *previous = Some(next.clone());
    let _ = app.emit("dictation-status-changed", next);
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
    #[cfg(windows)]
    {
        let Some(uid) = crate::security::current_uid(&app) else {
            return Ok(Vec::new());
        };
        tauri::async_runtime::spawn_blocking(move || usage::entries(&app, &uid))
            .await
            .map_err(|error| format!("dictation usage task failed: {error}"))?
    }
    #[cfg(not(windows))]
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
    #[cfg(windows)]
    {
        Ok(ConsentState {
            accepted: consent::is_accepted(&app),
        })
    }
    #[cfg(not(windows))]
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
    #[cfg(windows)]
    {
        log::info!("dictation: consent answered accepted={accepted}");
        let accepted = consent::set_accepted(&app, accepted)?;
        state.refresh(&app);
        // Take the prompt off screen the moment it is answered, rather than
        // leaving the user looking at a question they have already resolved.
        hud::publish(&app, hud::HudUpdate::new(hud::HudPhase::Idle));
        Ok(ConsentState { accepted })
    }
    #[cfg(not(windows))]
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
    #[cfg(windows)]
    {
        if access_token.trim().is_empty() {
            return Err("the dictation credential is empty".to_string());
        }
        credential::set(access_token, std::time::Duration::from_secs(ttl_seconds));
        state.refresh(&app);
        Ok(())
    }
    #[cfg(not(windows))]
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
    #[cfg(windows)]
    {
        credential::clear();
        state.refresh(&app);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state);
        Ok(())
    }
}

/// The HUD's current state. The persistent window calls this once on mount so
/// it does not depend on winning a race with its first event. A couple of cheap
/// synchronous reads behind one mutex, so this one stays non-async.
#[cfg(windows)]
#[tauri::command]
pub fn dictation_hud_state() -> hud::HudUpdate {
    hud::last_update()
}

#[cfg(windows)]
#[tauri::command]
pub fn dictation_set_hud_hovered(app: tauri::AppHandle, hovered: bool) {
    hud::set_hovered(&app, hovered);
}

#[cfg(windows)]
pub(crate) fn show_hud(app: &tauri::AppHandle) {
    hud::show_idle(app);
}

#[cfg(windows)]
pub(crate) fn refresh_hud_placement(app: &tauri::AppHandle) {
    hud::refresh_placement(app);
}

/// Mutual exclusivity with the Buddy agent overlay: called from
/// `overlay::apply_result` on every real presentation transition.
#[cfg(windows)]
pub(crate) fn set_overlay_visible(app: &tauri::AppHandle, visible: bool) {
    hud::set_overlay_suppressed(app, visible);
}

#[cfg(not(windows))]
pub(crate) fn show_hud(_app: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub(crate) fn refresh_hud_placement(_app: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub(crate) fn set_overlay_visible(_app: &tauri::AppHandle, _visible: bool) {}

#[cfg(not(windows))]
#[tauri::command]
pub fn dictation_hud_state() -> DictationStatus {
    DictationStatus::unavailable(NOT_SUPPORTED)
}

#[cfg(not(windows))]
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

#[cfg(not(windows))]
const NOT_SUPPORTED: &str = "Dictation is available on Windows only.";

#[tauri::command]
pub async fn dictation_vocabulary(app: tauri::AppHandle) -> Result<VocabularyView, String> {
    #[cfg(windows)]
    {
        let store = vocab::load_vocab(&app)?;
        Ok(VocabularyView {
            global: store.global,
            apps: store.apps,
        })
    }
    #[cfg(not(windows))]
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
    #[cfg(windows)]
    {
        vocab::add_phrases(&app, app_key.as_deref(), &phrases)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, app_key, phrases);
        Err(NOT_SUPPORTED.to_string())
    }
}

// ---------------------------------------------------------------------------
// Training-trace capture (Settings > Dictation > Improve recognition).
//
// Every command here is deliberately WITHOUT a `security::Operation`, for the
// reason the module header gives: dictation has to work signed out, offline,
// on first launch, before any account exists, and so does the switch that
// controls what it records about itself. The data never leaves the machine, so
// there is no session for an authorization check to protect.
//
// All async, per the main-thread-blocking rule at the top of CLAUDE.md: every
// one of these touches the filesystem, and several decrypt as they go.
// ---------------------------------------------------------------------------

/// Whether the upload pump has anything to do, and how much.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePumpState {
    pub sharing: bool,
    pub pending_uploads: usize,
    pub pending_deletions: usize,
}

/// The settings, plus the ceilings the user does not set, so the page can
/// explain what "and then it stops growing" means without hardcoding numbers
/// that would drift out of step with the Rust side.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSettingsView {
    pub enabled: bool,
    pub capture_audio: bool,
    pub retention_days: u32,
    pub excluded_apps: Vec<String>,
    pub max_traces: usize,
    pub max_audio_bytes: u64,
    /// Where an export would be written, so the button can say so before
    /// anyone commits to writing one.
    pub export_directory: Option<String>,
    /// Uploading settled traces to Aura. A separate decision from `enabled`;
    /// see `trace::settings`.
    pub sharing_enabled: bool,
    /// Which consent text the user accepted, and which one is current. When
    /// they differ the UI must re-ask rather than carry the old consent
    /// forward.
    pub consent_version: u32,
    pub current_consent_version: u32,
}

/// Registered in `lib.rs` by their full path (`dictation::trace_commands::*`)
/// rather than re-exported: `#[tauri::command]` generates companion items
/// alongside each function that `generate_handler!` resolves by module path, so
/// a plain `pub use` of the functions alone leaves those behind.
#[cfg(windows)]
pub mod trace_commands {
    use super::{trace, SharePumpState, TraceSettingsView};

    fn require_current_owner(app: &tauri::AppHandle, owner_uid: &str) -> Result<(), String> {
        if crate::security::current_uid(app).as_deref() == Some(owner_uid) {
            Ok(())
        } else {
            Err("dictation upload account changed".to_string())
        }
    }

    impl TraceSettingsView {
        fn build(app: &tauri::AppHandle, settings: trace::settings::TraceSettings) -> Self {
            Self {
                enabled: settings.enabled,
                capture_audio: settings.capture_audio,
                retention_days: settings.retention_days,
                excluded_apps: settings.excluded_apps,
                max_traces: trace::settings::MAX_TRACES,
                max_audio_bytes: trace::settings::MAX_AUDIO_BYTES,
                export_directory: trace::export::export_root(app)
                    .map(|path| path.to_string_lossy().to_string()),
                sharing_enabled: settings.sharing_enabled,
                consent_version: settings.consent_version,
                current_consent_version: trace::settings::CONSENT_VERSION,
            }
        }
    }

    /// The current opt-in state and retention policy.
    #[tauri::command]
    pub async fn dictation_trace_settings(
        app: tauri::AppHandle,
    ) -> Result<TraceSettingsView, String> {
        let settings = trace::handle(&app)
            .map(|handle| handle.snapshot())
            .unwrap_or_default();
        Ok(TraceSettingsView::build(&app, settings))
    }

    /// Saves the opt-in state. Returns what was actually stored after clamping,
    /// so the UI renders the truth rather than what it asked for.
    #[tauri::command]
    pub async fn dictation_set_trace_settings(
        app: tauri::AppHandle,
        enabled: bool,
        capture_audio: bool,
        retention_days: u32,
        excluded_apps: Vec<String>,
        sharing_enabled: bool,
    ) -> Result<TraceSettingsView, String> {
        let next = trace::settings::TraceSettings {
            enabled,
            capture_audio,
            retention_days,
            excluded_apps,
            sharing_enabled,
            // Turning sharing on here IS the act of consenting, so the current
            // version is stamped on. `sanitized` clears it again if capture is
            // off, so a sharing flag can never outlive the thing it shares.
            consent_version: if sharing_enabled {
                trace::settings::CONSENT_VERSION
            } else {
                0
            },
        };
        let blocking_app = app.clone();
        let saved =
            tauri::async_runtime::spawn_blocking(move || trace::settings::save(&blocking_app, next))
                .await
                .map_err(|e| e.to_string())??;
        if let Some(handle) = trace::handle(&app) {
            handle.apply(saved.clone());
        }
        Ok(TraceSettingsView::build(&app, saved))
    }

    /// Counts and storage size for the settings page's summary line.
    #[tauri::command]
    pub async fn dictation_trace_summary(
        app: tauri::AppHandle,
    ) -> Result<trace::record::TraceSummary, String> {
        tauri::async_runtime::spawn_blocking(move || trace::store::summary(&app))
            .await
            .map_err(|e| e.to_string())?
    }

    /// The traces themselves, newest first, for review.
    #[tauri::command]
    pub async fn dictation_trace_list(
        app: tauri::AppHandle,
        limit: Option<usize>,
    ) -> Result<Vec<trace::record::TraceRecord>, String> {
        let limit = limit.unwrap_or(100).min(500);
        tauri::async_runtime::spawn_blocking(move || trace::store::list(&app, limit))
            .await
            .map_err(|e| e.to_string())?
    }

    /// One trace's audio, as WAV bytes.
    ///
    /// Returned as a raw IPC response rather than base64, following
    /// `saved_images::read_saved_image`: the webview reads it as an
    /// `ArrayBuffer` and hands it straight to a Blob URL with no encode/decode
    /// round trip.
    #[tauri::command]
    pub async fn dictation_trace_audio(
        app: tauri::AppHandle,
        trace_id: String,
    ) -> Result<tauri::ipc::Response, String> {
        tauri::async_runtime::spawn_blocking(move || {
            trace::store::read_audio(&app, &trace_id).map(tauri::ipc::Response::new)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Deletes one trace and its audio.
    #[tauri::command]
    pub async fn dictation_delete_trace(
        app: tauri::AppHandle,
        trace_id: String,
    ) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || trace::store::delete(&app, &trace_id))
            .await
            .map_err(|e| e.to_string())?
    }

    /// Deletes every stored trace. The dictation vocabulary and its key live in
    /// the parent directory and are deliberately untouched, so wiping the
    /// training corpus never costs the user the vocabulary they built up.
    #[tauri::command]
    pub async fn dictation_delete_all_traces(app: tauri::AppHandle) -> Result<usize, String> {
        tauri::async_runtime::spawn_blocking(move || trace::store::delete_all(&app))
            .await
            .map_err(|e| e.to_string())?
    }

    // --- Sharing queue.
    //
    // Rust owns the queue; JavaScript performs the HTTP, because the Firebase ID
    // token lives in the JS SDK. Meeting segments upload the same way
    // (`useMeetingCapture.ts` claims a lease, calls `authFetch`, resolves it),
    // and this follows that split rather than inventing a second one.

    /// What the pump needs to decide whether to do anything at all this tick.
    ///
    /// One cheap call instead of claiming blindly: with sharing off and nothing
    /// owed, the pump does a single read and goes back to sleep rather than
    /// decrypting the index and encoding audio to discover there is no work.
    ///
    /// `pendingDeletions` is reported even when sharing is off, because revoking
    /// consent is precisely the case where deletes are owed and uploads are not.
    #[tauri::command]
    pub async fn dictation_share_pump_state(
        app: tauri::AppHandle,
    ) -> Result<SharePumpState, String> {
        let sharing = trace::handle(&app).is_some_and(|handle| handle.shares());
        let summary = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            move || trace::store::summary(&app)
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(SharePumpState {
            sharing,
            pending_uploads: summary.pending_share,
            pending_deletions: summary.pending_deletions,
        })
    }

    /// The next trace due for upload, or null when the queue is empty, sharing
    /// is off, or everything is waiting out a backoff.
    #[tauri::command]
    pub async fn dictation_claim_trace_upload(
        app: tauri::AppHandle,
        owner_uid: String,
    ) -> Result<Option<trace::upload::TraceUploadLease>, String> {
        require_current_owner(&app, &owner_uid)?;
        let Some(settings) = trace::handle(&app).map(|handle| handle.snapshot()) else {
            return Ok(None);
        };
        tauri::async_runtime::spawn_blocking(move || {
            require_current_owner(&app, &owner_uid)?;
            let lease = trace::upload::claim(&app, &settings, &owner_uid)?;
            require_current_owner(&app, &owner_uid)?;
            Ok(lease)
        })
            .await
            .map_err(|e| e.to_string())?
    }

    /// The FLAC body for a claimed trace, as raw IPC bytes.
    #[tauri::command]
    pub async fn dictation_trace_upload_audio(
        app: tauri::AppHandle,
        trace_id: String,
        owner_uid: String,
    ) -> Result<tauri::ipc::Response, String> {
        require_current_owner(&app, &owner_uid)?;
        tauri::async_runtime::spawn_blocking(move || {
            require_current_owner(&app, &owner_uid)?;
            let bytes = trace::upload::audio_body(&app, &trace_id, &owner_uid)?;
            require_current_owner(&app, &owner_uid)?;
            Ok(tauri::ipc::Response::new(bytes))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Both halves reached the server.
    #[tauri::command]
    pub async fn dictation_resolve_trace_upload(
        app: tauri::AppHandle,
        trace_id: String,
        owner_uid: String,
    ) -> Result<(), String> {
        require_current_owner(&app, &owner_uid)?;
        tauri::async_runtime::spawn_blocking(move || {
            require_current_owner(&app, &owner_uid)?;
            trace::upload::resolve(&app, &trace_id, &owner_uid)
        })
            .await
            .map_err(|e| e.to_string())?
    }

    /// The attempt failed. `retryable` false means it will never succeed on its
    /// own (rejected payload, digest conflict) and the trace is abandoned.
    #[tauri::command]
    pub async fn dictation_fail_trace_upload(
        app: tauri::AppHandle,
        trace_id: String,
        owner_uid: String,
        retryable: bool,
    ) -> Result<(), String> {
        require_current_owner(&app, &owner_uid)?;
        tauri::async_runtime::spawn_blocking(move || {
            require_current_owner(&app, &owner_uid)?;
            trace::upload::fail(&app, &trace_id, &owner_uid, retryable)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// The next server-side delete still owed, if any. Stays queued until
    /// `dictation_resolve_trace_deletion` confirms it, so a crash mid-request
    /// retries rather than dropping the obligation.
    #[tauri::command]
    pub async fn dictation_claim_trace_deletion(
        app: tauri::AppHandle,
        owner_uid: String,
    ) -> Result<Option<String>, String> {
        require_current_owner(&app, &owner_uid)?;
        tauri::async_runtime::spawn_blocking(move || {
            require_current_owner(&app, &owner_uid)?;
            let trace_id = trace::store::claim_tombstone(&app, &owner_uid)?;
            require_current_owner(&app, &owner_uid)?;
            Ok(trace_id)
        })
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn dictation_resolve_trace_deletion(
        app: tauri::AppHandle,
        trace_id: String,
        owner_uid: String,
    ) -> Result<(), String> {
        require_current_owner(&app, &owner_uid)?;
        tauri::async_runtime::spawn_blocking(move || {
            require_current_owner(&app, &owner_uid)?;
            trace::store::resolve_tombstone(&app, &trace_id, &owner_uid)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Persists a backend-provided monthly reset for this account. False means
    /// the timestamp was unusable and the caller must apply normal backoff.
    #[tauri::command]
    pub async fn dictation_pause_trace_uploads(
        app: tauri::AppHandle,
        owner_uid: String,
        blocked_until_ms: i64,
    ) -> Result<bool, String> {
        require_current_owner(&app, &owner_uid)?;
        tauri::async_runtime::spawn_blocking(move || {
            require_current_owner(&app, &owner_uid)?;
            trace::upload::pause_for_quota(&app, &owner_uid, blocked_until_ms)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Writes a NeMo-compatible dataset to the Downloads folder.
    #[tauri::command]
    pub async fn dictation_export_traces(
        app: tauri::AppHandle,
        include_audio: bool,
        only_verified: bool,
    ) -> Result<trace::export::ExportResult, String> {
        tauri::async_runtime::spawn_blocking(move || {
            trace::export::export(&app, include_audio, only_verified)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Everywhere but Windows there is no recognizer, so there is nothing to
/// improve and nothing stored to review. Same shape as `dictation_hud_state`'s
/// two definitions: one name per platform, registered once in `lib.rs`.
#[cfg(not(windows))]
pub mod trace_commands {
    use super::{SharePumpState, TraceSettingsView, NOT_SUPPORTED};

    #[tauri::command]
    pub async fn dictation_share_pump_state() -> Result<SharePumpState, String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_trace_settings() -> Result<TraceSettingsView, String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_set_trace_settings() -> Result<TraceSettingsView, String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_trace_summary() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_trace_list() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_trace_audio() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_delete_trace() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_delete_all_traces() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_export_traces() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_claim_trace_upload() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_trace_upload_audio() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_resolve_trace_upload() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_fail_trace_upload() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_claim_trace_deletion() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_resolve_trace_deletion() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn dictation_pause_trace_uploads() -> Result<(), String> {
        Err(NOT_SUPPORTED.to_string())
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
    #[cfg(windows)]
    {
        vocab::record_correction(&app, &heard, &replacement)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, heard, replacement);
        Err(NOT_SUPPORTED.to_string())
    }
}
