//! FLAC for the wire only.
//!
//! The local trace store keeps WAV, because that is what NeMo's dataset guide
//! recommends and what a local export has to hand a training pipeline. Upload is
//! a different problem: FLAC is lossless, so the training pair is byte-identical
//! after decode, and it roughly halves what a user's connection has to carry.
//!
//! `flacenc` is already a dependency for meeting capture, and this follows the
//! same four calls `meeting/audio.rs::encode_flac` makes - config, source,
//! encode, sink - differing only in being mono rather than stereo.

#![cfg(windows)]

use flacenc::component::BitRepr;
use flacenc::error::Verify;

use super::super::stt::SAMPLE_RATE;

const CHANNELS: usize = 1;
const BITS_PER_SAMPLE: usize = 16;
/// Byte offset of the `data` chunk payload in the header `wav::encode` writes.
/// That writer emits a fixed 44-byte canonical header, so this never has to
/// parse chunks - but it does verify the magic before trusting the offset.
const WAV_HEADER_BYTES: usize = 44;

/// Re-encodes the stored WAV as FLAC.
///
/// Takes the stored bytes rather than the original `f32` samples because the
/// upload path runs long after the utterance, from disk, and re-deriving the
/// samples any other way would risk a copy that is not what was actually kept.
pub fn from_wav(wav: &[u8]) -> Result<Vec<u8>, String> {
    if wav.len() < WAV_HEADER_BYTES || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("stored audio is not the expected RIFF/WAVE".to_string());
    }
    let payload = &wav[WAV_HEADER_BYTES..];
    // `i32` because that is what `MemSource::from_samples` consumes; the values
    // are still 16-bit, which is what the `bits_per_sample` argument declares.
    let samples: Vec<i32> = payload
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as i32)
        .collect();
    if samples.is_empty() {
        return Err("stored audio has no samples".to_string());
    }

    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| format!("flac config: {e:?}"))?;
    let source =
        flacenc::source::MemSource::from_samples(&samples, CHANNELS, BITS_PER_SAMPLE, SAMPLE_RATE as usize);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| format!("flac encode: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| format!("flac write: {e:?}"))?;
    Ok(sink.as_slice().to_vec())
}
