//! macOS audio capture primitives, shared by dictation and Meeting Notes.
//!
//! Both features want the same thing from the OS: 16 kHz mono `f32`, pulled by
//! a worker thread that owns its own timing. On Windows they get that for free -
//! WASAPI shared mode with `autoconvert: true` makes the audio engine do the
//! resample and downmix, which is why this tree has no resampler dependency at
//! all. Core Audio has no equivalent: a device or a process tap delivers its
//! native rate (48 kHz, usually) in its native layout (stereo, often
//! non-interleaved), and converting it is the caller's problem.
//!
//! So `Resampler` below is the piece with no Windows counterpart, and it is
//! deliberately `AVAudioConverter` rather than hand-rolled DSP: a subtly wrong
//! resampler does not crash, it just quietly degrades every transcript.
//!
//! `MicCapture` adapts AVFoundation's push model (a tap block called on a
//! real-time thread) to the pull model both consumers already use, by parking
//! samples in a ring the consumer drains. The tap block does the least possible
//! work: convert, lock, extend, notify.

#![cfg(target_os = "macos")]

use std::collections::VecDeque;
use std::ptr::NonNull;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_avf_audio::{
    AVAudioCommonFormat, AVAudioConverter, AVAudioConverterInputStatus,
    AVAudioConverterOutputStatus, AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer,
};

/// The one format everything downstream speaks. Matches `asr::SAMPLE_RATE` and
/// `audio_capture::SAMPLE_RATE`, which are the same number for the same reason.
pub const SAMPLE_RATE: f64 = 16_000.0;

/// Frames requested per tap callback. ~23ms at 48 kHz: small enough that a
/// release feels immediate, large enough that a descheduled audio thread does
/// not thrash.
const TAP_BUFFER_FRAMES: u32 = 1024;

/// Ceiling on the ring, in frames at the OUTPUT rate. 30 seconds. A consumer
/// that stops draining (a wedged worker) must not grow this without bound; it
/// drops the oldest audio instead, which is the same direction WASAPI's ring
/// overrun takes.
const MAX_RING_FRAMES: usize = (SAMPLE_RATE as usize) * 30;

/// Converts one source format to 16 kHz mono `f32`.
///
/// `convertToBuffer:fromBuffer:error:` cannot be used here: AVFoundation
/// documents it as valid only when no codec or sample-rate change is involved,
/// which is exactly the case this type exists for. The block form is the one
/// that resamples, and its contract is "call me until you have no more input",
/// hence the one-shot `Cell` below.
pub struct Resampler {
    converter: Retained<AVAudioConverter>,
    output_format: Retained<AVAudioFormat>,
    ratio: f64,
}

impl Resampler {
    /// `None` when AVFoundation refuses the conversion, which the callers treat
    /// as "this device is unusable" rather than silently passing raw audio on
    /// at the wrong rate.
    pub fn new(input_format: &AVAudioFormat) -> Option<Self> {
        let output_format = unsafe {
            AVAudioFormat::initWithCommonFormat_sampleRate_channels_interleaved(
                AVAudioFormat::alloc(),
                AVAudioCommonFormat::PCMFormatFloat32,
                SAMPLE_RATE,
                1,
                false,
            )
        }?;
        let converter = unsafe {
            AVAudioConverter::initFromFormat_toFormat(
                AVAudioConverter::alloc(),
                input_format,
                &output_format,
            )
        }?;
        let input_rate = unsafe { input_format.sampleRate() };
        if input_rate <= 0.0 {
            return None;
        }
        Some(Self {
            converter,
            output_format,
            ratio: SAMPLE_RATE / input_rate,
        })
    }

    /// Converts one input buffer. Returns the mono 16 kHz samples, or an empty
    /// vec when the converter had nothing to emit for this input (normal while
    /// it primes).
    pub fn convert(&self, input: &AVAudioPCMBuffer) -> Vec<f32> {
        let input_frames = unsafe { input.frameLength() };
        if input_frames == 0 {
            return Vec::new();
        }
        // Round up and add a frame of slack: a resampler can emit one more
        // frame than the naive ratio suggests, and a too-small output buffer
        // silently truncates.
        let capacity = ((input_frames as f64 * self.ratio).ceil() as u32) + 1;
        let Some(output) = (unsafe {
            AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &self.output_format,
                capacity,
            )
        }) else {
            return Vec::new();
        };

        // The converter pulls input until told there is none left. This buffer
        // is handed over exactly once; every later pull reports NoDataNow, or
        // the converter would spin forever asking for more.
        let supplied = std::cell::Cell::new(false);
        let input_ptr: *mut AVAudioPCMBuffer = (input as *const AVAudioPCMBuffer).cast_mut();
        let block = RcBlock::new(
            move |_packets: u32, status: NonNull<AVAudioConverterInputStatus>| {
                if supplied.replace(true) {
                    unsafe { *status.as_ptr() = AVAudioConverterInputStatus::NoDataNow };
                    return std::ptr::null_mut();
                }
                unsafe { *status.as_ptr() = AVAudioConverterInputStatus::HaveData };
                input_ptr.cast()
            },
        );

        let mut error = None;
        let status = unsafe {
            self.converter.convertToBuffer_error_withInputFromBlock(
                &output,
                Some(&mut error),
                RcBlock::as_ptr(&block),
            )
        };
        if status == AVAudioConverterOutputStatus::Error {
            return Vec::new();
        }

        let frames = unsafe { output.frameLength() } as usize;
        if frames == 0 {
            return Vec::new();
        }
        let channels = unsafe { output.floatChannelData() };
        if channels.is_null() {
            return Vec::new();
        }
        // Mono output, so channel 0 is the whole signal.
        let first = unsafe { *channels };
        unsafe { std::slice::from_raw_parts(first.as_ptr(), frames) }.to_vec()
    }
}

/// The samples a capture has produced but its consumer has not drained yet,
/// plus the condvar the consumer parks on so an idle device costs no CPU.
#[derive(Default)]
struct RingState {
    samples: VecDeque<f32>,
    /// Set when the ring dropped audio because nothing was draining it. The
    /// consumer reads it to mark its output non-contiguous.
    overran: bool,
}

#[derive(Default)]
struct Ring {
    state: Mutex<RingState>,
    ready: Condvar,
}

impl Ring {
    fn push(&self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.samples.extend(samples.iter().copied());
        if state.samples.len() > MAX_RING_FRAMES {
            let excess = state.samples.len() - MAX_RING_FRAMES;
            state.samples.drain(..excess);
            state.overran = true;
        }
        drop(state);
        self.ready.notify_all();
    }

    /// Waits up to `timeout` for anything to arrive, then takes everything
    /// available. An empty result is normal and simply means the caller should
    /// loop again and re-check its own signals.
    fn drain(&self, timeout: Duration) -> (Vec<f32>, bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.samples.is_empty() {
            let (next, _) = self
                .ready
                .wait_timeout(state, timeout)
                .unwrap_or_else(|e| e.into_inner());
            state = next;
        }
        let overran = std::mem::take(&mut state.overran);
        (state.samples.drain(..).collect(), overran)
    }

    fn clear(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.samples.clear();
        state.overran = false;
    }
}

/// The default input device, delivered as 16 kHz mono `f32` through a ring the
/// owner drains. Starting one is what lights the macOS microphone indicator, so
/// callers must open it only when the user has actually asked to be heard.
pub struct MicCapture {
    engine: Retained<AVAudioEngine>,
    ring: Arc<Ring>,
    stopped: bool,
}

impl MicCapture {
    pub fn open() -> Result<Self, String> {
        let engine = unsafe { AVAudioEngine::new() };
        let input = unsafe { engine.inputNode() };
        // The device's own format. AVFoundation rejects a tap format that
        // differs from the node's output format, which is precisely why the
        // conversion happens inside the tap block rather than being asked of
        // the engine.
        let input_format = unsafe { input.outputFormatForBus(0) };
        if unsafe { input_format.sampleRate() } <= 0.0 {
            return Err("no usable input device".to_string());
        }
        let resampler = Resampler::new(&input_format)
            .ok_or_else(|| "could not build a 16 kHz converter for the input device".to_string())?;

        let ring = Arc::new(Ring::default());
        let tap_ring = Arc::clone(&ring);
        let block = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<objc2_avf_audio::AVAudioTime>| {
                let buffer = unsafe { buffer.as_ref() };
                let samples = resampler.convert(buffer);
                tap_ring.push(&samples);
            },
        );
        unsafe {
            input.installTapOnBus_bufferSize_format_block(
                0,
                TAP_BUFFER_FRAMES,
                Some(&input_format),
                RcBlock::as_ptr(&block),
            );
        }

        unsafe { engine.prepare() };
        if let Err(error) = unsafe { engine.startAndReturnError() } {
            unsafe { input.removeTapOnBus(0) };
            return Err(format!("microphone start failed: {error}"));
        }

        Ok(Self {
            engine,
            ring,
            stopped: false,
        })
    }

    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        unsafe {
            self.engine.inputNode().removeTapOnBus(0);
            self.engine.stop();
        }
        self.stopped = true;
    }

    pub fn discard_pending(&mut self) {
        self.ring.clear();
    }

    /// Waits up to `timeout` for audio, then returns every whole frame
    /// available. The bool reports whether the ring overran since the last
    /// drain.
    pub fn drain(&mut self, timeout: Duration) -> (Vec<f32>, bool) {
        self.ring.drain(timeout)
    }
}

impl Drop for MicCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The UID string of the current default input device, for the broker's
/// device-change detection. `None` when Core Audio will not answer, which the
/// caller treats as "no change" rather than as a device loss.
pub fn default_input_uid() -> Option<String> {
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceUID, kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress,
    };
    use objc2_core_foundation::{CFRetained, CFString};

    let mut device: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let mut address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            std::ptr::NonNull::from(&mut address),
            0,
            std::ptr::null(),
            std::ptr::NonNull::from(&mut size),
            std::ptr::NonNull::from(&mut device).cast(),
        )
    };
    if status != 0 || device == 0 {
        return None;
    }

    let mut uid: *const CFString = std::ptr::null();
    let mut size = std::mem::size_of::<*const CFString>() as u32;
    address.mSelector = kAudioDevicePropertyDeviceUID;
    let status = unsafe {
        AudioObjectGetPropertyData(
            device,
            std::ptr::NonNull::from(&mut address),
            0,
            std::ptr::null(),
            std::ptr::NonNull::from(&mut size),
            std::ptr::NonNull::from(&mut uid).cast(),
        )
    };
    if status != 0 || uid.is_null() {
        return None;
    }
    // The Get rule does not transfer ownership, but a CFString property IS
    // returned +1 by Core Audio ("Copy" semantics despite the call's name), so
    // this takes it and releases on drop.
    let uid = unsafe { CFRetained::from_raw(std::ptr::NonNull::new(uid as *mut CFString)?) };
    Some(uid.to_string())
}

/// System audio, via a Core Audio process tap wrapped in a private aggregate
/// device. The macOS analogue of WASAPI render loopback.
///
/// The tap is GLOBAL and excludes nothing, including Aura itself. That matches
/// Windows exactly - render loopback there also captures Buddy's own speech -
/// and matching it is the point: excluding ourselves would be a behaviour
/// change dressed up as a fix.
///
/// Two things about this path have no Windows counterpart and are worth knowing
/// before debugging it:
///
/// - **The TCC prompt fires on `AudioDeviceStart`, not before.** There is no
///   preflight or request API for audio capture, so the whole pipeline has to
///   be built before macOS will even ask the user. A denial therefore surfaces
///   here as a start failure, which the broker turns into `Failed` rather than
///   letting it stall silently.
/// - **Nothing is converted for us.** The tap delivers its native rate and
///   layout, so `Resampler` is doing real work on every callback.
pub struct SystemAudioCapture {
    tap_id: u32,
    aggregate_id: u32,
    io_proc: objc2_core_audio::AudioDeviceIOProcID,
    ring: Arc<Ring>,
    stopped: bool,
}

impl SystemAudioCapture {
    pub fn open() -> Result<Self, String> {
        use objc2_core_audio::{
            kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey,
            kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
            kAudioAggregateDeviceUIDKey, kAudioObjectPropertyElementMain,
            kAudioObjectPropertyScopeGlobal, kAudioSubTapUIDKey, kAudioTapPropertyFormat,
            AudioDeviceCreateIOProcIDWithBlock, AudioDeviceStart, AudioHardwareCreateAggregateDevice,
            AudioHardwareCreateProcessTap, AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData,
            AudioObjectID, AudioObjectPropertyAddress, CATapDescription,
        };
        use objc2_core_audio_types::AudioStreamBasicDescription;
        use objc2::runtime::{AnyObject, ProtocolObject};
        use objc2_foundation::{NSArray, NSDictionary, NSMutableDictionary, NSNumber, NSString};

        // An EMPTY exclusion list is what makes this a whole-system tap.
        let excluded: objc2::rc::Retained<NSArray<NSNumber>> = NSArray::new();
        let description = unsafe {
            CATapDescription::initStereoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &excluded,
            )
        };
        unsafe {
            description.setName(&NSString::from_str("Aura Meeting Notes"));
            // Private: no other process sees this tap in the device list.
            description.setPrivate(true);
            // Unmuted: capturing must never silence what the user is listening
            // to. CATapUnmuted is 0.
            description.setMuteBehavior(objc2_core_audio::CATapMuteBehavior(0));
        }
        let tap_uuid = unsafe { description.UUID().UUIDString() }.to_string();

        let mut tap_id: AudioObjectID = 0;
        let status = unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut tap_id) };
        if status != 0 || tap_id == 0 {
            return Err(format!("could not create the system audio tap: OSStatus {status}"));
        }

        // Read the tap's own format before wrapping it, so the converter is
        // built for what will actually arrive.
        let mut asbd: AudioStreamBasicDescription = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
        let mut address = AudioObjectPropertyAddress {
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let status = unsafe {
            AudioObjectGetPropertyData(
                tap_id,
                std::ptr::NonNull::from(&mut address),
                0,
                std::ptr::null(),
                std::ptr::NonNull::from(&mut size),
                std::ptr::NonNull::from(&mut asbd).cast(),
            )
        };
        if status != 0 {
            unsafe { AudioHardwareDestroyProcessTap(tap_id) };
            return Err(format!("could not read the tap format: OSStatus {status}"));
        }

        let Some(input_format) = (unsafe {
            AVAudioFormat::initWithStreamDescription(
                AVAudioFormat::alloc(),
                std::ptr::NonNull::from(&asbd),
            )
        }) else {
            unsafe { AudioHardwareDestroyProcessTap(tap_id) };
            return Err("the tap reported a format AVFoundation does not accept".to_string());
        };
        let Some(resampler) = Resampler::new(&input_format) else {
            unsafe { AudioHardwareDestroyProcessTap(tap_id) };
            return Err("could not build a 16 kHz converter for the system audio tap".to_string());
        };

        // NSDictionary is toll-free bridged to CFDictionary, which is what
        // AudioHardwareCreateAggregateDevice wants. Building it in Foundation
        // is far less error-prone than hand-rolling CF collections, and the
        // keys are &CStr in the bindings because Apple declares them as C
        // string literals rather than CFStrings.
        let aggregate_uid = format!("com.aura.desktop.meeting-tap.{tap_uuid}");
        let sub_tap: Retained<NSDictionary<NSString, AnyObject>> = {
            let dictionary = NSMutableDictionary::<NSString, AnyObject>::new();
            let value = NSString::from_str(&tap_uuid);
            unsafe { dictionary.setObject_forKey(&value, ProtocolObject::from_ref(&*key_string(kAudioSubTapUIDKey))) };
            dictionary.into_super()
        };
        let description = {
            let dictionary = NSMutableDictionary::<NSString, AnyObject>::new();
            let name = NSString::from_str("Aura Meeting Notes");
            let uid = NSString::from_str(&aggregate_uid);
            let yes = NSNumber::new_bool(true);
            let taps = NSArray::from_retained_slice(&[sub_tap]);
            unsafe { dictionary.setObject_forKey(&name, ProtocolObject::from_ref(&*key_string(kAudioAggregateDeviceNameKey))) };
            unsafe { dictionary.setObject_forKey(&uid, ProtocolObject::from_ref(&*key_string(kAudioAggregateDeviceUIDKey))) };
            // Private: the aggregate never appears in the user's sound settings.
            unsafe { dictionary.setObject_forKey(&yes, ProtocolObject::from_ref(&*key_string(kAudioAggregateDeviceIsPrivateKey))) };
            unsafe { dictionary.setObject_forKey(&yes, ProtocolObject::from_ref(&*key_string(kAudioAggregateDeviceTapAutoStartKey))) };
            unsafe { dictionary.setObject_forKey(&taps, ProtocolObject::from_ref(&*key_string(kAudioAggregateDeviceTapListKey))) };
            dictionary
        };

        let mut aggregate_id: AudioObjectID = 0;
        let status = unsafe {
            AudioHardwareCreateAggregateDevice(
                &*(objc2::rc::Retained::as_ptr(&description)
                    as *const objc2_core_foundation::CFDictionary),
                std::ptr::NonNull::from(&mut aggregate_id),
            )
        };
        if status != 0 || aggregate_id == 0 {
            unsafe { AudioHardwareDestroyProcessTap(tap_id) };
            return Err(format!(
                "could not create the aggregate device for the tap: OSStatus {status}"
            ));
        }

        let ring = Arc::new(Ring::default());
        let io_ring = Arc::clone(&ring);
        let io_format = input_format.clone();
        let block = RcBlock::new(
            move |_now: NonNull<objc2_core_audio_types::AudioTimeStamp>,
                  input: NonNull<objc2_core_audio_types::AudioBufferList>,
                  _input_time: NonNull<objc2_core_audio_types::AudioTimeStamp>,
                  _output: NonNull<objc2_core_audio_types::AudioBufferList>,
                  _output_time: NonNull<objc2_core_audio_types::AudioTimeStamp>| {
                // NoCopy: the buffer list belongs to Core Audio for the length
                // of this callback only, and the deallocator is None because
                // nothing here owns it.
                let buffer = unsafe {
                    AVAudioPCMBuffer::initWithPCMFormat_bufferListNoCopy_deallocator(
                        AVAudioPCMBuffer::alloc(),
                        &io_format,
                        input,
                        None,
                    )
                };
                if let Some(buffer) = buffer {
                    let samples = resampler.convert(&buffer);
                    io_ring.push(&samples);
                }
            },
        );

        let mut io_proc: objc2_core_audio::AudioDeviceIOProcID = None;
        let status = unsafe {
            AudioDeviceCreateIOProcIDWithBlock(
                std::ptr::NonNull::from(&mut io_proc),
                aggregate_id,
                None,
                RcBlock::as_ptr(&block),
            )
        };
        if status != 0 {
            unsafe {
                objc2_core_audio::AudioHardwareDestroyAggregateDevice(aggregate_id);
                AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(format!("could not install the tap IO proc: OSStatus {status}"));
        }

        // THIS is the call that prompts for System Audio Recording, and the
        // one that fails when the user has said no.
        let status = unsafe { AudioDeviceStart(aggregate_id, io_proc) };
        if status != 0 {
            unsafe {
                objc2_core_audio::AudioDeviceDestroyIOProcID(aggregate_id, io_proc);
                objc2_core_audio::AudioHardwareDestroyAggregateDevice(aggregate_id);
                AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(format!(
                "system audio capture was refused: OSStatus {status}. Aura needs System Audio \
                 Recording access in System Settings > Privacy & Security."
            ));
        }

        Ok(Self {
            tap_id,
            aggregate_id,
            io_proc,
            ring,
            stopped: false,
        })
    }

    /// A stable identifier for what is being captured. The tap is not a device
    /// the user can change, so this never varies for the life of the capture -
    /// which is exactly what the broker's device-change check wants to see.
    pub fn uid(&self) -> String {
        format!("aura-system-audio-tap-{}", self.tap_id)
    }

    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        unsafe {
            objc2_core_audio::AudioDeviceStop(self.aggregate_id, self.io_proc);
            objc2_core_audio::AudioDeviceDestroyIOProcID(self.aggregate_id, self.io_proc);
            objc2_core_audio::AudioHardwareDestroyAggregateDevice(self.aggregate_id);
            objc2_core_audio::AudioHardwareDestroyProcessTap(self.tap_id);
        }
        self.stopped = true;
    }

    pub fn drain(&mut self, timeout: Duration) -> (Vec<f32>, bool) {
        self.ring.drain(timeout)
    }
}

impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The aggregate-device dictionary keys are `&CStr` constants in the bindings
/// because they are C string literals in Apple's headers, not CFStrings.
fn key_string(key: &std::ffi::CStr) -> objc2::rc::Retained<objc2_foundation::NSString> {
    objc2_foundation::NSString::from_str(&key.to_string_lossy())
}
