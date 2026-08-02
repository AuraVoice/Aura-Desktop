//! WASAPI capture for dictation: default capture device, shared mode,
//! 16 kHz mono f32 via autoconvert, event driven.
//!
//! Reuses meeting/audio.rs's format strategy (the Windows audio engine does the
//! resample and downmix, so there is no resampler dependency here either) but
//! NOT its `ChannelState::pump`. That pump silence-fills any wall-clock deficit
//! so two channels of a 60-minute meeting stay aligned; here it would inject
//! zeros into the middle of a word while the decoder is mid-utterance. There is
//! only one channel, and its only consumer is a streaming recognizer that does
//! its own timing, so raw packets are handed straight through.
//!
//! The client opens on the FIRST key of the chord, not on chord-complete, so
//! the 50-300ms WASAPI cold open hides behind the 200-400ms a human takes
//! before their first phoneme.
//!
//! Overlap with meeting capture is expected and accepted: meeting/audio.rs
//! opens the same default capture device, and shared mode lets both clients
//! run, so dictating while a meeting is armed puts those words in the local
//! decoder AND in that meeting's encrypted segment. That is a stated decision,
//! not an accident: refusing to dictate during a meeting would be a worse
//! surprise than the duplicate, and the meeting copy is already encrypted at
//! rest under the user's own key.

#![cfg(windows)]

use std::collections::VecDeque;
use std::time::Duration;

use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use super::stt::SAMPLE_RATE;

/// 30ms device buffer. Small enough that a release feels immediate, large
/// enough that a descheduled worker thread does not drop packets.
const BUFFER_DURATION_HNS: i64 = 300_000;
/// Cap on one wait, so the worker checks its signal channel promptly even when
/// the device delivers nothing (muted mic, no input).
const EVENT_WAIT_MS: u32 = 20;

/// One warm capture client. Held by the worker between prewarm and release.
pub struct Capture {
    client: wasapi::AudioClient,
    capture: wasapi::AudioCaptureClient,
    event: wasapi::Handle,
    raw: VecDeque<u8>,
}

impl Capture {
    /// Opens and starts the default capture device. COM must already be
    /// initialized on this thread.
    pub fn open() -> Result<Self, String> {
        let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
        let device = enumerator
            .get_default_device(&Direction::Capture)
            .map_err(|e| e.to_string())?;
        let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
        let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, 1, None);
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: BUFFER_DURATION_HNS,
        };
        client
            .initialize_client(&format, &Direction::Capture, &mode)
            .map_err(|e| e.to_string())?;
        let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        client.start_stream().map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            capture,
            event,
            raw: VecDeque::new(),
        })
    }

    /// Throws away everything captured so far. Called when the chord completes,
    /// so the prewarm window's audio (the user reaching for the second key) is
    /// not prefixed onto the utterance.
    pub fn discard_pending(&mut self) {
        self.raw.clear();
        let mut scratch = VecDeque::new();
        let _ = self.capture.read_from_device_to_deque(&mut scratch);
    }

    /// Waits briefly for the device, then returns whatever whole f32 frames are
    /// available. An empty result is normal and simply means the worker should
    /// loop again and re-check its signal channel.
    pub fn drain(&mut self) -> Vec<f32> {
        let _ = self.event.wait_for_event(EVENT_WAIT_MS);
        if self
            .capture
            .read_from_device_to_deque(&mut self.raw)
            .is_err()
        {
            // A read failure here ends the utterance rather than silently
            // truncating it; the worker sees the empty drain and the hold's
            // hard cap or the user's release finishes the insert.
            return Vec::new();
        }
        let full = self.raw.len() / 4;
        let mut samples = Vec::with_capacity(full);
        for _ in 0..full {
            let bytes = [
                self.raw.pop_front().unwrap_or(0),
                self.raw.pop_front().unwrap_or(0),
                self.raw.pop_front().unwrap_or(0),
                self.raw.pop_front().unwrap_or(0),
            ];
            samples.push(f32::from_le_bytes(bytes));
        }
        samples
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.client.stop_stream();
    }
}

/// RMS over the whole utterance. Used ONLY to suppress an empty insert: never
/// for endpointing, and never to trim leading silence, which would eat the
/// first phoneme.
pub fn is_silence(samples: &[f32]) -> bool {
    if samples.is_empty() {
        return true;
    }
    let sum: f64 = samples
        .iter()
        .map(|sample| {
            let value = *sample as f64;
            value * value
        })
        .sum();
    let rms = (sum / samples.len() as f64).sqrt();
    // Roughly -50 dBFS. Below this there is no speech to transcribe, only
    // room tone and preamp noise.
    rms < 0.003
}

/// How long a single hold may last before the worker stops on its own. A chord
/// whose keyup the hook never sees (stuck key, wedged hook, lock screen) would
/// otherwise grow an unbounded buffer forever. Mirrors MAX_CAPTURE in
/// meeting/audio.rs, scaled to a single utterance.
pub const MAX_HOLD: Duration = Duration::from_secs(120);
