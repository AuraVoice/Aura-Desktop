//! WASAPI capture for dictation: default capture device, shared mode,
//! 16 kHz mono f32 via autoconvert, event driven.
//!
//! Reuses meeting/audio.rs's format strategy (the Windows audio engine does the
//! resample and downmix, so there is no resampler dependency here either) but
//! NOT its `ChannelState::pump`. That pump silence-fills any wall-clock deficit
//! so two channels of a 60-minute meeting stay aligned; here it would inject
//! zeros into the middle of a word while the decoder is mid-utterance. There is
//! only one channel, and its only consumer is a streaming recognizer that does
//! its own timing, so raw packets are handed straight through. The recognizer
//! is now the cloud provider in `asr/`, which changes nothing here: the format
//! and the packet cadence are the same, and `to_i16` below is the only extra
//! step between this file and the socket.
//!
//! The client opens only once the FULL chord is down, never on the first key.
//! An earlier revision opened it on the first key to hide the 50-300ms WASAPI
//! cold start, but the keyboard hook cannot see mouse input, so Ctrl-click and
//! Ctrl-drag were indistinguishable from a deliberate hold and quietly put
//! Windows' microphone indicator up during ordinary work. The cold start is
//! covered well enough by the 200-400ms a human takes before their first
//! phoneme after completing the chord. Model loading then proceeds in parallel
//! with capture on a separate thread.
//!
//! Overlap with meeting capture is expected and accepted: meeting/audio.rs
//! opens the same default capture device, and shared mode lets both clients
//! run, so dictating while a meeting is armed puts those words through the
//! dictation recognizer AND into that meeting's encrypted segment. That is a
//! stated decision,
//! not an accident: refusing to dictate during a meeting would be a worse
//! surprise than the duplicate, and the meeting copy is already encrypted at
//! rest under the user's own key.

#![cfg(windows)]

use std::collections::VecDeque;
use std::time::Duration;

use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use super::asr::SAMPLE_RATE;

/// 30ms device buffer. Small enough that a release feels immediate, large
/// enough that a descheduled worker thread does not drop packets.
const BUFFER_DURATION_HNS: i64 = 300_000;
/// Cap on one wait, so the worker checks its signal channel promptly even when
/// the device delivers nothing (muted mic, no input).
const EVENT_WAIT_MS: u32 = 20;

/// One capture client. Owned by the worker for a single hold.
pub struct Capture {
    client: wasapi::AudioClient,
    capture: wasapi::AudioCaptureClient,
    event: wasapi::Handle,
    raw: VecDeque<u8>,
    stopped: bool,
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
            stopped: false,
        })
    }

    pub fn stop(&mut self) {
        if !self.stopped {
            let _ = self.client.stop_stream();
            self.stopped = true;
        }
    }

    /// Throws away everything captured so far. Called when the chord completes,
    /// so the prewarm window's audio (the user reaching for the second key) is
    /// not prefixed onto the utterance.
    pub fn discard_pending(&mut self) -> Result<(), String> {
        self.raw.clear();
        let mut scratch = VecDeque::new();
        self.capture
            .read_from_device_to_deque(&mut scratch)
            .map_err(|e| format!("microphone read failed: {e}"))?;
        Ok(())
    }

    /// Waits briefly for the device, then returns whatever whole f32 frames are
    /// available. An empty result is normal and simply means the worker should
    /// loop again and re-check its signal channel.
    pub fn drain(&mut self) -> Result<Vec<f32>, String> {
        let _ = self.event.wait_for_event(EVENT_WAIT_MS);
        self.capture
            .read_from_device_to_deque(&mut self.raw)
            .map_err(|e| format!("microphone read failed: {e}"))?;
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
        Ok(samples)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// WASAPI hands us f32 because that is what the shared-mode engine mixes in;
/// the transcription provider wants `linear16`, which is signed 16-bit
/// little-endian. Saturating rather than wrapping on purpose: a sample that
/// clipped past 1.0 (a loud plosive into a hot mic) must come out as the
/// loudest representable value, not wrap around to the opposite sign, which
/// would inject a click the recognizer has to work around.
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect()
}

fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples
        .iter()
        .map(|sample| {
            let value = *sample as f64;
            value * value
        })
        .sum();
    (sum / samples.len() as f64).sqrt()
}

/// RMS over the whole utterance. Used ONLY to suppress an empty insert: never
/// for endpointing, and never to trim leading silence, which would eat the
/// first phoneme.
pub fn is_silence(samples: &[f32]) -> bool {
    if samples.is_empty() {
        return true;
    }
    // Roughly -50 dBFS. Below this there is no speech to transcribe, only
    // room tone and preamp noise.
    rms(samples) < 0.003
}

/// One drain's loudness as 0..1, for the HUD's waveform and nothing else. It is
/// deliberately NOT the `is_silence` threshold: that one decides whether to
/// insert text and must stay conservative, while this one only has to look
/// honest. An empty drain returns 0.0 rather than being skipped, so a muted or
/// dead device renders flat bars instead of freezing on the last spike.
///
/// Shaped, not raw: RMS is heavily bottom-weighted, so a linear mapping leaves
/// normal speech sitting near the floor. The floor subtraction keeps room tone
/// at rest and the exponent opens up the conversational range.
pub fn level(samples: &[f32]) -> f32 {
    const FLOOR: f64 = 0.004;
    const GAIN: f64 = 11.0;
    let shaped = ((rms(samples) - FLOOR).max(0.0) * GAIN).min(1.0).powf(0.62);
    shaped as f32
}

/// How long a single hold may last before the worker stops on its own. A chord
/// whose keyup the hook never sees (stuck key, wedged hook, lock screen) would
/// otherwise grow an unbounded buffer forever. Mirrors MAX_CAPTURE in
/// meeting/audio.rs, scaled to a single utterance.
pub const MAX_HOLD: Duration = Duration::from_secs(120);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_scale_and_silence_convert_as_expected() {
        assert_eq!(to_i16(&[0.0]), vec![0]);
        assert_eq!(to_i16(&[1.0]), vec![i16::MAX]);
        assert_eq!(to_i16(&[-1.0]), vec![-i16::MAX]);
    }

    #[test]
    fn a_clipped_sample_saturates_instead_of_wrapping() {
        // A plosive into a hot mic can exceed full scale. Wrapping would flip
        // the sign and inject a click into the audio the recognizer sees.
        assert_eq!(to_i16(&[1.9]), vec![i16::MAX]);
        assert_eq!(to_i16(&[-4.2]), vec![-i16::MAX]);
    }

    #[test]
    fn an_empty_drain_converts_to_nothing() {
        assert!(to_i16(&[]).is_empty());
    }

    #[test]
    fn silence_detection_is_unchanged_by_the_cloud_switch() {
        assert!(is_silence(&[]));
        assert!(is_silence(&[0.0001; 128]));
        assert!(!is_silence(&[0.2; 128]));
    }
}
