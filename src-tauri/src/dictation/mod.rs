//! Local hold-to-talk dictation.
//!
//! Hold the chord (`chord::DICTATION_CHORD`, "Ctrl + Win" by default), speak,
//! release, and the words are typed into whatever application had focus before
//! the keys went down. Completely separate from the screen-aware voice buddy:
//! no LiveKit, no OpenAI, no backend call, no clipboard, no analytics, and no
//! speech-bearing crash report. Transcription runs entirely on-device against a
//! model that ships with the installer.
//!
//! WHY THERE IS NO `security::Operation` FOR THIS, and why that is correct:
//! every operation in security.rs requires a signed-in session and most also
//! require a live voice call (security.rs:181-244). Dictation is the one
//! feature that has to work signed out, offline, on first launch, before any
//! account exists. Gating it would break exactly the case it exists for. Do not
//! "harden" this by adding an Operation variant. The privacy posture is upheld
//! by the data path instead: audio never leaves this process, the transcript
//! never touches disk unencrypted, nothing here is logged at any level, and
//! sentry_setup.rs drops any event that originates in this module.
//!
//! Logging discipline (copied from meeting/audio.rs): counts, durations, byte
//! sizes and outcomes only. Never a transcript, a partial, a hotword, or a
//! correction, at any level. redact.rs runs on the log READ path only
//! (logging.rs:99) and its rules are key=value/JWT shaped, so free-form prose
//! would sail straight through it.

pub mod chord;

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod hud;
#[cfg(windows)]
mod insert;
#[cfg(windows)]
mod stt;
#[cfg(windows)]
pub mod trace;
#[cfg(windows)]
mod vocab;

use serde::Serialize;

pub use chord::DICTATION_CHORD;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    /// The on-device recognizer loaded and a hold will actually transcribe.
    pub available: bool,
    /// Rendered verbatim in every user-facing surface.
    pub chord_label: &'static str,
    /// Why it is unavailable, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Tier 0 contextual biasing is usable in this install.
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
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use log::{error, info, warn};
    use tauri::path::BaseDirectory;
    use tauri::{AppHandle, Manager};

    use super::audio::{self, Capture};
    use super::chord::ChordSignal;
    use super::hud::{self, HudPhase, HudUpdate};
    use super::insert::{self, InsertOutcome};
    use super::stt::{Recognizer, Stream, MODEL_ID, STREAMING_CHUNK_SAMPLES};
    use super::trace;
    use super::vocab;
    use super::{DictationStatus, DICTATION_CHORD};

    /// How often a partial is pushed at the HUD while the chord is held. Slow
    /// enough that the webview is never the bottleneck, fast enough that the
    /// caption reads as live.
    const PARTIAL_EVERY: Duration = Duration::from_millis(320);
    /// How long a terminal caption (inserted, or a failure explanation) stays
    /// on screen before the HUD hides itself.
    const CAPTION_LINGER: Duration = Duration::from_millis(2200);
    const FAILURE_LINGER: Duration = Duration::from_millis(4000);
    /// How long a hold that ended before the model finished loading keeps
    /// waiting for the in-flight load. Only paid on a cold hold when the user
    /// out-typed the loader; the buffered audio
    /// is decoded the moment the recognizer lands, so a short first utterance on
    /// a slow machine is transcribed instead of thrown away.
    const LOAD_GRACE: Duration = Duration::from_secs(30);
    /// A successfully used recognizer remains warm for one minute, then is
    /// destroyed on this worker thread so its model memory can be reclaimed.
    const MODEL_IDLE: Duration = Duration::from_secs(60);
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
    /// Named so logging.rs's panic hook can recognize it and refuse to format
    /// a panic payload raised there.
    pub const MODEL_THREAD: &str = "aura-dictation-model";

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

        let status = Arc::new(Mutex::new(DictationStatus::unavailable(
            "the on-device recognizer is still loading",
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

    /// Where the predownload script put the shared library and the model.
    fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .resolve("resources/dictation", BaseDirectory::Resource)
            .map_err(|e| format!("could not resolve the dictation resources: {e}"))
    }

    /// The model, and whether a background load is in flight.
    ///
    /// Nothing is loaded at app startup. A user who never dictates never
    /// carries the recognizer's working set; the first time the chord is
    /// actually reached for, the load runs on its own one-shot thread while the
    /// worker is already capturing audio, so the first hold is not clipped
    /// either.
    #[derive(Default)]
    struct ModelState {
        recognizer: Option<Recognizer>,
        loading: Option<Receiver<Result<Recognizer, String>>>,
        load_started_at: Option<Instant>,
        unload_at: Option<Instant>,
        /// A load that failed is not retried for the rest of the session: it
        /// fails for a structural reason (missing resources, bad DLL) that
        /// retrying every hold would only turn into repeated stalls.
        failed: bool,
    }

    impl ModelState {
        fn begin_load(&mut self, app: &AppHandle, status: &Arc<Mutex<DictationStatus>>) {
            if self.recognizer.is_some() || self.loading.is_some() || self.failed {
                return;
            }
            let dir = match resource_dir(app) {
                Ok(dir) => dir,
                Err(e) => {
                    self.failed = true;
                    set_status(status, DictationStatus::unavailable(e));
                    return;
                }
            };
            let (tx, rx) = std::sync::mpsc::channel::<Result<Recognizer, String>>();
            self.load_started_at = Some(Instant::now());
            info!("dictation: model={MODEL_ID} phase=model_load state=started");
            let spawned = std::thread::Builder::new()
                .name(MODEL_THREAD.to_string())
                .spawn(move || {
                    let _ = tx.send(Recognizer::load(&dir));
                });
            match spawned {
                Ok(_) => self.loading = Some(rx),
                Err(e) => {
                    self.load_started_at = None;
                    self.failed = true;
                    set_status(
                        status,
                        DictationStatus::unavailable(format!(
                            "the model loader could not start: {e}"
                        )),
                    );
                }
            }
        }

        /// Collects a finished load without ever blocking the capture loop.
        fn poll(&mut self, status: &Arc<Mutex<DictationStatus>>) {
            let Some(rx) = self.loading.as_ref() else {
                return;
            };
            match rx.try_recv() {
                Ok(Ok(recognizer)) => {
                    let load_ms = self
                        .load_started_at
                        .take()
                        .map(|started| started.elapsed().as_millis())
                        .unwrap_or(0);
                    set_status(
                        status,
                        DictationStatus {
                            available: true,
                            chord_label: DICTATION_CHORD.label(),
                            reason: None,
                            biasing_available: recognizer.biasing_available(),
                        },
                    );
                    info!(
                        "dictation: model={MODEL_ID} phase=model_load state=ready load_ms={load_ms} biasing={}",
                        recognizer.biasing_available(),
                    );
                    self.recognizer = Some(recognizer);
                    self.unload_at = Some(Instant::now() + MODEL_IDLE);
                    self.loading = None;
                }
                Ok(Err(e)) => {
                    let load_ms = self
                        .load_started_at
                        .take()
                        .map(|started| started.elapsed().as_millis())
                        .unwrap_or(0);
                    warn!("dictation: model={MODEL_ID} phase=model_load failure=model_load load_ms={load_ms}: {e}");
                    set_status(status, DictationStatus::unavailable(e));
                    self.failed = true;
                    self.loading = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.load_started_at = None;
                    warn!("dictation: model={MODEL_ID} phase=model_load failure=loader_stopped");
                    set_status(
                        status,
                        DictationStatus::unavailable("the model loader stopped unexpectedly"),
                    );
                    self.failed = true;
                    self.loading = None;
                }
            }
        }

        fn ready(&self) -> Option<&Recognizer> {
            self.recognizer.as_ref()
        }

        /// A load is still in flight, so "not ready" means "not yet" rather
        /// than "not in this build". Only used to pick the HUD's wording.
        fn loading(&self) -> bool {
            self.loading.is_some()
        }

        fn mark_idle(&mut self) {
            if self.recognizer.is_some() {
                self.unload_at = Some(Instant::now() + MODEL_IDLE);
            }
        }

        fn unload_deadline(&self) -> Option<Instant> {
            self.unload_at.filter(|_| self.recognizer.is_some())
        }

        fn unload_if_due(&mut self) {
            if self
                .unload_deadline()
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                info!("dictation: model={MODEL_ID} phase=model_unload idle_ms={}", MODEL_IDLE.as_millis());
                self.recognizer = None;
                self.unload_at = None;
            }
        }
    }

    /// The dedicated worker. Everything expensive lives here and never on the
    /// thread that pumps the native window's messages: WASAPI, decoding, and
    /// the SendInput burst. The model load gets its own thread from here.
    fn worker_thread(
        app: AppHandle,
        rx: Receiver<Message>,
        status: Arc<Mutex<DictationStatus>>,
    ) {
        if wasapi::initialize_mta().is_err() {
            set_status(&status, DictationStatus::unavailable("COM init failed"));
            return;
        }

        // Startup does a file presence probe and nothing more. "available" here
        // means the bundled runtime and model are installed, not that they are
        // loaded; a later load failure replaces this with the real error.
        match resource_dir(&app).and_then(|dir| super::stt::resources_present(&dir)) {
            Ok(()) => {
                set_status(
                    &status,
                    DictationStatus {
                        available: true,
                        chord_label: DICTATION_CHORD.label(),
                        reason: None,
                        biasing_available: false,
                    },
                );
                info!("dictation: ready, chord={}", DICTATION_CHORD.label());
            }
            Err(e) => {
                warn!("dictation: resources unavailable: {e}");
                set_status(&status, DictationStatus::unavailable(e));
            }
        }

        let mut model = ModelState::default();
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
            let timeout = if pending.is_some() || failed.is_some() {
                Some(PROBE_TICK)
            } else {
                model
                    .unload_deadline()
                    .map(|deadline| deadline.saturating_duration_since(Instant::now()))
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
                model.poll(&status);
                model.unload_if_due();
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
                    // Windows "in use" indicator) and not the model either,
                    // whose 130 to 200MB working set would otherwise stay
                    // resident for the whole session after a stray drag by a
                    // user who never dictates.
                    //
                    // Both the device and the model start only once the FULL
                    // chord is down (`handle_arm`). The WASAPI cold start hides
                    // behind the 200 to 400ms a human takes before their first
                    // phoneme, and a model load that outruns a short first
                    // utterance is covered by LOAD_GRACE in `run_utterance`
                    // rather than by warming ahead of a guess.
                }
                Message::Chord(ChordSignal::Cancel) | Message::Chord(ChordSignal::Release) => {
                    // Either an abandoned prewarm, or a release with no matching
                    // arm. Drop the device so no "mic in use" indicator lingers.
                    capture = None;
                }
                Message::Chord(ChordSignal::Arm) => {
                    let mut held = None;
                    let shutting_down =
                        handle_arm(
                            &app,
                            &mut model,
                            &mut capture,
                            &rx,
                            &status,
                            &mut held,
                            &mut failed,
                        );
                    model.mark_idle();
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
    /// `raw` and `tokens` ride along unused on the normal path: they exist so
    /// that text which eventually lands in a text box the user clicked into is
    /// as complete a training trace as text that landed immediately. Both are
    /// empty when trace capture is off.
    struct PendingPayload {
        text: String,
        samples: Vec<f32>,
        raw: String,
        tokens: Vec<(String, f32)>,
        app_hint: Option<String>,
    }

    struct PendingText {
        text: String,
        samples: Vec<f32>,
        raw: String,
        tokens: Vec<(String, f32)>,
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
                tokens: payload.tokens,
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
    fn hand_to_trace(
        app: &AppHandle,
        raw: &str,
        inserted: &str,
        tokens: Vec<(String, f32)>,
        samples: Vec<f32>,
        app_hint: Option<String>,
    ) {
        let Some(handle) = trace::handle(app) else {
            return;
        };
        handle.capture(trace::Utterance {
            raw_transcript: raw.to_string(),
            inserted_text: inserted.to_string(),
            locally_corrected: raw != inserted,
            tokens: tokens
                .into_iter()
                .map(|(token, at_seconds)| trace::record::TokenTiming { token, at_seconds })
                .collect(),
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
            "dictation: model={MODEL_ID} phase=failure failure={category} frames={}",
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
                            std::mem::take(&mut held.tokens),
                            std::mem::take(&mut held.samples),
                            held.app_hint.clone(),
                        );
                    }
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
        model: &mut ModelState,
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
        let cold = model.ready().is_none();
        model.begin_load(app, status);
        // A panic inside one utterance must not take dictation down for the
        // rest of the session. The hook in logging.rs additionally refuses to
        // format a panic raised on this thread, so no payload that might carry
        // transcript text reaches the plaintext log.
        let shutting_down = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_utterance(app, model, capture, rx, status, held, failed, cold)
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
        *capture = None;
        CHORD_ACTIVE.store(false, Ordering::Relaxed);
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

    /// One hold, start to finish. Returns true when the process is shutting
    /// down and the worker loop should exit.
    fn run_utterance(
        app: &AppHandle,
        model: &mut ModelState,
        capture: &mut Option<Capture>,
        rx: &Receiver<Message>,
        status: &Arc<Mutex<DictationStatus>>,
        held: &mut Option<PendingPayload>,
        failed: &mut Option<FailedUtterance>,
        cold: bool,
    ) -> bool {
        let generation = HUD_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        // Snapshot the target BEFORE the HUD exists on screen, so nothing this
        // module does can change what "the app the user was in" means.
        let target = insert::foreground_window();
        let app_key = crate::system_control::process_stem_for_window(target);
        hud::show(app, target);
        hud::publish(app, HudUpdate::new(HudPhase::Listening));

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

        let started_at = Instant::now();
        info!("dictation: model={MODEL_ID} phase=capture cold={cold}");
        let mut last_partial = Instant::now();
        let mut last_level = Instant::now();
        let mut captured_frames = 0usize;
        let mut heard_speech = false;
        let mut shutting_down = false;
        let mut capped = false;
        let mut released = false;
        let mut utterance: Vec<f32> = Vec::new();
        let mut fed_samples = 0usize;
        let mut decode_time = Duration::ZERO;

        // Phase 1: warm-up. Only runs while a cold model load is in flight.
        // `model` is borrowed mutably here and only here.
        //
        // Releasing the chord in here does NOT end the utterance. On a slow
        // machine the very first dictation ("send it today") can be over before
        // the recognizer lands, and bailing out at that point would discard
        // every buffered sample and tell the user dictation is unavailable, for
        // the one hold most likely to be their first ever. So a release only
        // stops the capture and starts the LOAD_GRACE clock; the loop keeps
        // polling the loader and the buffered audio is decoded on arrival.
        let mut released_at: Option<Instant> = None;
        let mut capture_stopped = false;
        while model.ready().is_none() && !model.failed {
            // Signals are read only until the hold ends. Anything the user does
            // DURING the grace period (giving up and pressing the chord again,
            // most likely, since the HUD is still saying "getting ready") stays
            // queued for the worker loop to handle in order once this utterance
            // finishes, instead of being consumed here and dropped on the floor.
            if released_at.is_none() {
                match poll_signal(rx) {
                    Signal::Shutdown => {
                        shutting_down = true;
                        released = true;
                        released_at = Some(Instant::now());
                        active_capture.stop();
                        capture_stopped = true;
                        break;
                    }
                    Signal::Ended => {
                        released = true;
                        released_at = Some(Instant::now());
                    }
                    Signal::None => {}
                }
            }
            let samples = if capture_stopped {
                std::thread::sleep(Duration::from_millis(20));
                Vec::new()
            } else {
                match active_capture.drain() {
                    Ok(samples) => samples,
                    Err(_) => {
                        let shutting_down =
                            shutting_down || (!released && drain_until_release(rx));
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
                }
            };
            if !samples.is_empty() {
                captured_frames += samples.len();
                if !audio::is_silence(&samples) {
                    heard_speech = true;
                }
                utterance.extend_from_slice(&samples);
            }
            if !capture_stopped
                && released_at.is_some_and(|released_at| released_at.elapsed() >= TAIL_DRAIN)
            {
                active_capture.stop();
                capture_stopped = true;
            }
            // The waveform runs from the very first drain, so the mic is
            // visibly working while the model is still loading. That is the
            // stretch where the old HUD looked most broken.
            if last_level.elapsed() >= LEVEL_EVERY {
                last_level = Instant::now();
                hud::publish_level(app, audio::level(&samples));
            }
            // Always polled before any exit below, so a load that finished
            // during this iteration is collected rather than abandoned.
            model.poll(status);
            if last_partial.elapsed() >= PARTIAL_EVERY {
                last_partial = Instant::now();
                hud::publish(
                    app,
                    HudUpdate::new(HudPhase::Listening)
                        .with_message("Getting the on-device model ready"),
                );
            }
            match released_at {
                Some(at) => {
                    if at.elapsed() >= LOAD_GRACE {
                        break;
                    }
                }
                None => {
                    if started_at.elapsed() >= audio::MAX_HOLD {
                        capped = true;
                        released = true;
                        released_at = Some(Instant::now());
                        break;
                    }
                }
            }
        }

        let still_loading = model.loading();
        let Some(recognizer) = model.ready() else {
            let shutting_down = shutting_down || (!released && drain_until_release(rx));
            // A load that is STILL running only ran out of grace, which is a
            // "try again in a second", not the permanent "this build has no
            // recognizer" that a failed or missing install means.
            let message = if still_loading {
                "The on-device model is still starting. Try that again in a moment."
            } else {
                "On-device dictation is not available in this build."
            };
            hold_failure(
                app,
                generation,
                failed,
                utterance,
                if still_loading { "model_load_timeout" } else { "model_load" },
                message,
            );
            return shutting_down;
        };

        if cold {
            info!(
                "dictation: model={MODEL_ID} phase=model_load state=utterance_ready cold_wait_ms={}",
                started_at.elapsed().as_millis()
            );
        }

        let stream = match recognizer.start_stream() {
            Ok(stream) => stream,
            Err(e) => {
                warn!("dictation: stream refused: {e}");
                let shutting_down = shutting_down || (!released && drain_until_release(rx));
                hold_failure(
                    app,
                    generation,
                    failed,
                    utterance,
                    "stream_create",
                    "The recognizer could not start. Nothing was typed.",
                );
                return shutting_down;
            }
        };
        decode_time += feed_full_chunks(&stream, &utterance, &mut fed_samples);

        // Phase 2: the normal streaming loop, skipped entirely when the hold
        // already ended while the model was loading.
        while !released {
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
                    let shutting_down = shutting_down || (!released && drain_until_release(rx));
                    drop(stream);
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
                utterance.extend_from_slice(&samples);
                decode_time += feed_full_chunks(&stream, &utterance, &mut fed_samples);
            }

            // An empty drain publishes 0.0 rather than being skipped: flat bars
            // are the honest reading for a muted or dead device, and that is
            // the whole reason the waveform is here.
            if last_level.elapsed() >= LEVEL_EVERY {
                last_level = Instant::now();
                hud::publish_level(app, audio::level(&samples));
            }

            if last_partial.elapsed() >= PARTIAL_EVERY {
                last_partial = Instant::now();
                hud::publish(
                    app,
                    HudUpdate::new(HudPhase::Listening).with_text(stream.text()),
                );
            }

            if started_at.elapsed() >= audio::MAX_HOLD {
                capped = true;
                released_at = Some(Instant::now());
                break;
            }
        }

        // The chord came up, but WASAPI still holds the packet that carried the
        // last word. Drain the tail before closing the stream, or a user who
        // releases the instant they stop speaking loses it.
        let tail_deadline = Instant::now() + TAIL_DRAIN;
        let finalization_started_at = released_at.unwrap_or_else(Instant::now);
        let mut empty_drains = 0u8;
        while !capture_stopped && empty_drains < 2 && Instant::now() < tail_deadline {
            let samples = match active_capture.drain() {
                Ok(samples) => samples,
                Err(_) => {
                    drop(stream);
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
            utterance.extend_from_slice(&samples);
            decode_time += feed_full_chunks(&stream, &utterance, &mut fed_samples);
        }

        hud::publish(
            app,
            HudUpdate::new(HudPhase::Transcribing).with_text(stream.text()),
        );
        let finish_time = match stream.finish(&utterance[fed_samples..]) {
            Ok(duration) => duration,
            Err(e) => {
                warn!("dictation: model={MODEL_ID} phase=finalize failure=finalization_timeout: {e}");
                drop(stream);
                hold_failure(
                    app,
                    generation,
                    failed,
                    utterance,
                    "finalization_timeout",
                    "On-device transcription timed out. Nothing was typed.",
                );
                return shutting_down;
            }
        };
        decode_time += finish_time;
        let decoded = stream.text();
        // Opt-in, default off. Read ONCE here so every later decision in this
        // utterance agrees about whether it is being traced, even if the user
        // toggles the setting while the words are being typed.
        let tracing = trace::wants_anchor(app);
        // Token timings have to be taken before the stream is dropped, and are
        // not worth fetching for an utterance nobody is tracing.
        let tokens = if tracing {
            stream.tokens()
        } else {
            Vec::new()
        };
        drop(stream);

        let hold_ms = started_at.elapsed().as_millis();
        let audio_ms = captured_frames as f64 * 1000.0 / super::stt::SAMPLE_RATE as f64;
        let finalization_ms = finalization_started_at.elapsed().as_millis();
        let realtime_factor = if audio_ms > 0.0 {
            decode_time.as_secs_f64() / (audio_ms / 1000.0)
        } else {
            0.0
        };
        info!(
            "dictation: model={MODEL_ID} phase=finalize cold={cold} audio_ms={audio_ms:.0} finalization_ms={finalization_ms} decode_ms={} realtime_factor={realtime_factor:.3}",
            decode_time.as_millis()
        );
        if !cold && finalization_ms > 1000 {
            warn!(
                "dictation: model={MODEL_ID} phase=finalize target_miss=warm_keyup_p95_candidate finalization_ms={finalization_ms}"
            );
        }
        if realtime_factor >= 0.8 {
            warn!(
                "dictation: model={MODEL_ID} phase=decode target_miss=realtime_factor realtime_factor={realtime_factor:.3}"
            );
        }
        if capped {
            warn!("dictation: hold hit the {}s cap, finalizing the bounded utterance", audio::MAX_HOLD.as_secs());
        }

        // The silence guard suppresses an empty insert and nothing else. It is
        // never used for endpointing and never trims leading audio, which would
        // eat the first phoneme.
        if !heard_speech {
            info!("dictation: nothing to insert (frames={captured_frames} hold_ms={hold_ms})");
            finish_with(app, generation, HudUpdate::new(HudPhase::Idle), CAPTION_LINGER);
            return shutting_down;
        }
        if decoded.trim().is_empty() {
            hold_failure(
                app,
                generation,
                failed,
                utterance,
                "empty_result",
                "No final transcription was produced. Nothing was typed.",
            );
            return shutting_down;
        }

        let corrections = vocab::load_corrections(app).unwrap_or_default();
        let final_text =
            vocab::apply_corrections(&decoded, &corrections, &vocabulary, app_key.as_deref());

        // Asked here, at the last possible moment, because this is the only
        // point at which "where would these keystrokes go" has its final
        // answer. Bounded and fails open; see uia/focus.rs. When tracing is on
        // this same round trip also reads the field's "before" text, so
        // verifying where the keystrokes landed costs no extra call in front of
        // them.
        let probe = crate::uia::probe_focus(app, tracing);
        let outcome = insert::insert_text(&final_text, target, probe.verdict);
        info!(
            "dictation: model={MODEL_ID} phase=insert hold_ms={hold_ms} frames={captured_frames} chars={} role={} \
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
                tokens,
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
                tokens,
                std::mem::take(&mut utterance),
                app_key,
            );
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

    fn feed_full_chunks(
        stream: &Stream<'_>,
        utterance: &[f32],
        fed_samples: &mut usize,
    ) -> Duration {
        let mut decode_time = Duration::ZERO;
        while utterance.len().saturating_sub(*fed_samples) >= STREAMING_CHUNK_SAMPLES {
            let end = *fed_samples + STREAMING_CHUNK_SAMPLES;
            decode_time += stream.accept(&utterance[*fed_samples..end]);
            *fed_samples = end;
        }
        decode_time
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
        hud::publish(app, update);
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

    pub fn signal(_chord_signal: ChordSignal) {}

    pub fn start(_app: AppHandle) -> DictationHandle {
        DictationHandle {
            status: DictationStatus::unavailable("Dictation is available on Windows only."),
        }
    }
}

#[tauri::command]
pub fn dictation_status(state: tauri::State<'_, DictationHandle>) -> DictationStatus {
    state.status()
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

#[cfg(not(windows))]
pub(crate) fn show_hud(_app: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub(crate) fn refresh_hud_placement(_app: &tauri::AppHandle) {}

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
    ) -> Result<Option<trace::upload::TraceUploadLease>, String> {
        let Some(settings) = trace::handle(&app).map(|handle| handle.snapshot()) else {
            return Ok(None);
        };
        tauri::async_runtime::spawn_blocking(move || trace::upload::claim(&app, &settings))
            .await
            .map_err(|e| e.to_string())?
    }

    /// The FLAC body for a claimed trace, as raw IPC bytes.
    #[tauri::command]
    pub async fn dictation_trace_upload_audio(
        app: tauri::AppHandle,
        trace_id: String,
    ) -> Result<tauri::ipc::Response, String> {
        tauri::async_runtime::spawn_blocking(move || {
            trace::upload::audio_body(&app, &trace_id).map(tauri::ipc::Response::new)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Both halves reached the server.
    #[tauri::command]
    pub async fn dictation_resolve_trace_upload(
        app: tauri::AppHandle,
        trace_id: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || trace::upload::resolve(&app, &trace_id))
            .await
            .map_err(|e| e.to_string())?
    }

    /// The attempt failed. `retryable` false means it will never succeed on its
    /// own (rejected payload, digest conflict) and the trace is abandoned.
    #[tauri::command]
    pub async fn dictation_fail_trace_upload(
        app: tauri::AppHandle,
        trace_id: String,
        retryable: bool,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            trace::upload::fail(&app, &trace_id, retryable)
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
    ) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(move || trace::store::claim_tombstone(&app))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn dictation_resolve_trace_deletion(
        app: tauri::AppHandle,
        trace_id: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            trace::store::resolve_tombstone(&app, &trace_id)
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
