//! Meeting Notes "Upload recording": a lecture or a voice memo the user already
//! has, turned into the same encrypted 5-minute FLAC segments a live capture
//! writes, so the upload pump, completion and recovery treat it exactly like a
//! recording made here.
//!
//! Two steps, because the claim is what costs the user a meeting from their
//! monthly allowance:
//!
//!   1. `meeting_prepare_import` takes the file's bytes, decodes and resamples
//!      them, and holds the finished segments in memory. A file Aura cannot
//!      read, one with no audio, or one past the 120 minute cap is refused
//!      here, before anything is claimed.
//!   2. JS claims the meeting (`source: "upload"`), then
//!      `meeting_commit_import` encrypts and queues those segments under the
//!      claimed run and finalizes it. The upload pump does the rest.
//!
//! Single-source layout, same as an in-person capture: all speech on channel 0,
//! channel 1 zero. The backend diarizes channel 0 for these.

use std::io::Cursor;
use std::sync::Mutex;

use log::{info, warn};
use rubato::{FftFixedInOut, Resampler};
use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Manager};

use super::{audio, evidence_store, queue};

const SAMPLE_RATE: usize = 16_000;
const SEGMENT_FRAMES: usize = SAMPLE_RATE * 300;
const MAX_IMPORT_MS: i64 = evidence_store::MAX_CAPTURE_DURATION_MS;
/// Larger than any honest recording of two hours (a 320 kbps mp3 is ~290 MB);
/// past it the bytes are not worth holding in memory to find out.
const MAX_IMPORT_BYTES: usize = 400 * 1024 * 1024;
/// A prepared import nobody committed is dropped after this, so a closed
/// dialog never pins tens of megabytes for the life of the app.
const PREPARED_TTL_MS: i64 = 15 * 60 * 1000;

struct PreparedSegment {
    flac: Vec<u8>,
    duration_ms: i64,
    metrics: queue::SegmentAudioMetrics,
}

struct PreparedImport {
    token: String,
    owner_uid: String,
    prepared_at_ms: i64,
    duration_ms: i64,
    segments: Vec<PreparedSegment>,
}

static PREPARED: Mutex<Option<PreparedImport>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProbe {
    pub token: String,
    pub duration_ms: i64,
    pub segment_count: usize,
}

/// Stable refusal codes the Meetings page maps to copy.
fn refusal(code: &str) -> String {
    code.to_string()
}

/// Mono f32 at the source rate -> mono i16 at 16 kHz, streamed through one
/// FFT resampler so a two-hour file never sits in memory at 48 kHz.
struct Downsampler {
    resampler: Option<FftFixedInOut<f32>>,
    pending: Vec<f32>,
    out: Vec<i16>,
}

impl Downsampler {
    fn new(source_rate: usize) -> Result<Self, String> {
        let resampler = if source_rate == SAMPLE_RATE {
            None
        } else {
            Some(
                FftFixedInOut::<f32>::new(source_rate, SAMPLE_RATE, 4096, 1)
                    .map_err(|e| format!("resampler: {e}"))?,
            )
        };
        Ok(Self { resampler, pending: Vec::new(), out: Vec::new() })
    }

    fn push(&mut self, samples: &[f32]) -> Result<(), String> {
        let Some(resampler) = self.resampler.as_mut() else {
            self.out.extend(samples.iter().map(|s| to_i16(*s)));
            return Ok(());
        };
        self.pending.extend_from_slice(samples);
        loop {
            let need = resampler.input_frames_next();
            if self.pending.len() < need {
                return Ok(());
            }
            let chunk: Vec<f32> = self.pending.drain(..need).collect();
            let output = resampler
                .process(&[chunk], None)
                .map_err(|e| format!("resample: {e}"))?;
            self.out.extend(output[0].iter().map(|s| to_i16(*s)));
        }
    }

    fn finish(&mut self) -> Result<(), String> {
        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(());
        };
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            let output = resampler
                .process_partial(Some(&[rest]), None)
                .map_err(|e| format!("resample: {e}"))?;
            self.out.extend(output[0].iter().map(|s| to_i16(*s)));
        }
        Ok(())
    }
}

fn to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * 32767.0) as i16
}

fn close_segment(mono: &[i16], segments: &mut Vec<PreparedSegment>) -> Result<(), String> {
    let mut interleaved = Vec::with_capacity(mono.len() * 2);
    for sample in mono {
        interleaved.push(*sample as i32);
        interleaved.push(0);
    }
    let flac = audio::encode_flac(&interleaved, 2)?;
    let (rms, clipping, zero, vad_ms) = audio::channel_metrics(mono);
    segments.push(PreparedSegment {
        flac,
        duration_ms: (mono.len() * 1000 / SAMPLE_RATE) as i64,
        metrics: queue::SegmentAudioMetrics {
            mic_rms_dbfs: rms,
            system_rms_dbfs: -120.0,
            mic_clipping_ratio: clipping,
            system_clipping_ratio: 0.0,
            mic_zero_ratio: zero,
            system_zero_ratio: 1.0,
            mic_vad_speech_ms: vad_ms,
            system_vad_speech_ms: 0,
            mic_device_id_hash: "upload".to_string(),
            system_device_id_hash: String::new(),
        },
    });
    Ok(())
}

/// Decode, downmix, resample and cut into encoded segments. Refuses with a
/// stable code: unsupported_format, no_audio, too_long, decode_failed.
fn decode_to_segments(bytes: Vec<u8>, extension: &str) -> Result<(i64, Vec<PreparedSegment>), String> {
    let mut hint = Hint::new();
    if !extension.is_empty() {
        hint.with_extension(extension);
    }
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|_| refusal("unsupported_format"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| refusal("no_audio"))?;
    let track_id = track.id;
    let source_rate = track.codec_params.sample_rate.ok_or_else(|| refusal("unsupported_format"))? as usize;
    // Refuse a too-long file from its header when it declares a length, before
    // spending a minute decoding it.
    if let Some(frames) = track.codec_params.n_frames {
        if (frames as i64) * 1000 / source_rate.max(1) as i64 > MAX_IMPORT_MS {
            return Err(refusal("too_long"));
        }
    }
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| refusal("unsupported_format"))?;

    let mut down = Downsampler::new(source_rate)?;
    let mut segments: Vec<PreparedSegment> = Vec::new();
    let mut total_frames: usize = 0;
    let mut mono: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => {
                warn!("meeting.import: demux stopped early: {error}");
                break;
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // One corrupt frame is skipped, as every player does.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) => return Err(refusal("decode_failed")),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        mono.clear();
        mono.extend(
            buffer
                .samples()
                .chunks(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
        down.push(&mono)?;
        while down.out.len() >= SEGMENT_FRAMES {
            let segment: Vec<i16> = down.out.drain(..SEGMENT_FRAMES).collect();
            total_frames += segment.len();
            if (total_frames * 1000 / SAMPLE_RATE) as i64 > MAX_IMPORT_MS {
                return Err(refusal("too_long"));
            }
            close_segment(&segment, &mut segments)?;
        }
    }
    down.finish()?;
    if !down.out.is_empty() {
        let tail = std::mem::take(&mut down.out);
        total_frames += tail.len();
        if (total_frames * 1000 / SAMPLE_RATE) as i64 > MAX_IMPORT_MS {
            return Err(refusal("too_long"));
        }
        close_segment(&tail, &mut segments)?;
    }
    if segments.is_empty() || segments.iter().all(|s| s.metrics.mic_vad_speech_ms == 0) {
        return Err(refusal("no_audio"));
    }
    Ok(((total_frames * 1000 / SAMPLE_RATE) as i64, segments))
}

/// Step 1. The body is the file's raw bytes (`invoke(cmd, bytes, {headers})`);
/// the `x-file-name` header only hints the container from its extension.
#[tauri::command]
pub async fn meeting_prepare_import(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<ImportProbe, String> {
    let ticket = crate::security::authorize(&app, crate::security::Operation::StartMeetingCapture)?;
    let tauri::ipc::InvokeBody::Raw(raw) = request.body() else {
        return Err(refusal("unsupported_format"));
    };
    if raw.len() > MAX_IMPORT_BYTES {
        return Err(refusal("too_long"));
    }
    let bytes = raw.clone();
    let extension = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()))
        .unwrap_or_default();
    // Drop any earlier, uncommitted import first: one in memory at a time.
    *PREPARED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let byte_count = bytes.len();
    let (duration_ms, segments) =
        tauri::async_runtime::spawn_blocking(move || decode_to_segments(bytes, &extension))
            .await
            .map_err(|e| e.to_string())??;
    crate::security::recheck(&app, crate::security::Operation::StartMeetingCapture, &ticket)?;
    // Only one import is ever held, so the token just has to tell this one
    // from the last: time, size and a counter are enough.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let token = crate::util::sha256_hex(format!("{}:{byte_count}:{nonce}", super::now_ms()))[..32].to_string();
    let probe = ImportProbe { token: token.clone(), duration_ms, segment_count: segments.len() };
    info!(
        "meeting.import: prepared bytes={byte_count} duration_ms={duration_ms} segments={}",
        segments.len()
    );
    *PREPARED.lock().unwrap_or_else(|e| e.into_inner()) = Some(PreparedImport {
        token,
        owner_uid: ticket.uid().to_string(),
        prepared_at_ms: super::now_ms(),
        duration_ms,
        segments,
    });
    Ok(probe)
}

/// Step 2, after a successful claim: queue the prepared segments under the
/// claimed run and finalize it, so the upload pump sends them.
#[tauri::command]
pub async fn meeting_commit_import(
    app: AppHandle,
    token: String,
    meeting_id: String,
    capture_run_id: String,
    capture_fence: i64,
    event_id: String,
) -> Result<(), String> {
    if !app.state::<super::MeetingRuntimeLease>().owns_runtime() {
        return Err("meeting runtime is owned by another Aura process".to_string());
    }
    let ticket = crate::security::authorize(&app, crate::security::Operation::StartMeetingCapture)?;
    queue::validate_meeting_id(&meeting_id)?;
    queue::validate_capture_run_id(&capture_run_id)?;
    let prepared = {
        let mut guard = PREPARED.lock().unwrap_or_else(|e| e.into_inner());
        match guard.take() {
            Some(prepared)
                if prepared.token == token
                    && prepared.owner_uid == ticket.uid()
                    && super::now_ms() - prepared.prepared_at_ms <= PREPARED_TTL_MS =>
            {
                prepared
            }
            other => {
                *guard = other;
                return Err(refusal("import_expired"));
            }
        }
    };
    let owner_uid = ticket.uid().to_string();
    let runtime_instance_id = app.state::<super::MeetingRuntimeLease>().runtime_instance_id().to_string();
    let installation_id = queue::installation_id(&app)?;
    let started_at_ms = super::now_ms();
    let run = queue::CaptureRunRef {
        owner_uid: owner_uid.clone(),
        meeting_id: meeting_id.clone(),
        capture_run_id: capture_run_id.clone(),
        capture_fence,
        event_id: event_id.clone(),
        runtime_instance_id: runtime_instance_id.clone(),
        installation_id: installation_id.clone(),
    };
    let begin = queue::BeginCapture {
        meeting_id,
        capture_run_id,
        capture_fence,
        protocol_version: evidence_store::PROTOCOL_VERSION,
        owner_uid,
        event_id,
        started_at_ms,
        runtime_instance_id,
        installation_id,
    };
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let (mut seq, mut start_ms) = queue::begin_capture(&worker_app, &begin)?;
        for segment in prepared.segments {
            super::record_segment(
                &worker_app,
                &run,
                started_at_ms,
                super::SegmentSpan {
                    seq,
                    start_ms,
                    duration_ms: segment.duration_ms,
                    incomplete: false,
                },
                &segment.flac,
                segment.metrics,
            )?;
            seq += 1;
            start_ms += segment.duration_ms;
        }
        queue::finalize_capture(&worker_app, &run, prepared.duration_ms.min(MAX_IMPORT_MS), "imported")?;
        info!(
            "meeting.import: queued meeting={} run={} segments={seq}",
            run.meeting_id, run.capture_run_id
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The user closed the dialog, or the claim was refused: free the memory.
#[tauri::command]
pub fn meeting_discard_import(token: String) {
    let mut guard = PREPARED.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().is_some_and(|prepared| prepared.token == token) {
        *guard = None;
    }
}
