//! The decode thread: everything that touches the recognizer, and nothing else.
//!
//! WHY THIS EXISTS. `Stream::accept` runs the decoder inline (`decode_ready`
//! spins `while is_ready { decode }`). When that ran on the capture loop, every
//! 30ms drain had to finish decoding before the loop could poll a chord signal,
//! publish a waveform level, or publish a partial. The first hardware run showed
//! exactly that: audio capture stayed healthy (captured frames were 93-95% of
//! hold duration on every hold) while the visible caption fell further behind
//! the longer the user spoke. Capture was never the problem; decoding blocking
//! the loop was.
//!
//! So the recognizer lives here and only here. The worker keeps capture, chord
//! signals, the waveform and the HUD, and never blocks on decode.
//!
//! This split is also what makes the FFI sound rather than merely faster.
//! `Stream<'_>` borrows `Recognizer` and both hold raw sherpa-onnx pointers that
//! are `Send` but deliberately not `Sync` (see stt.rs). Sole ownership by one
//! thread is the only arrangement that keeps that guarantee while letting the
//! worker run free.
//!
//! THE CHANNEL IS THE WARM-UP BUFFER. Commands queue while `Recognizer::load`
//! is still running on this thread, then get processed in order once it lands.
//! That is why the worker has no "wait for the model" phase and no separate
//! sample buffer: a user who holds the chord and speaks immediately after launch
//! has their audio sitting in the queue, and it is decoded the moment the
//! recognizer is warm.
//!
//! Nothing here logs decoded text at any level, same discipline as the rest of
//! the module.

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::time::{Duration, Instant};

use log::{error, info, warn};

use super::stt::{Recognizer, SAMPLE_RATE};

/// Named so logging.rs's panic hook recognizes it and refuses to format a panic
/// payload raised here. This thread holds decoded speech in memory, so a panic
/// message from it could otherwise carry a transcript into the plaintext log.
pub const DECODE_THREAD: &str = "aura-dictation-decode";

/// How often a partial is emitted while a hold is running. Matches the cadence
/// the HUD wants; generated here because this thread is the only one that knows
/// when the text actually changed.
const PARTIAL_EVERY: Duration = Duration::from_millis(320);

pub enum Command {
    /// Begin one utterance. Carries the hotwords for it, which are per-stream.
    Start { hotwords: String },
    Samples(Vec<f32>),
    /// The chord came up: flush, punctuate, and reply with `Final`.
    Finish,
    Shutdown,
}

pub enum Event {
    /// The recognizer loaded. Carries what this install can actually do.
    Ready {
        biasing: bool,
        punctuation: bool,
        decoding_method: &'static str,
    },
    /// The load failed, permanently for this session.
    Failed(String),
    Partial(String),
    /// One utterance's finished text, already punctuated and true-cased, plus
    /// the numbers the per-hold trace records.
    Final(Finished),
}

/// The decode side's own measurements for one hold.
pub struct Finished {
    pub text: String,
    /// Wall time spent inside accept + decode.
    pub decode_ms: u64,
    /// Worst observed gap between elapsed wall time and the audio actually fed
    /// in. This is the number that identifies a decoder falling behind the
    /// speaker: it stays flat and small when decoding keeps up, and climbs
    /// steadily when it does not.
    pub max_lag_ms: u64,
    /// Time spent in the punctuation model alone.
    pub punct_ms: u64,
}

/// Handle held by the dictation worker.
pub struct Decoder {
    tx: Sender<Command>,
    rx: Receiver<Event>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Decoder {
    /// Spawns the thread and returns immediately. The recognizer load runs
    /// there, so this never blocks the caller.
    pub fn start(resource_dir: PathBuf) -> Result<Self, String> {
        let (command_tx, command_rx) = std::sync::mpsc::channel::<Command>();
        let (event_tx, event_rx) = std::sync::mpsc::channel::<Event>();
        let thread = std::thread::Builder::new()
            .name(DECODE_THREAD.to_string())
            .spawn(move || run(resource_dir, command_rx, event_tx))
            .map_err(|e| format!("the decode thread could not start: {e}"))?;
        Ok(Self {
            tx: command_tx,
            rx: event_rx,
            thread: Some(thread),
        })
    }

    pub fn start_utterance(&self, hotwords: String) {
        let _ = self.tx.send(Command::Start { hotwords });
    }

    pub fn send_samples(&self, samples: Vec<f32>) {
        let _ = self.tx.send(Command::Samples(samples));
    }

    pub fn finish(&self) {
        let _ = self.tx.send(Command::Finish);
    }

    /// Non-blocking. The worker calls this inside its capture loop, so it must
    /// never wait.
    pub fn try_event(&self) -> Option<Event> {
        match self.rx.try_recv() {
            Ok(event) => Some(event),
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => None,
        }
    }

    /// Blocks for the finished text, bounded. Only ever called after `finish`,
    /// when there is nothing left to capture and waiting is the whole job.
    /// Partials arriving in the meantime are handed to `on_partial` so the HUD
    /// keeps moving while the tail is decoded.
    pub fn wait_for_final(
        &self,
        timeout: Duration,
        mut on_partial: impl FnMut(String),
    ) -> Option<Finished> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                warn!("dictation.decode: timed out waiting for the finished text");
                return None;
            }
            match self.rx.recv_timeout(remaining) {
                Ok(Event::Final(finished)) => return Some(finished),
                Ok(Event::Partial(text)) => on_partial(text),
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => {
                    warn!("dictation.decode: timed out waiting for the finished text");
                    return None;
                }
                Err(RecvTimeoutError::Disconnected) => return None,
            }
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(resource_dir: PathBuf, rx: Receiver<Command>, tx: Sender<Event>) {
    let recognizer = match Recognizer::load(&resource_dir) {
        Ok(recognizer) => {
            let _ = tx.send(Event::Ready {
                biasing: recognizer.biasing_available(),
                punctuation: recognizer.punctuation_available(),
                decoding_method: recognizer.decoding_method(),
            });
            recognizer
        }
        Err(e) => {
            warn!("dictation.decode: recognizer unavailable: {e}");
            let _ = tx.send(Event::Failed(e));
            // Keep answering so a hold already in flight is not left waiting on
            // a reply that can never come.
            answer_without_recognizer(&rx, &tx);
            return;
        }
    };

    loop {
        let Ok(command) = rx.recv() else { break };
        match command {
            Command::Shutdown => break,
            Command::Start { hotwords } => {
                if decode_one(&recognizer, &rx, &tx, &hotwords) {
                    break;
                }
            }
            // A stray Samples or Finish with no Start in front of it. Nothing
            // to decode into, and answering Finish anyway keeps the worker's
            // wait bounded.
            Command::Samples(_) => {}
            Command::Finish => {
                let _ = tx.send(Event::Final(Finished {
                    text: String::new(),
                    decode_ms: 0,
                    max_lag_ms: 0,
                    punct_ms: 0,
                }));
            }
        }
    }
    info!("dictation.decode: thread stopped");
}

/// One utterance, start to finished text. Returns true when the process is
/// shutting down.
fn decode_one(
    recognizer: &Recognizer,
    rx: &Receiver<Command>,
    tx: &Sender<Event>,
    hotwords: &str,
) -> bool {
    let stream = match recognizer.start_stream(hotwords) {
        Ok(stream) => stream,
        Err(e) => {
            warn!("dictation.decode: stream refused: {e}");
            let _ = tx.send(Event::Final(Finished {
                text: String::new(),
                decode_ms: 0,
                max_lag_ms: 0,
                punct_ms: 0,
            }));
            return false;
        }
    };

    let started = Instant::now();
    let mut frames_accepted: usize = 0;
    let mut decode_time = Duration::ZERO;
    let mut max_lag = Duration::ZERO;
    let mut last_partial = Instant::now();

    loop {
        let Ok(command) = rx.recv() else { return true };
        match command {
            Command::Shutdown => return true,
            Command::Samples(samples) => {
                if samples.is_empty() {
                    continue;
                }
                frames_accepted += samples.len();
                let began = Instant::now();
                stream.accept(&samples);
                decode_time += began.elapsed();

                // How far the decoder is behind the audio it has been given.
                // Elapsed wall time minus audio seconds consumed: flat when
                // decoding keeps up, climbing when it does not.
                let audio = Duration::from_micros(
                    (frames_accepted as u64) * 1_000_000 / (SAMPLE_RATE as u64),
                );
                let lag = started.elapsed().saturating_sub(audio);
                if lag > max_lag {
                    max_lag = lag;
                }

                if last_partial.elapsed() >= PARTIAL_EVERY {
                    last_partial = Instant::now();
                    // Display only, and cheap: the recognizer emits uppercase,
                    // and a caption that SHOUTS for the whole hold before
                    // resolving to proper case reads as a bug. The punctuation
                    // model is not run here; it takes the whole string and
                    // would cost its full price every 320ms.
                    let _ = tx.send(Event::Partial(super::stt::sentence_case(&stream.text())));
                }
            }
            Command::Finish => {
                let began = Instant::now();
                stream.finish();
                let decoded = stream.text();
                decode_time += began.elapsed();

                // Punctuation and true casing run ONCE, here, on the finished
                // string. The shipped recognizer is uppercase-only, so this is
                // what makes the inserted text readable.
                let punct_started = Instant::now();
                let text = if decoded.trim().is_empty() {
                    decoded
                } else {
                    recognizer.punctuate(&decoded)
                };
                let punct_ms = punct_started.elapsed().as_millis() as u64;

                let _ = tx.send(Event::Final(Finished {
                    text,
                    decode_ms: decode_time.as_millis() as u64,
                    max_lag_ms: max_lag.as_millis() as u64,
                    punct_ms,
                }));
                return false;
            }
            // A new utterance without the previous one being finished. Treat it
            // as the end of this one and let the caller's loop pick it up.
            Command::Start { .. } => {
                error!("dictation.decode: a new utterance started before the previous finished");
                return false;
            }
        }
    }
}

/// The recognizer never loaded. Answer every `Finish` with empty text so no
/// hold blocks on a reply, and exit on shutdown.
fn answer_without_recognizer(rx: &Receiver<Command>, tx: &Sender<Event>) {
    while let Ok(command) = rx.recv() {
        match command {
            Command::Shutdown => break,
            Command::Finish => {
                let _ = tx.send(Event::Final(Finished {
                    text: String::new(),
                    decode_ms: 0,
                    max_lag_ms: 0,
                    punct_ms: 0,
                }));
            }
            Command::Start { .. } | Command::Samples(_) => {}
        }
    }
}
