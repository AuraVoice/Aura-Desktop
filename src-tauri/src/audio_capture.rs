//! Shared microphone and system-audio capture.
//!
//! One broker owns both default sources and fans timestamped 16 kHz mono PCM
//! frames out to named consumers. Meeting Notes uses a lossless queue because
//! dropping audio would corrupt its durable recording. Live consumers use a
//! bounded queue and `try_send`; a slow recognizer can observe overflow and
//! enter a degraded state without ever blocking Meeting Notes.
//!
//! Everything above the `backend` module is portable: the consumer registry,
//! the generation/cancellation handshake, the reopen budget and the capture
//! loop are all plain Rust and behave identically on both platforms. `backend`
//! is the whole platform seam, and it is narrow by design - open a source,
//! drain whatever it has, name the device it bound to.
//!
//! The two backends are NOT symmetric in one important way. WASAPI shared mode
//! with `autoconvert: true` asks the Windows audio engine for 16 kHz mono f32
//! and gets it, which is why this tree has no resampler dependency. Core Audio
//! has no such thing, so the macOS backend carries its own conversion (see
//! `macos_audio::Resampler`). Everything downstream sees the same format either
//! way, which is the point of putting the seam here.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{error, info, warn};

pub(crate) const SAMPLE_RATE: usize = 16_000;
// Drained every tick, so this is the dominant per-cycle capture latency for the
// interview companion (the WASAPI buffer_duration_hns below is ring CAPACITY, not
// delay). 20ms halves the average add over the old 40ms while draining Meeting
// Notes' shared stream more often, not less, so it never reduces that lossless
// consumer's starvation tolerance.
const CAPTURE_POLL: Duration = Duration::from_millis(20);
const DEVICE_CHECK_EVERY: Duration = Duration::from_secs(2);
const MAX_REOPEN_ATTEMPTS: u32 = 5;
// Wait between a failed capture attempt and the next open, scaled by attempt.
const REOPEN_BACKOFF: Duration = Duration::from_millis(500);
// How long a stream must survive before it counts as healthy enough to clear
// the reopen budget. Without this, a device that opens cleanly and then errors
// on its first read resets the counter on every cycle and never gives up.
const STREAM_STABLE_AFTER: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AudioSource {
    Microphone,
    Loopback,
}

#[derive(Clone)]
pub(crate) struct PcmFrame {
    pub source: AudioSource,
    pub captured_at_ms: u64,
    pub captured_at_unix_ms: u64,
    pub samples: Arc<[f32]>,
}

#[derive(Clone)]
pub(crate) enum CaptureEvent {
    Frame(PcmFrame),
    DeviceBound {
        source: AudioSource,
        device_id_hash: String,
    },
    DeviceRebound {
        source: AudioSource,
    },
    /// A packet whose timing did not follow the previous one (WASAPI's
    /// DATA_DISCONTINUITY / TIMESTAMP_ERROR). Microsoft documents both as a
    /// stream state transition or timing glitch, NOT a device failure: they are
    /// set routinely at stream start and whenever a render stream goes idle and
    /// resumes. A consumer may mark its output non-contiguous, but must never
    /// treat one as the stream dying - that is what DeviceRebound is for.
    Glitch {
        source: AudioSource,
    },
    Failed {
        source: AudioSource,
    },
}

pub(crate) enum Delivery {
    Lossless,
    #[allow(dead_code)]
    Bounded { capacity: usize },
}

#[derive(Clone)]
enum ConsumerSender {
    Lossless(Sender<CaptureEvent>),
    Bounded(SyncSender<CaptureEvent>),
}

struct ConsumerEntry {
    name: String,
    sender: ConsumerSender,
    overflowed: Arc<AtomicBool>,
}

#[derive(Default)]
struct SourceStatus {
    device_id_hash: Option<String>,
    failed: bool,
}

struct BrokerState {
    generation: u64,
    next_consumer_id: u64,
    consumers: HashMap<u64, ConsumerEntry>,
    cancellation: Arc<AtomicBool>,
    origin: Instant,
    microphone: SourceStatus,
    loopback: SourceStatus,
}

impl Default for BrokerState {
    fn default() -> Self {
        Self {
            generation: 0,
            next_consumer_id: 0,
            consumers: HashMap::new(),
            cancellation: Arc::new(AtomicBool::new(false)),
            origin: Instant::now(),
            microphone: SourceStatus::default(),
            loopback: SourceStatus::default(),
        }
    }
}

static BROKER: OnceLock<Mutex<BrokerState>> = OnceLock::new();

fn broker() -> &'static Mutex<BrokerState> {
    BROKER.get_or_init(|| Mutex::new(BrokerState::default()))
}

pub(crate) struct CaptureConsumer {
    id: u64,
    receiver: Receiver<CaptureEvent>,
    #[allow(dead_code)]
    overflowed: Arc<AtomicBool>,
    active: bool,
}

impl CaptureConsumer {
    pub fn try_recv(&self) -> Result<CaptureEvent, TryRecvError> {
        self.receiver.try_recv()
    }

    /// A bounded consumer calls this from its own loop. `true` means at least
    /// one frame or status event was dropped since the previous call.
    #[allow(dead_code)]
    pub fn take_overflowed(&self) -> bool {
        self.overflowed.swap(false, Ordering::Relaxed)
    }

    /// Stops delivery to this consumer but leaves its receiver available for
    /// one final drain. If it was the last consumer, device capture is stopped.
    pub fn stop(&mut self) {
        if !self.active {
            return;
        }
        let mut state = broker().lock().unwrap_or_else(|error| error.into_inner());
        state.consumers.remove(&self.id);
        if state.consumers.is_empty() {
            state.cancellation.store(true, Ordering::Relaxed);
        }
        self.active = false;
    }
}

impl Drop for CaptureConsumer {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(crate) fn subscribe(name: &str, delivery: Delivery) -> Result<CaptureConsumer, String> {
    if name.trim().is_empty() {
        return Err("audio capture consumer needs a name".to_string());
    }
    let overflowed = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = match delivery {
        Delivery::Lossless => {
            let (sender, receiver) = std::sync::mpsc::channel();
            (ConsumerSender::Lossless(sender), receiver)
        }
        Delivery::Bounded { capacity } => {
            if capacity == 0 {
                return Err("audio capture consumer queue must have capacity".to_string());
            }
            let (sender, receiver) = std::sync::mpsc::sync_channel(capacity);
            (ConsumerSender::Bounded(sender), receiver)
        }
    };

    let replay_sender = sender.clone();
    let (id, generation, cancellation, origin, start_capture, initial_events, restart_sources) = {
        let mut state = broker().lock().unwrap_or_else(|error| error.into_inner());
        if state.consumers.values().any(|consumer| consumer.name == name) {
            return Err(format!("audio capture consumer '{name}' is already active"));
        }
        let start_capture = state.consumers.is_empty();
        if start_capture {
            state.generation = state.generation.wrapping_add(1);
            state.cancellation = Arc::new(AtomicBool::new(false));
            state.origin = Instant::now();
            state.microphone = SourceStatus::default();
            state.loopback = SourceStatus::default();
        }
        state.next_consumer_id = state.next_consumer_id.wrapping_add(1);
        let id = state.next_consumer_id;
        let generation = state.generation;
        let cancellation = state.cancellation.clone();
        let origin = state.origin;
        let mut initial_events = Vec::new();
        let mut restart_sources = Vec::new();
        if !start_capture {
            for source in [AudioSource::Microphone, AudioSource::Loopback] {
                let status = source_status_mut(&mut state, source);
                if status.failed {
                    // The thread that set this has already exited, and only a
                    // DeviceBound from a LIVE thread ever clears the flag, so
                    // replaying the failure would sink this consumer and every
                    // later one for as long as some other consumer keeps the
                    // broker alive. A new subscriber is exactly the moment to
                    // retry the device instead.
                    status.failed = false;
                    status.device_id_hash = None;
                    restart_sources.push(source);
                    continue;
                }
                if let Some(device_id_hash) = &status.device_id_hash {
                    initial_events.push(CaptureEvent::DeviceBound {
                        source,
                        device_id_hash: device_id_hash.clone(),
                    });
                }
            }
        }
        state.consumers.insert(
            id,
            ConsumerEntry {
                name: name.to_string(),
                sender,
                overflowed: overflowed.clone(),
            },
        );
        (
            id,
            generation,
            cancellation,
            origin,
            start_capture,
            initial_events,
            restart_sources,
        )
    };

    for event in initial_events {
        deliver(&replay_sender, &overflowed, event);
    }
    if start_capture {
        spawn_capture_thread(
            AudioSource::Microphone,
            generation,
            cancellation.clone(),
            origin,
        );
        spawn_capture_thread(
            AudioSource::Loopback,
            generation,
            cancellation.clone(),
            origin,
        );
    }
    for source in restart_sources {
        info!(
            "audio.capture: restarting failed source={} for consumer '{name}'",
            source_name(source),
        );
        spawn_capture_thread(source, generation, cancellation.clone(), origin);
    }

    Ok(CaptureConsumer {
        id,
        receiver,
        overflowed,
        active: true,
    })
}

fn source_status_mut(state: &mut BrokerState, source: AudioSource) -> &mut SourceStatus {
    match source {
        AudioSource::Microphone => &mut state.microphone,
        AudioSource::Loopback => &mut state.loopback,
    }
}

fn publish(generation: u64, event: CaptureEvent) {
    let mut state = broker().lock().unwrap_or_else(|error| error.into_inner());
    if state.generation != generation {
        return;
    }
    match &event {
        CaptureEvent::DeviceBound {
            source,
            device_id_hash,
        } => {
            let status = source_status_mut(&mut state, *source);
            status.device_id_hash = Some(device_id_hash.clone());
            status.failed = false;
        }
        CaptureEvent::Failed { source } => {
            source_status_mut(&mut state, *source).failed = true;
        }
        CaptureEvent::Frame(_)
        | CaptureEvent::DeviceRebound { .. }
        | CaptureEvent::Glitch { .. } => {}
    }
    state
        .consumers
        .retain(|_, consumer| deliver(&consumer.sender, &consumer.overflowed, event.clone()));
    if state.consumers.is_empty() {
        state.cancellation.store(true, Ordering::Relaxed);
    }
}

fn deliver(
    sender: &ConsumerSender,
    overflowed: &AtomicBool,
    event: CaptureEvent,
) -> bool {
    match sender {
        ConsumerSender::Lossless(sender) => sender.send(event.clone()).is_ok(),
        ConsumerSender::Bounded(sender) => match sender.try_send(event.clone()) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                overflowed.store(true, Ordering::Relaxed);
                true
            }
            Err(TrySendError::Disconnected(_)) => false,
        },
    }
}

fn spawn_capture_thread(
    source: AudioSource,
    generation: u64,
    cancellation: Arc<AtomicBool>,
    origin: Instant,
) {
    let name = match source {
        AudioSource::Microphone => "audio-capture-mic",
        AudioSource::Loopback => "audio-capture-loopback",
    };
    if let Err(error) = std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || capture_thread(source, generation, cancellation, origin))
    {
        error!("audio.capture: failed to spawn {name}: {error}");
        publish(generation, CaptureEvent::Failed { source });
    }
}

fn capture_thread(
    source: AudioSource,
    generation: u64,
    cancellation: Arc<AtomicBool>,
    origin: Instant,
) {
    if let Err(error) = backend::init_thread() {
        error!(
            "audio.capture: init failed source={}: {error}",
            source_name(source)
        );
        publish(generation, CaptureEvent::Failed { source });
        return;
    }
    let mut reopen_attempts = 0u32;
    // Set on every successful open, read only by the failure paths below it.
    let mut stream_started;

    'lifetime: loop {
        if cancellation.load(Ordering::Relaxed) {
            break;
        }
        let (mut stream, device_id) = match backend::DeviceStream::open(source) {
            Ok(opened) => {
                stream_started = Instant::now();
                opened
            }
            Err(error) => {
                warn!(
                    "audio.capture: open source={} failed: {error}",
                    source_name(source),
                );
                if !backoff_before_reopen(
                    source,
                    generation,
                    &cancellation,
                    &mut reopen_attempts,
                    Duration::ZERO,
                ) {
                    break;
                }
                continue;
            }
        };
        let device_id_hash = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(device_id.as_bytes()))
        };
        publish(
            generation,
            CaptureEvent::DeviceBound {
                source,
                device_id_hash,
            },
        );

        let mut last_device_check = Instant::now();
        loop {
            if cancellation.load(Ordering::Relaxed) {
                stream.stop();
                break 'lifetime;
            }
            // One drain takes EVERY frame the source has queued, so captured
            // speech is never replaced by alignment zeros.
            let (samples, glitches) = match stream.drain() {
                Ok(drained) => drained,
                Err(error) => {
                    warn!(
                        "audio.capture: source={} {error}",
                        source_name(source),
                    );
                    stream.stop();
                    publish(generation, CaptureEvent::DeviceRebound { source });
                    if !backoff_before_reopen(
                        source,
                        generation,
                        &cancellation,
                        &mut reopen_attempts,
                        stream_started.elapsed(),
                    ) {
                        break 'lifetime;
                    }
                    continue 'lifetime;
                }
            };
            // One event per glitch the drain saw, not one per drain: a consumer
            // only latches these into "this segment is incomplete", but keeping
            // the count faithful means the Windows path emits exactly what it
            // always did.
            for _ in 0..glitches {
                publish(generation, CaptureEvent::Glitch { source });
            }
            if !samples.is_empty() {
                publish(
                    generation,
                    CaptureEvent::Frame(PcmFrame {
                        source,
                        captured_at_ms: origin.elapsed().as_millis() as u64,
                        captured_at_unix_ms: crate::util::now_ms_u64(),
                        samples: Arc::from(samples),
                    }),
                );
            }
            if last_device_check.elapsed() >= DEVICE_CHECK_EVERY {
                last_device_check = Instant::now();
                if backend::default_device_id(source).is_some_and(|current| current != device_id) {
                    info!(
                        "audio.capture: default device changed source={}, re-binding",
                        source_name(source),
                    );
                    stream.stop();
                    publish(generation, CaptureEvent::DeviceRebound { source });
                    continue 'lifetime;
                }
            }
            std::thread::sleep(CAPTURE_POLL);
        }
    }
}

/// Charges one failed capture attempt against the reopen budget and waits
/// before the next open. EVERY failure path funnels through here: without a
/// wait, a device that opens cleanly and then errors on its first read spins
/// this thread at full CPU and floods consumers with DeviceRebound. Returns
/// false once the budget is spent, having published the terminal Failed.
///
/// `lived` is how long the stream that just died actually ran (zero when the
/// open itself failed). Only a stream that ran a real length of time earns a
/// fresh budget - resetting on every successful open instead would let an
/// open-then-immediately-fail cycle repeat forever.
fn backoff_before_reopen(
    source: AudioSource,
    generation: u64,
    cancellation: &AtomicBool,
    attempts: &mut u32,
    lived: Duration,
) -> bool {
    if lived >= STREAM_STABLE_AFTER {
        *attempts = 0;
    }
    *attempts += 1;
    warn!(
        "audio.capture: source={} reopening, attempt={}",
        source_name(source),
        *attempts,
    );
    if *attempts >= MAX_REOPEN_ATTEMPTS {
        publish(generation, CaptureEvent::Failed { source });
        return false;
    }
    sleep_unless_cancelled(cancellation, REOPEN_BACKOFF * *attempts);
    true
}

/// Sleeps in short slices so a stop request does not have to wait out a whole
/// backoff before the capture thread notices it.
fn sleep_unless_cancelled(cancellation: &AtomicBool, total: Duration) {
    const SLICE: Duration = Duration::from_millis(50);
    let mut waited = Duration::ZERO;
    while waited < total {
        if cancellation.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(SLICE);
        waited += SLICE;
    }
}

fn source_name(source: AudioSource) -> &'static str {
    match source {
        AudioSource::Microphone => "microphone",
        AudioSource::Loopback => "loopback",
    }
}

/// The platform device layer, and the whole of what differs between Windows
/// and macOS in this module.
///
/// Three things are asked of a backend, and nothing else:
///
/// - `init_thread` prepares the calling thread (COM on Windows, nothing on
///   macOS).
/// - `DeviceStream::open` binds the default source and reports a stable id for
///   it, so `capture_thread` can notice the user switching devices.
/// - `DeviceStream::drain` returns every whole 16 kHz mono frame available now,
///   plus how many timing discontinuities it saw. An empty result is normal.
#[cfg(windows)]
mod backend {
    use std::collections::VecDeque;

    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    use super::{AudioSource, SAMPLE_RATE};

    pub fn init_thread() -> Result<(), String> {
        wasapi::initialize_mta()
            .ok()
            .map_err(|_| "COM init failed".to_string())
    }

    fn device_direction(source: AudioSource) -> Direction {
        match source {
            AudioSource::Microphone => Direction::Capture,
            AudioSource::Loopback => Direction::Render,
        }
    }

    pub fn default_device_id(source: AudioSource) -> Option<String> {
        DeviceEnumerator::new()
            .ok()?
            .get_default_device(&device_direction(source))
            .ok()?
            .get_id()
            .ok()
    }

    pub struct DeviceStream {
        client: wasapi::AudioClient,
        capture: wasapi::AudioCaptureClient,
        raw: VecDeque<u8>,
        stopped: bool,
    }

    impl DeviceStream {
        pub fn open(source: AudioSource) -> Result<(Self, String), String> {
            let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string())?;
            let device = enumerator
                .get_default_device(&device_direction(source))
                .map_err(|error| error.to_string())?;
            let device_id = device.get_id().map_err(|error| error.to_string())?;
            let mut client = device.get_iaudioclient().map_err(|error| error.to_string())?;
            let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, 1, None);
            let mode = StreamMode::PollingShared {
                autoconvert: true,
                // Preserve Meeting Notes' 400 ms tolerance for segment encoding stalls.
                buffer_duration_hns: 4_000_000,
            };
            // Capture direction on a render device is WASAPI shared-mode loopback.
            client
                .initialize_client(&format, &Direction::Capture, &mode)
                .map_err(|error| error.to_string())?;
            let capture = client
                .get_audiocaptureclient()
                .map_err(|error| error.to_string())?;
            client.start_stream().map_err(|error| error.to_string())?;
            Ok((
                Self {
                    client,
                    capture,
                    raw: VecDeque::new(),
                    stopped: false,
                },
                device_id,
            ))
        }

        pub fn drain(&mut self) -> Result<(Vec<f32>, u32), String> {
            let mut glitches = 0u32;
            // GetBuffer consumes one packet. Drain every queued packet before
            // returning so captured speech is never replaced by alignment zeros.
            loop {
                let packet_frames = match self.capture.get_next_packet_size() {
                    Ok(Some(frames)) => frames,
                    Ok(None) => 0,
                    Err(error) => return Err(format!("packet query failed: {error}")),
                };
                if packet_frames == 0 {
                    break;
                }
                match self.capture.read_from_device_to_deque(&mut self.raw) {
                    Ok(buffer) => {
                        if buffer.flags.data_discontinuity || buffer.flags.timestamp_error {
                            glitches += 1;
                        }
                    }
                    Err(error) => return Err(format!("read failed: {error}")),
                }
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
            Ok((samples, glitches))
        }

        pub fn stop(&mut self) {
            if !self.stopped {
                let _ = self.client.stop_stream();
                self.stopped = true;
            }
        }
    }
}

/// AVAudioEngine for the microphone, a Core Audio process tap for system audio.
///
/// The tap is the interesting half: it is what replaces WASAPI's render
/// loopback, it needs macOS 14.4, and its TCC prompt only fires when IO
/// actually starts. `macos_audio` carries all of that; this is the adapter onto
/// the broker's contract.
///
/// Neither source reports a WASAPI-style discontinuity flag, so a ring overrun
/// stands in: it is the same statement (audio is missing from this stretch) and
/// the same consumer reaction (mark the segment incomplete).
#[cfg(target_os = "macos")]
mod backend {
    use std::time::Duration;

    use crate::macos_audio::{self, MicCapture, SystemAudioCapture};

    use super::AudioSource;

    /// One drain's wait. Matches the poll cadence the shared loop already uses,
    /// so a silent source costs one parked thread rather than a spin.
    const DRAIN_WAIT: Duration = Duration::from_millis(20);

    pub fn init_thread() -> Result<(), String> {
        // No apartment to join: Core Audio and AVFoundation are not COM.
        Ok(())
    }

    pub fn default_device_id(source: AudioSource) -> Option<String> {
        match source {
            AudioSource::Microphone => macos_audio::default_input_uid(),
            // The tap is not a device the user can switch, so this never
            // changes for the life of a capture and the broker's re-bind check
            // correctly never fires for it.
            AudioSource::Loopback => None,
        }
    }

    pub enum DeviceStream {
        Microphone(Box<MicCapture>),
        SystemAudio(Box<SystemAudioCapture>),
    }

    impl DeviceStream {
        pub fn open(source: AudioSource) -> Result<(Self, String), String> {
            match source {
                AudioSource::Microphone => {
                    let capture = MicCapture::open()?;
                    let id = macos_audio::default_input_uid()
                        .unwrap_or_else(|| "default-input".to_string());
                    Ok((Self::Microphone(Box::new(capture)), id))
                }
                AudioSource::Loopback => {
                    let capture = SystemAudioCapture::open()?;
                    let id = capture.uid();
                    Ok((Self::SystemAudio(Box::new(capture)), id))
                }
            }
        }

        pub fn drain(&mut self) -> Result<(Vec<f32>, u32), String> {
            let (samples, overran) = match self {
                Self::Microphone(capture) => capture.drain(DRAIN_WAIT),
                Self::SystemAudio(capture) => capture.drain(DRAIN_WAIT),
            };
            Ok((samples, u32::from(overran)))
        }

        pub fn stop(&mut self) {
            match self {
                Self::Microphone(capture) => capture.stop(),
                Self::SystemAudio(capture) => capture.stop(),
            }
        }
    }
}
