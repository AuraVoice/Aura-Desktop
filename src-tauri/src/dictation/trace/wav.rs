//! Utterance audio as a plain RIFF/WAVE file.
//!
//! NeMo's dataset guide recommends WAV, and every ASR tool in that ecosystem
//! reads it without help. Deliberately NOT the FLAC path `meeting/` uses: that
//! module encodes long multi-hour captures where the size matters, whereas a
//! dictation utterance is a handful of seconds and the training pipeline wants
//! the least surprising container it can get.
//!
//! The samples arrive as mono 16 kHz f32 straight from `dictation::audio`,
//! because the Windows audio engine is opened with autoconvert and delivers
//! that regardless of the device's native format. Nothing here resamples.

#![cfg(windows)]

use super::super::stt::SAMPLE_RATE;

const BITS_PER_SAMPLE: u16 = 16;
const CHANNELS: u16 = 1;
const HEADER_BYTES: usize = 44;

/// Encodes f32 samples in -1.0..1.0 as a 16-bit PCM WAV.
///
/// Clamped before scaling: a sample slightly outside the range (which a gain
/// stage upstream can produce) would otherwise wrap to full-scale opposite sign
/// and put a click in the training audio.
pub fn encode(samples: &[f32]) -> Vec<u8> {
    let data_bytes = samples.len() * 2;
    let mut out = Vec::with_capacity(HEADER_BYTES + data_bytes);
    let byte_rate = SAMPLE_RATE as u32 * CHANNELS as u32 * (BITS_PER_SAMPLE as u32 / 8);
    let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // format: PCM
    out.extend_from_slice(&CHANNELS.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());

    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        out.extend_from_slice(&((clamped * i16::MAX as f32) as i16).to_le_bytes());
    }
    out
}

/// How long `samples` runs for, in milliseconds. The manifest needs a duration
/// and this is the only place that knows the sample rate the file was written
/// at.
pub fn duration_ms(samples: &[f32]) -> u32 {
    ((samples.len() as f64 * 1000.0) / SAMPLE_RATE as f64) as u32
}
