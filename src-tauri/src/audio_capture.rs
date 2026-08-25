//! Shared WASAPI microphone and render-loopback capture.
//!
//! One broker owns both default devices and fans timestamped 16 kHz mono PCM
//! frames out to named consumers. Meeting Notes uses a lossless queue because
//! dropping audio would corrupt its durable recording. Live consumers use a
//! bounded queue and `try_send`; a slow recognizer can observe overflow and
//! enter a degraded state without ever blocking Meeting Notes.

#![cfg(windows)]

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::{error, info, warn};
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

pub(crate) const SAMPLE_RATE: usize = 16_000;
const CAPTURE_POLL: Duration = Duration::from_millis(40);
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
    if wasapi::initialize_mta().is_err() {
        error!("audio.capture: COM init failed source={}", source_name(source));
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
        let (client, capture, device_id) = match open_stream(source) {
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

        let mut raw = VecDeque::new();
        let mut last_device_check = Instant::now();
        loop {
            if cancellation.load(Ordering::Relaxed) {
                let _ = client.stop_stream();
                break 'lifetime;
            }
            // GetBuffer consumes one packet. Drain every queued packet before
            // sleeping so captured speech is never replaced by alignment zeros.
            loop {
                let packet_frames = match capture.get_next_packet_size() {
                    Ok(Some(frames)) => frames,
                    Ok(None) => 0,
                    Err(error) => {
                        warn!(
                            "audio.capture: packet query failed source={}: {error}",
                            source_name(source),
                        );
                        let _ = client.stop_stream();
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
                if packet_frames == 0 {
                    break;
                }
                match capture.read_from_device_to_deque(&mut raw) {
                    Ok(buffer) => {
                        if buffer.flags.data_discontinuity || buffer.flags.timestamp_error {
                            publish(generation, CaptureEvent::Glitch { source });
                        }
                    }
                    Err(error) => {
                        warn!(
                            "audio.capture: read failed source={}: {error}",
                            source_name(source),
                        );
                        let _ = client.stop_stream();
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
                }
            }
            let full = raw.len() / 4;
            if full > 0 {
                let mut samples = Vec::with_capacity(full);
                for _ in 0..full {
                    let bytes = [
                        raw.pop_front().unwrap_or(0),
                        raw.pop_front().unwrap_or(0),
                        raw.pop_front().unwrap_or(0),
                        raw.pop_front().unwrap_or(0),
                    ];
                    samples.push(f32::from_le_bytes(bytes));
                }
                publish(
                    generation,
                    CaptureEvent::Frame(PcmFrame {
                        source,
                        captured_at_ms: origin.elapsed().as_millis() as u64,
                        captured_at_unix_ms: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                        samples: Arc::from(samples),
                    }),
                );
            }
            if last_device_check.elapsed() >= DEVICE_CHECK_EVERY {
                last_device_check = Instant::now();
                if default_device_id(source).is_some_and(|current| current != device_id) {
                    info!(
                        "audio.capture: default device changed source={}, re-binding",
                        source_name(source),
                    );
                    let _ = client.stop_stream();
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

fn device_direction(source: AudioSource) -> Direction {
    match source {
        AudioSource::Microphone => Direction::Capture,
        AudioSource::Loopback => Direction::Render,
    }
}

fn default_device_id(source: AudioSource) -> Option<String> {
    DeviceEnumerator::new()
        .ok()?
        .get_default_device(&device_direction(source))
        .ok()?
        .get_id()
        .ok()
}

fn open_stream(
    source: AudioSource,
) -> Result<(wasapi::AudioClient, wasapi::AudioCaptureClient, String), String> {
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
    Ok((client, capture, device_id))
}
