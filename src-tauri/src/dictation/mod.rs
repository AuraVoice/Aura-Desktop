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
pub use platform::{signal, start, DictationHandle};

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
    use super::stt::Recognizer;
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
    /// How long one chord key must be held, with nothing else pressed, before
    /// the microphone is opened at all. Ordinary shortcuts (Ctrl+C, Ctrl+V,
    /// Ctrl-click, Win+E) are cancelled by the hook the moment their second key
    /// lands, which is well inside this window, so they never reach the device.
    const PREWARM_DEBOUNCE: Duration = Duration::from_millis(250);
    /// Budget for draining the packet WASAPI still holds when the chord comes
    /// up. Without it a user who releases the instant they stop speaking loses
    /// the last word.
    const TAIL_DRAIN: Duration = Duration::from_millis(80);
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
            let spawned = std::thread::Builder::new()
                .name(MODEL_THREAD.to_string())
                .spawn(move || {
                    let _ = tx.send(Recognizer::load(&dir));
                });
            match spawned {
                Ok(_) => self.loading = Some(rx),
                Err(e) => {
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
                        "dictation: recognizer warm, biasing={}",
                        recognizer.biasing_available()
                    );
                    self.recognizer = Some(recognizer);
                    self.loading = None;
                }
                Ok(Err(e)) => {
                    warn!("dictation: recognizer unavailable: {e}");
                    set_status(status, DictationStatus::unavailable(e));
                    self.failed = true;
                    self.loading = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    warn!("dictation: the model loader stopped without a result");
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
        loop {
            let Ok(message) = rx.recv() else {
                break;
            };
            match message {
                Message::Shutdown => break,
                Message::Chord(ChordSignal::Prewarm) => {
                    // Prewarm NEVER opens the microphone. It only warms the
                    // model, which is CPU and memory and produces no privacy
                    // signal: no device handle, no Windows "in use" indicator.
                    //
                    // That matters because this hook cannot see mouse input, so
                    // Ctrl-click or Ctrl-drag through a file list looks exactly
                    // like a long deliberate Ctrl hold. Anything gated purely on
                    // a timer would open the device for it. The microphone is
                    // therefore opened only once the FULL chord is down, and the
                    // WASAPI cold start hides behind the 200 to 400ms a human
                    // takes before their first phoneme after completing it.
                    //
                    // The debounce still guards the model load, so an ordinary
                    // Ctrl+C (cancelled by the hook the instant its second key
                    // lands) does not even pay for that.
                    match rx.recv_timeout(PREWARM_DEBOUNCE) {
                        Ok(Message::Shutdown) => break,
                        Ok(Message::Chord(ChordSignal::Arm)) => {
                            if handle_arm(&app, &mut model, &mut capture, &rx, &status) {
                                break;
                            }
                        }
                        Ok(Message::Chord(_)) => continue,
                        Err(RecvTimeoutError::Timeout) => model.begin_load(&app, &status),
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                Message::Chord(ChordSignal::Cancel) | Message::Chord(ChordSignal::Release) => {
                    // Either an abandoned prewarm, or a release with no matching
                    // arm. Drop the device so no "mic in use" indicator lingers.
                    capture = None;
                }
                Message::Chord(ChordSignal::Arm) => {
                    if handle_arm(&app, &mut model, &mut capture, &rx, &status) {
                        break;
                    }
                }
            }
        }
        hud::hide(&app);
    }

    /// One hold, with the device always released afterwards. Returns true when
    /// the process is shutting down.
    fn handle_arm(
        app: &AppHandle,
        model: &mut ModelState,
        capture: &mut Option<Capture>,
        rx: &Receiver<Message>,
        status: &Arc<Mutex<DictationStatus>>,
    ) -> bool {
        model.begin_load(app, status);
        if capture.is_none() {
            *capture = open_capture();
        }
        // A panic inside one utterance must not take dictation down for the
        // rest of the session. The hook in logging.rs additionally refuses to
        // format a panic raised on this thread, so no payload that might carry
        // transcript text reaches the plaintext log.
        let shutting_down = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_utterance(app, model, capture, rx, status)
        }))
        .unwrap_or_else(|_| {
            error!("dictation: an utterance panicked, the worker is continuing");
            hud::hide(app);
            false
        });
        *capture = None;
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
            finish_with(
                app,
                generation,
                HudUpdate::new(HudPhase::Error)
                    .with_message("No microphone is available right now."),
                FAILURE_LINGER,
            );
            return shutting_down;
        };
        // Drop whatever the prewarm window captured while the user was still
        // reaching for the second key.
        active_capture.discard_pending();

        let vocabulary = vocab::load_vocab(app).unwrap_or_default();
        let hotwords = vocab::hotwords_for(&vocabulary, app_key.as_deref());

        let started_at = Instant::now();
        let mut last_partial = Instant::now();
        let mut captured_frames = 0usize;
        let mut heard_speech = false;
        let mut shutting_down = false;
        let mut capped = false;
        let mut released = false;
        // Audio captured before the model finished loading. Non-empty only on
        // the first hold of a session, and fed to the stream in full the moment
        // the recognizer arrives, so nothing the user said is lost.
        let mut pending: Vec<f32> = Vec::new();

        // Phase 1: warm-up. Only runs while the first load of the session is
        // still in flight. `model` is borrowed mutably here and only here.
        while model.ready().is_none() && !model.failed {
            match poll_signal(rx) {
                Signal::Shutdown => {
                    shutting_down = true;
                    released = true;
                    break;
                }
                Signal::Ended => {
                    released = true;
                    break;
                }
                Signal::None => {}
            }
            let samples = active_capture.drain();
            if !samples.is_empty() {
                captured_frames += samples.len();
                if !audio::is_silence(&samples) {
                    heard_speech = true;
                }
                pending.extend_from_slice(&samples);
            }
            if last_partial.elapsed() >= PARTIAL_EVERY {
                last_partial = Instant::now();
                hud::publish(
                    app,
                    HudUpdate::new(HudPhase::Listening)
                        .with_message("Getting the on-device model ready"),
                );
            }
            if started_at.elapsed() >= audio::MAX_HOLD {
                capped = true;
                released = true;
                break;
            }
            model.poll(status);
        }

        let Some(recognizer) = model.ready() else {
            let shutting_down = shutting_down || (!released && drain_until_release(rx));
            finish_with(
                app,
                generation,
                HudUpdate::new(HudPhase::Error)
                    .with_message("On-device dictation is not available in this build."),
                FAILURE_LINGER,
            );
            return shutting_down;
        };

        let stream = match recognizer.start_stream(&hotwords) {
            Ok(stream) => stream,
            Err(e) => {
                warn!("dictation: stream refused: {e}");
                let shutting_down = shutting_down || (!released && drain_until_release(rx));
                finish_with(
                    app,
                    generation,
                    HudUpdate::new(HudPhase::Error)
                        .with_message("The recognizer could not start. Try again."),
                    FAILURE_LINGER,
                );
                return shutting_down;
            }
        };
        if !pending.is_empty() {
            stream.accept(&pending);
            pending.clear();
        }

        // Phase 2: the normal streaming loop, skipped entirely when the hold
        // already ended while the model was loading.
        while !released {
            match poll_signal(rx) {
                Signal::Shutdown => {
                    shutting_down = true;
                    break;
                }
                Signal::Ended => break,
                Signal::None => {}
            }

            let samples = active_capture.drain();
            if !samples.is_empty() {
                captured_frames += samples.len();
                if !audio::is_silence(&samples) {
                    heard_speech = true;
                }
                stream.accept(&samples);
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
                break;
            }
        }

        // The chord came up, but WASAPI still holds the packet that carried the
        // last word. Drain the tail before closing the stream, or a user who
        // releases the instant they stop speaking loses it.
        let tail_deadline = Instant::now() + TAIL_DRAIN;
        let mut empty_drains = 0u8;
        while empty_drains < 2 && Instant::now() < tail_deadline {
            let samples = active_capture.drain();
            if samples.is_empty() {
                empty_drains += 1;
                continue;
            }
            empty_drains = 0;
            captured_frames += samples.len();
            if !audio::is_silence(&samples) {
                heard_speech = true;
            }
            stream.accept(&samples);
        }

        hud::publish(
            app,
            HudUpdate::new(HudPhase::Transcribing).with_text(stream.text()),
        );
        stream.finish();
        let decoded = stream.text();
        drop(stream);

        let hold_ms = started_at.elapsed().as_millis();
        if capped {
            warn!("dictation: hold hit the {}s cap, inserting what was decoded", audio::MAX_HOLD.as_secs());
        }

        // The silence guard suppresses an empty insert and nothing else. It is
        // never used for endpointing and never trims leading audio, which would
        // eat the first phoneme.
        if decoded.trim().is_empty() || !heard_speech {
            info!("dictation: nothing to insert (frames={captured_frames} hold_ms={hold_ms})");
            finish_with(app, generation, HudUpdate::new(HudPhase::Idle), CAPTION_LINGER);
            return shutting_down;
        }

        let corrections = vocab::load_corrections(app).unwrap_or_default();
        let final_text =
            vocab::apply_corrections(&decoded, &corrections, &vocabulary, app_key.as_deref());

        let outcome = insert::insert_text(&final_text, target);
        info!(
            "dictation: hold_ms={hold_ms} frames={captured_frames} chars={} outcome={outcome:?}",
            final_text.chars().count()
        );

        let (update, linger) = match outcome {
            InsertOutcome::Inserted => (
                HudUpdate::new(HudPhase::Inserted).with_text(final_text),
                CAPTION_LINGER,
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

    /// Publishes the closing caption and schedules the HUD to hide, unless a
    /// newer hold has started in the meantime.
    fn finish_with(app: &AppHandle, generation: u64, update: HudUpdate, linger: Duration) {
        hud::publish(app, update);
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(linger).await;
            if HUD_GENERATION.load(Ordering::SeqCst) == generation {
                hud::publish(&handle, HudUpdate::new(HudPhase::Idle));
                hud::hide(&handle);
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

/// The HUD's current state. The HUD window is created on arm, so its first
/// render can miss the caption that was emitted moments earlier; it calls this
/// once on mount instead of racing the event. A couple of cheap synchronous
/// reads behind one mutex, so this one stays non-async.
#[cfg(windows)]
#[tauri::command]
pub fn dictation_hud_state() -> hud::HudUpdate {
    hud::last_update()
}

#[cfg(not(windows))]
#[tauri::command]
pub fn dictation_hud_state() -> DictationStatus {
    DictationStatus::unavailable(NOT_SUPPORTED)
}

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
