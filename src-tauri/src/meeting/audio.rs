//! The WASAPI capture engine: mic + render-loopback -> 16 kHz 2-channel FLAC
//! segments on disk (encrypted by mod.rs's record_segment).
//!
//! The shared audio-capture broker owns the default mic and render-loopback
//! devices. This engine is its lossless Meeting Notes consumer: it aligns both
//! labeled streams by wall clock, encodes segments, and watches the stop
//! channel / session lock / 4h cap on a dedicated std::thread.
//!
//! Format strategy: both clients are initialized shared-mode with
//! autoconvert, requesting 16 kHz mono f32 directly - the Windows audio
//! engine does the resample/downmix, so there is no resampler dependency and
//! no format matrix to test. Channel 0 = mic ("You"), channel 1 = loopback
//! ("Others"); the backend transcribes them separately (multichannel), which
//! is the whole reason the streams are never mixed together.
//!
//! Loopback silence: WASAPI loopback delivers packets only while something
//! renders. Each stream therefore tracks expected-frames-by-wall-clock and
//! silence-fills any deficit past a small guard, so the two channels stay
//! aligned through render-silence, and a segment is always exactly as long
//! as the wall time it spans.
//!
//! Default-device changes: each capture thread re-checks the default device
//! id every ~2s and tears down/re-opens on change (headset plugged in,
//! Bluetooth switch). A re-open that keeps failing marks the current segment
//! incomplete and ultimately fails the capture - flagged, never silent.

#![cfg(windows)]

use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};

use flacenc::component::BitRepr;
use flacenc::error::Verify;
use log::{error, info, warn};
use tauri::AppHandle;

use crate::audio_capture::{
    self, AudioSource, CaptureConsumer, CaptureEvent, Delivery, PcmFrame,
};

const SAMPLE_RATE: usize = audio_capture::SAMPLE_RATE;
/// 5-minute segments: ~10 MB of 2ch FLAC, comfortably under the backend's
/// 30 MB body cap, and small enough that losing one to a crash loses minutes.
const SEGMENT_FRAMES: usize = SAMPLE_RATE * 300;
/// Flush every valid captured frame. A short tail may contain the final words
/// of a meeting and must not disappear merely because it is under two seconds.
const MIN_SEGMENT_FRAMES: usize = 1;
/// Hard capture ceiling, every tier. TEMPORARILY CLAMPED to 60 minutes
/// (product decision 2026-07-11): meetings longer than an hour are out of
/// scope until long-meeting support lands, and capturing audio the backend
/// would discard past its own 60-minute synthesis cap is pure wasted upload.
/// The design ceiling to restore later is 4 hours (MEETING_NOTES_PLAN.md
/// section 4); the backend's caps in services/meetings/fields.py carry the
/// matching clamp note.
const MAX_CAPTURE: Duration =
    Duration::from_millis(super::evidence_store::MAX_CAPTURE_DURATION_MS as u64);
/// The reported capture length, held to MAX_CAPTURE. The backend rejects a
/// completion whose total_duration_ms exceeds its own matching cap
/// (services/meetings/fields.py MAX_CAPTURE_MINUTES) with a TERMINAL
/// invalid_manifest, which discards the whole recording. Our stop check runs
/// once per ENGINE_TICK and the teardown flush still emits whatever audio is
/// buffered, so the timeline lands tens of milliseconds past the cap about
/// half the time - one observed run reported 3_600_061 and was thrown away.
/// Clamp before the manifest digest is built so the digest and the reported
/// total agree on the same number.
fn capped_timeline_ms(emitted_ms: i64) -> i64 {
    emitted_ms.min(MAX_CAPTURE.as_millis() as i64)
}
/// Engine mixing cadence. The broker capture threads poll faster.
const ENGINE_TICK: Duration = Duration::from_millis(100);
/// Wall-clock deficit before a stream is silence-filled. Big enough to never
/// race real packets (device period is ~10ms), small enough that channel
/// alignment error stays inaudible to STT.
const FILL_GUARD_FRAMES: usize = SAMPLE_RATE / 5; // 200ms
/// A deficit past this is a clock discontinuity (system suspend, long engine
/// descheduling), not render-silence: filling it would allocate minutes or
/// hours of zeros and stamp audio the machine never captured. Reset the
/// stream clock instead and mark the segment incomplete.
const DISCONTINUITY_FRAMES: usize = SAMPLE_RATE * 10; // 10s
/// Spawns the engine (which spawns the two capture threads). Returns
/// immediately; capture-init failures surface asynchronously as a
/// `capture_failed` finalize, matching the ambient-surface rule. The caller
/// must have set the managed ActiveCapture state BEFORE calling, so the
/// failure path's finalize always has state to clear.
pub fn spawn_engine(
    app: AppHandle,
    meeting_id: String,
    capture_run_id: String,
    capture_fence: i64,
    owner_uid: String,
    event_id: String,
    runtime_instance_id: String,
    installation_id: String,
    next_seq: u32,
    timeline_base_ms: i64,
    finalization: super::FinalizationSignal,
) -> Result<Sender<String>, String> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<String>();
    super::session::ensure_watcher();
    std::thread::Builder::new()
        .name("meeting-engine".to_string())
        .spawn(move || {
            engine_thread(
                app,
                meeting_id,
                capture_run_id,
                capture_fence,
                owner_uid,
                event_id,
                runtime_instance_id,
                installation_id,
                next_seq,
                timeline_base_ms,
                stop_rx,
                finalization,
            )
        })
        .map_err(|e| format!("failed to spawn engine thread: {e}"))?;
    Ok(stop_tx)
}

/// Everything the engine tracks for one channel between segment closes.
struct ChannelState {
    channel: &'static str,
    pending: Vec<f32>,
    /// Frames accumulated toward the current segment (post-fill, i16).
    acc: Vec<i16>,
    /// Total frames this channel has produced (drained + filled) since the
    /// current clock epoch - compared against wall time for silence fill.
    produced: usize,
    epoch: Instant,
    device_id_hash: String,
}

impl ChannelState {
    fn new(channel: &'static str) -> Self {
        Self {
            channel,
            pending: Vec::new(),
            acc: Vec::new(),
            produced: 0,
            epoch: Instant::now(),
            device_id_hash: String::new(),
        }
    }

    fn reset_clock(&mut self) {
        self.produced = 0;
        self.epoch = Instant::now();
    }

    /// Drain the capture thread's buffer, then silence-fill any wall-clock
    /// deficit beyond the guard. `discard` (session locked) drops real
    /// samples instead of accumulating them. Returns true when a clock
    /// discontinuity was detected (the caller marks the segment incomplete).
    fn pump(&mut self, discard: bool) -> bool {
        let drained = std::mem::take(&mut self.pending);
        if discard {
            return false;
        }
        self.produced += drained.len();
        self.acc.extend(
            drained
                .iter()
                .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16),
        );

        let expected = (self.epoch.elapsed().as_millis() as usize) * SAMPLE_RATE / 1000;
        if expected <= self.produced + FILL_GUARD_FRAMES {
            return false;
        }
        let deficit = expected - self.produced - FILL_GUARD_FRAMES / 2;
        if deficit > DISCONTINUITY_FRAMES {
            // Suspend/resume or a long stall: the wall clock jumped, the
            // audio didn't. Re-anchor rather than fabricating the gap.
            warn!(
                "meeting.audio: clock discontinuity channel={} deficit_frames={} deficit_ms={} expected_frames={} produced_frames={} action=reanchor",
                self.channel,
                deficit,
                deficit * 1000 / SAMPLE_RATE,
                expected,
                self.produced,
            );
            self.reset_clock();
            return true;
        }
        self.acc.extend(std::iter::repeat(0i16).take(deficit));
        self.produced += deficit;
        false
    }
}

fn accept_frame(frame: PcmFrame, mic: &mut ChannelState, loopback: &mut ChannelState) {
    let _captured_at_ms = frame.captured_at_ms;
    let channel = match frame.source {
        AudioSource::Microphone => mic,
        AudioSource::Loopback => loopback,
    };
    channel.pending.extend(frame.samples.iter().copied());
}

/// Drains the broker without blocking. A disconnected lossless queue or an
/// explicit device failure must stop Meeting Notes rather than quietly lose
/// audio while the recording indicator remains active.
///
/// `final_drain` marks the one call made AFTER `capture.stop()`, where the
/// consumer's own sender is already gone by design: there, Disconnected means
/// the queue is exhausted, not that anything broke.
fn drain_capture_events(
    capture: &CaptureConsumer,
    mic: &mut ChannelState,
    loopback: &mut ChannelState,
    segment_incomplete: &mut bool,
    final_drain: bool,
) -> bool {
    loop {
        match capture.try_recv() {
            Ok(CaptureEvent::Frame(frame)) => accept_frame(frame, mic, loopback),
            Ok(CaptureEvent::DeviceBound {
                source,
                device_id_hash,
            }) => match source {
                AudioSource::Microphone => mic.device_id_hash = device_id_hash,
                AudioSource::Loopback => loopback.device_id_hash = device_id_hash,
            },
            Ok(CaptureEvent::DeviceRebound { source } | CaptureEvent::Glitch { source }) => {
                let _ = source;
                *segment_incomplete = true;
            }
            Ok(CaptureEvent::Failed { source }) => {
                error!("meeting.audio: shared capture failed source={source:?}");
                return false;
            }
            Err(TryRecvError::Empty) => return true,
            Err(TryRecvError::Disconnected) => {
                if final_drain {
                    return true;
                }
                error!("meeting.audio: lossless shared capture consumer disconnected");
                return false;
            }
        }
    }
}

fn engine_thread(
    app: AppHandle,
    meeting_id: String,
    capture_run_id: String,
    capture_fence: i64,
    owner_uid: String,
    event_id: String,
    runtime_instance_id: String,
    installation_id: String,
    next_seq: u32,
    timeline_base_ms: i64,
    stop_rx: Receiver<String>,
    finalization: super::FinalizationSignal,
) {
    let started_at_ms = super::now_ms();
    // A rejoin continues the first session's seq numbering and timeline
    // instead of overwriting its files (queue.rs keeps the entry alive).
    let mut seq = next_seq;

    // The cap is per MEETING, not per engine run: a rejoin only gets whatever
    // budget the earlier session(s) left, so drop-and-rejoin can never stack
    // sessions into more captured audio than the cap allows.
    let session_budget =
        MAX_CAPTURE.saturating_sub(Duration::from_millis(timeline_base_ms.max(0) as u64));
    if session_budget.is_zero() {
        info!("meeting.audio: cap already reached for {meeting_id}, not restarting capture");
        let result = super::finalize_capture(
            &app,
            &meeting_id,
            &capture_run_id,
            capture_fence,
            &owner_uid,
            &event_id,
            &runtime_instance_id,
            started_at_ms,
            capped_timeline_ms(timeline_base_ms),
            "max_duration",
        );
        finalization.finish(result);
        return;
    }

    let mut capture = match audio_capture::subscribe("meeting-notes", Delivery::Lossless) {
        Ok(capture) => capture,
        Err(error) => {
            error!("meeting.audio: failed to subscribe to shared capture: {error}");
            let result = super::finalize_capture(
                &app,
                &meeting_id,
                &capture_run_id,
                capture_fence,
                &owner_uid,
                &event_id,
                &runtime_instance_id,
                started_at_ms,
                capped_timeline_ms(timeline_base_ms),
                "capture_failed",
            );
            finalization.finish(result);
            return;
        }
    };
    let capture_epoch = Instant::now();

    let mut mic_state = ChannelState::new("microphone");
    let mut loop_state = ChannelState::new("system");
    let mut emitted_ms: i64 = timeline_base_ms;
    let mut segment_start_ms: i64 = timeline_base_ms;
    let mut segment_incomplete = false;
    let mut paused = false;

    let mut stop_reason: String = 'run: loop {
        // 1. External stop?
        if let Ok(reason) = stop_rx.try_recv() {
            break 'run reason;
        }
        // 2. Hard cap (this session's share of the per-meeting budget).
        if capture_epoch.elapsed() >= session_budget {
            break 'run "max_duration".to_string();
        }
        // 3. Drain shared capture. A device stream that died for good is an
        //    explicit Meeting Notes failure.
        if !drain_capture_events(
            &capture,
            &mut mic_state,
            &mut loop_state,
            &mut segment_incomplete,
            false,
        ) {
            break 'run "capture_failed".to_string();
        }
        // 4. Session lock transitions.
        let locked = super::session::is_locked();
        if locked != paused {
            paused = locked;
            if paused {
                // Close the running segment at the lock boundary; the locked
                // span simply doesn't exist in the audio timeline.
                if !close_segment(
                    &app,
                    &meeting_id,
                    &capture_run_id,
                    capture_fence,
                    &owner_uid,
                    &event_id,
                    &runtime_instance_id,
                    &installation_id,
                    started_at_ms,
                    &mut seq,
                    &mut mic_state,
                    &mut loop_state,
                    &mut segment_start_ms,
                    &mut emitted_ms,
                    &mut segment_incomplete,
                    false,
                ) {
                    break 'run "capture_failed".to_string();
                }
            } else {
                // Resume: discard whatever accumulated in the shared buffers
                // during the locked span (up to a tick of locked-session
                // audio would otherwise leak into the resumed segment), then
                // fresh clocks; the next segment starts at the wall-clock
                // offset so the gap stays visible in timestamps.
                mic_state.pump(true);
                loop_state.pump(true);
                mic_state.reset_clock();
                loop_state.reset_clock();
                segment_start_ms = timeline_base_ms + capture_epoch.elapsed().as_millis() as i64;
            }
            super::notify_paused(&app, paused);
        }
        // 5. Pump both channels (locked = drain-and-discard). A detected
        //    clock discontinuity taints the segment like a re-bind does.
        let discontinuity = mic_state.pump(paused) | loop_state.pump(paused);
        // 6. A clock discontinuity taints the segment. Broker re-bind events
        //    set the same flag while the capture queue is drained above.
        if discontinuity {
            segment_incomplete = true;
        }
        // 7. Segment full? A persistence failure (disk full, key unwrap,
        //    encode) is NOT survivable-quietly: audio is being lost while the
        //    indicator claims otherwise, so the capture stops honestly.
        while mic_state.acc.len() >= SEGMENT_FRAMES && loop_state.acc.len() >= SEGMENT_FRAMES {
            if !close_segment(
                &app,
                &meeting_id,
                &capture_run_id,
                capture_fence,
                &owner_uid,
                &event_id,
                &runtime_instance_id,
                &installation_id,
                started_at_ms,
                &mut seq,
                &mut mic_state,
                &mut loop_state,
                &mut segment_start_ms,
                &mut emitted_ms,
                &mut segment_incomplete,
                true,
            ) {
                break 'run "capture_failed".to_string();
            }
        }
        std::thread::sleep(ENGINE_TICK);
    };

    // Final flush + teardown, one funnel for every stop reason. The teardown
    // close's own failure is logged inside; the capture is ending either way.
    capture.stop();
    if !drain_capture_events(
        &capture,
        &mut mic_state,
        &mut loop_state,
        &mut segment_incomplete,
        true,
    ) {
        stop_reason = "capture_failed".to_string();
    }
    if !paused {
        if mic_state.pump(false) | loop_state.pump(false) {
            segment_incomplete = true;
        }
    }
    if !close_segment(
        &app,
        &meeting_id,
        &capture_run_id,
        capture_fence,
        &owner_uid,
        &event_id,
        &runtime_instance_id,
        &installation_id,
        started_at_ms,
        &mut seq,
        &mut mic_state,
        &mut loop_state,
        &mut segment_start_ms,
        &mut emitted_ms,
        &mut segment_incomplete,
        false,
    ) {
        stop_reason = "capture_failed".to_string();
    }
    let result = super::finalize_capture(
        &app,
        &meeting_id,
        &capture_run_id,
        capture_fence,
        &owner_uid,
        &event_id,
        &runtime_instance_id,
        started_at_ms,
        capped_timeline_ms(emitted_ms),
        &stop_reason,
    );
    finalization.finish(result);
}

/// Closes the current accumulation into one FLAC segment (padding the shorter
/// channel so both are equal length), records it, and re-arms the next
/// segment's start offset. `exact` takes exactly SEGMENT_FRAMES (mid-capture
/// close); otherwise everything accumulated is flushed (stop/pause), and
/// an entirely empty tail is ignored. Returns false when the segment could not
/// be persisted (encode/encrypt/disk) - audio was lost, and the
/// engine must stop rather than keep signaling a healthy recording.
#[allow(clippy::too_many_arguments)]
fn close_segment(
    app: &AppHandle,
    meeting_id: &str,
    capture_run_id: &str,
    capture_fence: i64,
    owner_uid: &str,
    event_id: &str,
    runtime_instance_id: &str,
    installation_id: &str,
    started_at_ms: i64,
    seq: &mut u32,
    mic: &mut ChannelState,
    loopback: &mut ChannelState,
    segment_start_ms: &mut i64,
    emitted_ms: &mut i64,
    segment_incomplete: &mut bool,
    exact: bool,
) -> bool {
    let frames = if exact {
        SEGMENT_FRAMES
    } else {
        mic.acc.len().max(loopback.acc.len())
    };
    if frames < MIN_SEGMENT_FRAMES {
        mic.acc.clear();
        loopback.acc.clear();
        return true;
    }

    // Keep the only in-memory samples intact until the encrypted file and its
    // SQLite row commit. A failed encode or publication must never consume
    // the tail and then let finalization describe the shorter evidence as a
    // healthy capture.
    let mic_frames = snapshot_padded(&mic.acc, frames);
    let loop_frames = snapshot_padded(&loopback.acc, frames);

    let mut interleaved: Vec<i32> = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        interleaved.push(mic_frames[i] as i32);
        interleaved.push(loop_frames[i] as i32);
    }

    let duration_ms = (frames * 1000 / SAMPLE_RATE) as i64;
    let persisted = match encode_flac(&interleaved) {
        Ok(flac) => {
            let incomplete = *segment_incomplete;
            match super::record_segment(
                app,
                meeting_id,
                capture_run_id,
                capture_fence,
                owner_uid,
                event_id,
                runtime_instance_id,
                installation_id,
                started_at_ms,
                *seq,
                *segment_start_ms,
                duration_ms,
                &flac,
                incomplete,
                segment_audio_metrics(&mic_frames, &loop_frames, mic, loopback),
            ) {
                Ok(()) => {
                    info!(
                        "meeting.audio: segment closed meeting={meeting_id} run={capture_run_id} fence={capture_fence} seq={seq} duration_ms={duration_ms} bytes={}{}",
                        flac.len(),
                        if incomplete { ", incomplete" } else { "" },
                    );
                    true
                }
                Err(e) => {
                    error!("meeting.audio: failed to record segment {seq}: {e}");
                    false
                }
            }
        }
        Err(e) => {
            error!("meeting.audio: FLAC encode failed for segment {seq}: {e}");
            false
        }
    };

    if persisted {
        drain_committed(&mut mic.acc, frames);
        drain_committed(&mut loopback.acc, frames);
        *seq += 1;
        *segment_start_ms += duration_ms;
        *emitted_ms = (*emitted_ms).max(*segment_start_ms);
        *segment_incomplete = false;
    }
    persisted
}

fn snapshot_padded(acc: &[i16], frames: usize) -> Vec<i16> {
    let take = frames.min(acc.len());
    let mut out = acc[..take].to_vec();
    out.resize(frames, 0);
    out
}

fn drain_committed(acc: &mut Vec<i16>, frames: usize) {
    let take = frames.min(acc.len());
    acc.drain(..take);
}

fn segment_audio_metrics(
    mic: &[i16],
    system: &[i16],
    mic_state: &ChannelState,
    system_state: &ChannelState,
) -> super::queue::SegmentAudioMetrics {
    let mic_values = channel_metrics(mic);
    let system_values = channel_metrics(system);
    super::queue::SegmentAudioMetrics {
        mic_rms_dbfs: mic_values.0,
        system_rms_dbfs: system_values.0,
        mic_clipping_ratio: mic_values.1,
        system_clipping_ratio: system_values.1,
        mic_zero_ratio: mic_values.2,
        system_zero_ratio: system_values.2,
        mic_vad_speech_ms: mic_values.3,
        system_vad_speech_ms: system_values.3,
        mic_device_id_hash: mic_state.device_id_hash.clone(),
        system_device_id_hash: system_state.device_id_hash.clone(),
    }
}

/// Returns RMS dBFS, clipping ratio, zero-sample ratio, and a conservative
/// energy-derived VAD duration. The VAD is diagnostic evidence and a backend
/// quality-gate input, not a speech transcription decision.
fn channel_metrics(samples: &[i16]) -> (f64, f64, f64, i64) {
    if samples.is_empty() {
        return (-120.0, 0.0, 1.0, 0);
    }
    let mut square_sum = 0.0;
    let mut clipping = 0usize;
    let mut zero = 0usize;
    for &sample in samples {
        let normalized = sample as f64 / 32768.0;
        square_sum += normalized * normalized;
        let magnitude = (sample as i32).unsigned_abs();
        if magnitude >= 32_760 {
            clipping += 1;
        }
        if magnitude <= 1 {
            zero += 1;
        }
    }
    let rms = (square_sum / samples.len() as f64).sqrt();
    let rms_dbfs = if rms <= f64::EPSILON {
        -120.0
    } else {
        (20.0 * rms.log10()).max(-120.0)
    };

    const VAD_WINDOW: usize = SAMPLE_RATE / 50; // 20 ms
    const VAD_RMS_THRESHOLD: f64 = 0.01; // approximately -40 dBFS
    let mut speech_frames = 0usize;
    for window in samples.chunks(VAD_WINDOW) {
        let energy = window
            .iter()
            .map(|sample| {
                let value = *sample as f64 / 32768.0;
                value * value
            })
            .sum::<f64>()
            / window.len().max(1) as f64;
        if energy.sqrt() >= VAD_RMS_THRESHOLD {
            speech_frames += window.len();
        }
    }
    (
        rms_dbfs,
        clipping as f64 / samples.len() as f64,
        zero as f64 / samples.len() as f64,
        (speech_frames * 1000 / SAMPLE_RATE) as i64,
    )
}

fn encode_flac(interleaved: &[i32]) -> Result<Vec<u8>, String> {
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| format!("flac config: {e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(interleaved, 2, 16, SAMPLE_RATE);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| format!("flac encode: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| format!("flac write: {e:?}"))?;
    Ok(sink.as_slice().to_vec())
}

#[cfg(test)]
mod tests {
    use super::{channel_metrics, SAMPLE_RATE};

    #[test]
    fn channel_metrics_reports_silence_without_false_speech() {
        let samples = vec![0_i16; SAMPLE_RATE];
        let (rms_dbfs, clipping_ratio, zero_ratio, speech_ms) = channel_metrics(&samples);

        assert_eq!(rms_dbfs, -120.0);
        assert_eq!(clipping_ratio, 0.0);
        assert_eq!(zero_ratio, 1.0);
        assert_eq!(speech_ms, 0);
    }

    #[test]
    fn channel_metrics_reports_energy_and_vad_duration() {
        let samples = vec![16_384_i16; SAMPLE_RATE];
        let (rms_dbfs, clipping_ratio, zero_ratio, speech_ms) = channel_metrics(&samples);

        assert!((-6.03..=-6.01).contains(&rms_dbfs));
        assert_eq!(clipping_ratio, 0.0);
        assert_eq!(zero_ratio, 0.0);
        assert_eq!(speech_ms, 1_000);
    }

    #[test]
    fn channel_metrics_counts_positive_and_negative_clipping() {
        let samples = [32_767_i16, -32_768_i16, 0_i16, 1_i16];
        let (_, clipping_ratio, zero_ratio, _) = channel_metrics(&samples);

        assert_eq!(clipping_ratio, 0.5);
        assert_eq!(zero_ratio, 0.5);
    }
}
