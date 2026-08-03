//! One durable trace record per hold.
//!
//! The first hardware run of dictation produced three complaints (laggy output,
//! a HUD that did not appear, uppercase text) and the only durable evidence was
//! a single summary line per hold: `hold_ms`, `frames`, `chars`, `outcome`. That
//! was enough to prove capture was healthy and therefore that decoding was the
//! bottleneck, but only by hand-computing frames against hold duration. This
//! module records the numbers directly so the next latency question is answered
//! by reading a file instead of reconstructing it.
//!
//! WHAT IS DELIBERATELY NOT IN HERE: any speech. No transcript, no partial, no
//! hotword, no correction. Only timings, counts and outcomes. Dictation's whole
//! posture is that decoded text never reaches disk in the clear (see the module
//! header in mod.rs, `sentry_setup::mentions_dictation`, and the dictation-thread
//! branch of logging.rs's panic hook), and a debug file is exactly the sort of
//! well-meant addition that would quietly break it. `chars` is a count, not
//! content.
//!
//! Written as NDJSON, one object per line, so it can be tailed live and parsed
//! without a schema. Best effort throughout: a failed write is swallowed, never
//! surfaced, and never allowed to affect a hold.

#![cfg(windows)]

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use log::info;
use serde::Serialize;
use tauri::{AppHandle, Manager};

const TRACE_FILE: &str = "dictation-trace.ndjson";
/// Same bound and strategy as the main log (logging.rs): rotate at ~5MB and keep
/// one prior file, so the durable trace is capped at ~10MB rather than growing
/// for the life of the install.
const MAX_TRACE_BYTES: u64 = 5_000_000;

/// Milliseconds from the moment the chord completed. Every stage is an Option
/// because any of them can legitimately not happen: a hold with no microphone
/// never reaches `first_sample`, one that is cancelled never reaches `insert`.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stages {
    #[serde(skip_serializing_if = "Option::is_none")]
    hud_shown: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_open: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_sample: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_ready: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_partial: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tail_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decode_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    insert_done: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record<'a> {
    /// Wall-clock start, so a record can be lined up against the main log.
    at: String,
    hold: u64,
    chord: &'a str,
    stages: &'a Stages,
    frames: usize,
    hold_ms: u64,
    /// Wall time spent inside accept + decode on the decode thread.
    decode_ms: u64,
    /// Worst gap between elapsed time and audio fed to the decoder. The single
    /// most diagnostic number here: flat and small means the decoder is keeping
    /// up, climbing means it is falling behind the speaker.
    max_lag_ms: u64,
    punct_ms: u64,
    /// A COUNT, never the text.
    chars: usize,
    heard_speech: bool,
    capped: bool,
    role: &'a str,
    verdict: &'a str,
    outcome: &'a str,
    decoding_method: &'a str,
    biasing_available: bool,
    punctuation_available: bool,
}

/// Accumulates one hold's timings. Constructed the instant the chord completes.
pub struct HoldTrace {
    started: Instant,
    hold: u64,
    stages: Stages,
    pub frames: usize,
    pub decode_ms: u64,
    pub max_lag_ms: u64,
    pub punct_ms: u64,
    pub chars: usize,
    pub heard_speech: bool,
    pub capped: bool,
    pub role: String,
    pub verdict: String,
    pub outcome: String,
    pub decoding_method: String,
    pub biasing_available: bool,
    pub punctuation_available: bool,
}

impl HoldTrace {
    pub fn new(hold: u64) -> Self {
        Self {
            started: Instant::now(),
            hold,
            stages: Stages::default(),
            frames: 0,
            decode_ms: 0,
            max_lag_ms: 0,
            punct_ms: 0,
            chars: 0,
            heard_speech: false,
            capped: false,
            role: String::new(),
            verdict: String::new(),
            outcome: String::new(),
            decoding_method: String::new(),
            biasing_available: false,
            punctuation_available: false,
        }
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Records a stage the FIRST time it happens. Later calls are ignored, so
    /// `first_sample` and `first_partial` mean what their names say even though
    /// the caller sits in a loop.
    fn mark(slot: &mut Option<u64>, value: u64) {
        if slot.is_none() {
            *slot = Some(value);
        }
    }

    pub fn hud_shown(&mut self) {
        Self::mark(&mut self.stages.hud_shown, self.started.elapsed().as_millis() as u64);
    }
    pub fn device_open(&mut self) {
        Self::mark(&mut self.stages.device_open, self.started.elapsed().as_millis() as u64);
    }
    pub fn first_sample(&mut self) {
        Self::mark(&mut self.stages.first_sample, self.started.elapsed().as_millis() as u64);
    }
    pub fn model_ready(&mut self) {
        Self::mark(&mut self.stages.model_ready, self.started.elapsed().as_millis() as u64);
    }
    pub fn first_partial(&mut self) {
        Self::mark(&mut self.stages.first_partial, self.started.elapsed().as_millis() as u64);
    }
    pub fn release(&mut self) {
        Self::mark(&mut self.stages.release, self.started.elapsed().as_millis() as u64);
    }
    pub fn tail_done(&mut self) {
        Self::mark(&mut self.stages.tail_done, self.started.elapsed().as_millis() as u64);
    }
    pub fn decode_done(&mut self) {
        Self::mark(&mut self.stages.decode_done, self.started.elapsed().as_millis() as u64);
    }
    pub fn insert_done(&mut self) {
        Self::mark(&mut self.stages.insert_done, self.started.elapsed().as_millis() as u64);
    }

    /// Writes the record and emits the matching one-line summary. Consumes the
    /// trace so a hold cannot be recorded twice.
    pub fn finish(self, app: &AppHandle, chord: &'static str) {
        let hold_ms = self.now_ms();
        let record = Record {
            at: now_iso(),
            hold: self.hold,
            chord,
            stages: &self.stages,
            frames: self.frames,
            hold_ms,
            decode_ms: self.decode_ms,
            max_lag_ms: self.max_lag_ms,
            punct_ms: self.punct_ms,
            chars: self.chars,
            heard_speech: self.heard_speech,
            capped: self.capped,
            role: &self.role,
            verdict: &self.verdict,
            outcome: &self.outcome,
            decoding_method: &self.decoding_method,
            biasing_available: self.biasing_available,
            punctuation_available: self.punctuation_available,
        };

        // Mirrors the GuideTrace convention in overlay.rs, so the headline
        // numbers are greppable from the one log everyone already reads.
        info!(
            "DictationTrace: hold={} hold_ms={} frames={} decode_ms={} max_lag_ms={} \
             punct_ms={} chars={} outcome={} verdict={} role={} decoding={}",
            self.hold,
            hold_ms,
            self.frames,
            self.decode_ms,
            self.max_lag_ms,
            self.punct_ms,
            self.chars,
            self.outcome,
            self.verdict,
            self.role,
            self.decoding_method,
        );

        if let Ok(line) = serde_json::to_string(&record) {
            append_line(app, &line);
        }
    }
}

fn now_iso() -> String {
    // Seconds resolution is plenty: the stage offsets carry the precision, and
    // this field exists only to line a record up against the main log.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{now}")
}

fn trace_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|dir| dir.join(TRACE_FILE))
}

/// Appends one line, rotating first if the file has reached its cap. Every
/// failure is swallowed: a trace that cannot be written must never disturb a
/// dictation.
fn append_line(app: &AppHandle, line: &str) {
    let Some(path) = trace_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) >= MAX_TRACE_BYTES {
        let rotated = path.with_extension("ndjson.1");
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&path, &rotated);
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(file, "{line}");
}
