//! On-device streaming speech recognition: sherpa-onnx's streaming Zipformer
//! transducer (20M parameters, INT8) driven through its C API.
//!
//! Why the C API and not the `sherpa-rs` crate: `sherpa-rs` only wraps the
//! OFFLINE transducer, which has no streaming partials, and it builds
//! sherpa-onnx from source through cmake. The plan's own escape hatch applies
//! (contextual biasing is the whole personalization story and cannot be traded
//! away for binding convenience), so this module loads the prebuilt CPU-only
//! shared library at runtime and declares the handful of structs it needs.
//!
//! The library and the model are fetched at BUILD time by
//! `scripts/predownload-dictation-model.mjs` and bundled as Tauri resources,
//! so the runtime is 100% offline: no first-run download, no fallback path to
//! any network service. Only `onnxruntime.dll` and `sherpa-onnx-c-api.dll` are
//! shipped; the DirectML and CUDA provider DLLs are deliberately absent,
//! because ORT probes the adapter at session creation and can reserve VRAM
//! without a line of our code asking it to.
//!
//! The FFI layout below is transcribed from sherpa-onnx's own
//! `sherpa-onnx/c-api/c-api.h` at the version pinned in the predownload
//! script. It is version sensitive by nature: bumping the pinned version means
//! re-checking these structs against that release's header.
//!
//! Nothing here logs decoded text at any level. Counts, durations and byte
//! sizes only, the same discipline meeting/audio.rs follows.

#![cfg(windows)]

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};

use log::{info, warn};

/// Every model provided by sherpa-onnx expects 16 kHz.
pub const SAMPLE_RATE: i32 = 16_000;
/// Feature dimension of the shipped Zipformer.
const FEATURE_DIM: i32 = 80;
/// Two threads: enough to keep a 20M model ahead of real time on a laptop core
/// without the library's default thread pool eating the machine while the user
/// is mid-sentence in another app.
const NUM_THREADS: i32 = 2;
/// Contextual biasing (hotwords) is only honored by modified_beam_search, and
/// the decoding method is fixed when the recognizer is built rather than per
/// stream, so it is always on. `max_active_paths = 4` is sherpa-onnx's own
/// documented default and is well inside budget for a 20M model.
const MAX_ACTIVE_PATHS: i32 = 4;
/// Tail padding fed after the user releases the chord so the transducer emits
/// the final word instead of stranding it in the encoder's right context.
const FLUSH_PADDING_FRAMES: usize = (SAMPLE_RATE as usize) / 2;

#[repr(C)]
struct OnlineTransducerModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    joiner: *const c_char,
}

#[repr(C)]
struct OnlineParaformerModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
}

#[repr(C)]
struct OnlineZipformer2CtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct OnlineModelConfig {
    transducer: OnlineTransducerModelConfig,
    paraformer: OnlineParaformerModelConfig,
    zipformer2_ctc: OnlineZipformer2CtcModelConfig,
    tokens: *const c_char,
    num_threads: i32,
    provider: *const c_char,
    debug: i32,
    model_type: *const c_char,
    modeling_unit: *const c_char,
    bpe_vocab: *const c_char,
    tokens_buf: *const c_char,
    tokens_buf_size: i32,
}

#[repr(C)]
struct FeatureConfig {
    sample_rate: i32,
    feature_dim: i32,
}

#[repr(C)]
struct OnlineCtcFstDecoderConfig {
    graph: *const c_char,
    max_active: i32,
}

#[repr(C)]
struct OnlineRecognizerConfig {
    feat_config: FeatureConfig,
    model_config: OnlineModelConfig,
    decoding_method: *const c_char,
    max_active_paths: i32,
    enable_endpoint: i32,
    rule1_min_trailing_silence: f32,
    rule2_min_trailing_silence: f32,
    rule3_min_utterance_length: f32,
    hotwords_file: *const c_char,
    hotwords_score: f32,
    ctc_fst_decoder_config: OnlineCtcFstDecoderConfig,
    rule_fsts: *const c_char,
    rule_fars: *const c_char,
    blank_penalty: f32,
    hotwords_buf: *const c_char,
    hotwords_buf_size: i32,
}

#[repr(C)]
struct OnlineRecognizerResult {
    text: *const c_char,
    tokens: *const c_char,
    tokens_arr: *const *const c_char,
    timestamps: *mut f32,
    count: i32,
    json: *const c_char,
}

type CreateRecognizerFn = unsafe extern "C" fn(*const OnlineRecognizerConfig) -> *const c_void;
type DestroyRecognizerFn = unsafe extern "C" fn(*const c_void);
type CreateStreamFn = unsafe extern "C" fn(*const c_void) -> *const c_void;
type CreateStreamWithHotwordsFn =
    unsafe extern "C" fn(*const c_void, *const c_char) -> *const c_void;
type DestroyStreamFn = unsafe extern "C" fn(*const c_void);
type AcceptWaveformFn = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type IsReadyFn = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
type DecodeFn = unsafe extern "C" fn(*const c_void, *const c_void);
type GetResultFn = unsafe extern "C" fn(*const c_void, *const c_void) -> *const OnlineRecognizerResult;
type DestroyResultFn = unsafe extern "C" fn(*const OnlineRecognizerResult);
type InputFinishedFn = unsafe extern "C" fn(*const c_void);

struct Api {
    create_recognizer: CreateRecognizerFn,
    destroy_recognizer: DestroyRecognizerFn,
    create_stream: CreateStreamFn,
    create_stream_with_hotwords: CreateStreamWithHotwordsFn,
    destroy_stream: DestroyStreamFn,
    accept_waveform: AcceptWaveformFn,
    is_ready: IsReadyFn,
    decode: DecodeFn,
    get_result: GetResultFn,
    destroy_result: DestroyResultFn,
    input_finished: InputFinishedFn,
}

/// Which model files the recognizer needs, resolved from the bundled resource
/// directory. `bpe_vocab` is optional: without it sherpa-onnx cannot tokenize
/// hotwords for a BPE English model, so tier 0 biasing degrades to off while
/// plain dictation keeps working.
struct ModelPaths {
    encoder: PathBuf,
    decoder: PathBuf,
    joiner: PathBuf,
    tokens: PathBuf,
    bpe_vocab: Option<PathBuf>,
}

fn pick(dir: &Path, candidates: &[&str], preferred_marker: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !candidates.iter().any(|prefix| name.starts_with(prefix)) {
            continue;
        }
        if !name.ends_with(".onnx") {
            continue;
        }
        let is_preferred = name.contains(preferred_marker);
        if is_preferred {
            return Some(path);
        }
        if best.is_none() {
            best = Some(path);
        }
    }
    best
}

/// The `model` block of `installed.json`, written by the predownload script
/// when it installed these exact files.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledModel {
    encoder: String,
    decoder: String,
    joiner: String,
    tokens: String,
    #[serde(default)]
    bpe_vocab: Option<String>,
}

#[derive(serde::Deserialize)]
struct InstalledManifest {
    model: InstalledModel,
}

impl ModelPaths {
    /// Which precision of encoder and joiner was installed is decided ONCE, at
    /// build time, and recorded in `installed.json` by name. Reading those exact
    /// names here means the runtime never has to guess between two files that
    /// both look like an encoder: a directory scan would resolve whichever the
    /// filesystem happened to return first, so a bundle that somehow carried
    /// both an old and a new model could load a mismatched encoder/joiner pair
    /// and either fail to initialize or quietly recognize badly.
    ///
    /// The prefix scan below is kept only as a fallback for a resource
    /// directory assembled without the manifest, and it logs when it is used.
    fn resolve(dir: &Path) -> Result<Self, String> {
        match Self::from_manifest(dir) {
            Ok(Some(paths)) => return Ok(paths),
            Ok(None) => warn!("dictation.stt: no installed.json, falling back to a name scan"),
            Err(e) => warn!("dictation.stt: installed.json unusable ({e}), falling back to a name scan"),
        }
        Self::from_scan(dir)
    }

    /// `Ok(None)` when there is no manifest at all; `Err` when there is one and
    /// it cannot be trusted (unparseable, or naming a file that is not there).
    fn from_manifest(dir: &Path) -> Result<Option<Self>, String> {
        let manifest_path = dir.join("installed.json");
        if !manifest_path.is_file() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("could not read installed.json: {e}"))?;
        let manifest: InstalledManifest =
            serde_json::from_str(&raw).map_err(|e| format!("could not parse installed.json: {e}"))?;
        let named = |name: &str| -> Result<PathBuf, String> {
            let path = dir.join(name);
            if path.is_file() {
                Ok(path)
            } else {
                Err(format!("{name} is named by installed.json but not installed"))
            }
        };
        Ok(Some(Self {
            encoder: named(&manifest.model.encoder)?,
            decoder: named(&manifest.model.decoder)?,
            joiner: named(&manifest.model.joiner)?,
            tokens: named(&manifest.model.tokens)?,
            bpe_vocab: manifest
                .model
                .bpe_vocab
                .as_deref()
                .map(|name| dir.join(name))
                .filter(|path| path.is_file()),
        }))
    }

    /// The predownload script normalizes nothing beyond extracting the release
    /// archive, so the exact epoch/avg numbers in the file names are matched by
    /// prefix rather than hardcoded. INT8 variants win where both exist.
    fn from_scan(dir: &Path) -> Result<Self, String> {
        let encoder = pick(dir, &["encoder"], ".int8.")
            .ok_or_else(|| format!("no encoder model in {}", dir.display()))?;
        // The decoder is tiny and its INT8 build is not always shipped; either
        // is fine, so no preference is expressed.
        let decoder = pick(dir, &["decoder"], "")
            .ok_or_else(|| format!("no decoder model in {}", dir.display()))?;
        let joiner = pick(dir, &["joiner"], ".int8.")
            .ok_or_else(|| format!("no joiner model in {}", dir.display()))?;
        let tokens = dir.join("tokens.txt");
        if !tokens.is_file() {
            return Err(format!("no tokens.txt in {}", dir.display()));
        }
        let bpe_vocab = Some(dir.join("bpe.vocab")).filter(|path| path.is_file());
        Ok(Self {
            encoder,
            decoder,
            joiner,
            tokens,
            bpe_vocab,
        })
    }
}

/// Cheap presence probe for the bundled runtime and model, used at startup so
/// the status can say whether dictation is installed WITHOUT paying for a load.
/// The model itself is only loaded the first time the user reaches for the
/// chord, so a user who never dictates never carries its working set.
pub fn resources_present(dir: &Path) -> Result<(), String> {
    if !dir.join("sherpa-onnx-c-api.dll").is_file() {
        return Err(format!(
            "the dictation runtime is not installed in {} (run npm run predownload:dictation)",
            dir.display()
        ));
    }
    ModelPaths::resolve(dir).map(|_| ())
}

/// A warm recognizer. Loaded on its own one-shot thread, handed to the
/// dictation worker exactly once, and parked there: with no stream open and no
/// audio client running, it costs memory and no CPU.
pub struct Recognizer {
    api: Api,
    handle: *const c_void,
    /// Whether contextual biasing can be honored at all in this install.
    biasing_available: bool,
}

/// Safe because of how this value is used, not because the type is inherently
/// thread-safe: `handle` is an opaque sherpa-onnx object, constructed on the
/// loader thread, moved exactly once across a channel, and touched only from
/// the dictation worker thread afterwards. `Sync` is deliberately NOT
/// implemented, so it can never be shared between threads.
unsafe impl Send for Recognizer {}

impl Recognizer {
    /// Loads the shared library and builds the recognizer. `resource_dir` is
    /// the bundled `resources/dictation` directory holding both the DLLs and
    /// the model files.
    pub fn load(resource_dir: &Path) -> Result<Self, String> {
        let api = load_api(resource_dir)?;
        let models = ModelPaths::resolve(resource_dir)?;

        let encoder = cstring(&models.encoder.to_string_lossy())?;
        let decoder = cstring(&models.decoder.to_string_lossy())?;
        let joiner = cstring(&models.joiner.to_string_lossy())?;
        let tokens = cstring(&models.tokens.to_string_lossy())?;
        // CPU only, always. Shipping no GPU provider DLL is the primary
        // guarantee; naming the provider explicitly is the second one.
        let provider = cstring("cpu")?;
        let decoding_method = cstring("modified_beam_search")?;
        let empty = cstring("")?;
        let biasing_available = models.bpe_vocab.is_some();
        let modeling_unit = cstring(if biasing_available { "bpe" } else { "" })?;
        let bpe_vocab = cstring(
            &models
                .bpe_vocab
                .as_ref()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
        )?;
        if !biasing_available {
            warn!(
                "dictation.stt: bpe.vocab is missing from the bundled model, contextual biasing is off"
            );
        }

        let config = OnlineRecognizerConfig {
            feat_config: FeatureConfig {
                sample_rate: SAMPLE_RATE,
                feature_dim: FEATURE_DIM,
            },
            model_config: OnlineModelConfig {
                transducer: OnlineTransducerModelConfig {
                    encoder: encoder.as_ptr(),
                    decoder: decoder.as_ptr(),
                    joiner: joiner.as_ptr(),
                },
                paraformer: OnlineParaformerModelConfig {
                    encoder: std::ptr::null(),
                    decoder: std::ptr::null(),
                },
                zipformer2_ctc: OnlineZipformer2CtcModelConfig {
                    model: std::ptr::null(),
                },
                tokens: tokens.as_ptr(),
                // The C API exposes no EnableCpuMemArena switch, so the thread
                // count is the one working-set knob available here. The rest of
                // the budget comes from shipping the INT8 graph and the CPU-only
                // provider set.
                num_threads: NUM_THREADS,
                provider: provider.as_ptr(),
                debug: 0,
                model_type: empty.as_ptr(),
                modeling_unit: modeling_unit.as_ptr(),
                bpe_vocab: bpe_vocab.as_ptr(),
                tokens_buf: std::ptr::null(),
                tokens_buf_size: 0,
            },
            decoding_method: decoding_method.as_ptr(),
            max_active_paths: MAX_ACTIVE_PATHS,
            // Endpointing is deliberately off: the chord IS the endpoint. An
            // automatic endpoint mid-hold would split one utterance into two
            // and insert half a sentence.
            enable_endpoint: 0,
            rule1_min_trailing_silence: 0.0,
            rule2_min_trailing_silence: 0.0,
            rule3_min_utterance_length: 0.0,
            hotwords_file: empty.as_ptr(),
            hotwords_score: super::vocab::HOTWORD_SCORE,
            ctc_fst_decoder_config: OnlineCtcFstDecoderConfig {
                graph: std::ptr::null(),
                max_active: 3000,
            },
            rule_fsts: empty.as_ptr(),
            rule_fars: empty.as_ptr(),
            blank_penalty: 0.0,
            hotwords_buf: std::ptr::null(),
            hotwords_buf_size: 0,
        };

        let handle = unsafe { (api.create_recognizer)(&config) };
        if handle.is_null() {
            return Err("sherpa-onnx refused to build the recognizer".to_string());
        }
        info!("dictation.stt: recognizer warm (threads={NUM_THREADS}, provider=cpu)");
        Ok(Self {
            api,
            handle,
            biasing_available,
        })
    }

    pub fn biasing_available(&self) -> bool {
        self.biasing_available
    }

    /// Opens one utterance's stream. `hotwords` is one phrase per line and may
    /// be empty, in which case a plain stream is created.
    pub fn start_stream(&self, hotwords: &str) -> Result<Stream<'_>, String> {
        let handle = if hotwords.trim().is_empty() || !self.biasing_available {
            unsafe { (self.api.create_stream)(self.handle) }
        } else {
            let encoded = cstring(hotwords)?;
            unsafe { (self.api.create_stream_with_hotwords)(self.handle, encoded.as_ptr()) }
        };
        if handle.is_null() {
            return Err("sherpa-onnx refused to open a stream".to_string());
        }
        Ok(Stream {
            recognizer: self,
            handle,
        })
    }
}

impl Drop for Recognizer {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { (self.api.destroy_recognizer)(self.handle) };
        }
    }
}

/// One utterance. Dropped as soon as the chord's text has been produced, which
/// is what keeps the idle working set flat across many dictations.
pub struct Stream<'a> {
    recognizer: &'a Recognizer,
    handle: *const c_void,
}

impl Stream<'_> {
    /// Feeds mono 16 kHz f32 samples and runs whatever decoding they enable.
    pub fn accept(&self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let api = &self.recognizer.api;
        unsafe {
            (api.accept_waveform)(
                self.handle,
                SAMPLE_RATE,
                samples.as_ptr(),
                samples.len() as i32,
            );
        }
        self.decode_ready();
    }

    fn decode_ready(&self) {
        let api = &self.recognizer.api;
        unsafe {
            while (api.is_ready)(self.recognizer.handle, self.handle) != 0 {
                (api.decode)(self.recognizer.handle, self.handle);
            }
        }
    }

    /// The text decoded so far. Safe to call between chunks for partials.
    pub fn text(&self) -> String {
        let api = &self.recognizer.api;
        unsafe {
            let result = (api.get_result)(self.recognizer.handle, self.handle);
            if result.is_null() {
                return String::new();
            }
            let text = if (*result).text.is_null() {
                String::new()
            } else {
                CStr::from_ptr((*result).text).to_string_lossy().into_owned()
            };
            (api.destroy_result)(result);
            text
        }
    }

    /// Marks the end of the utterance and drains the decoder. The tail padding
    /// is what lets the transducer emit its final word.
    pub fn finish(&self) {
        let api = &self.recognizer.api;
        let padding = vec![0.0f32; FLUSH_PADDING_FRAMES];
        unsafe {
            (api.accept_waveform)(
                self.handle,
                SAMPLE_RATE,
                padding.as_ptr(),
                padding.len() as i32,
            );
            (api.input_finished)(self.handle);
        }
        self.decode_ready();
    }
}

impl Drop for Stream<'_> {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { (self.recognizer.api.destroy_stream)(self.handle) };
        }
    }
}

fn cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|e| format!("path contains an interior NUL: {e}"))
}

/// Loads onnxruntime.dll first so the loader resolves it by name when
/// sherpa-onnx-c-api.dll imports it, then binds the entry points. Both
/// libraries are intentionally leaked: the recognizer lives for the process
/// lifetime and unloading an ORT DLL under a live session is not worth the
/// teardown ordering risk.
fn load_api(dir: &Path) -> Result<Api, String> {
    let onnxruntime = dir.join("onnxruntime.dll");
    let c_api = dir.join("sherpa-onnx-c-api.dll");
    if !c_api.is_file() {
        return Err(format!(
            "sherpa-onnx-c-api.dll is missing from {} (run npm run predownload:dictation)",
            dir.display()
        ));
    }
    unsafe {
        if onnxruntime.is_file() {
            match libloading::Library::new(&onnxruntime) {
                Ok(library) => {
                    let _ = Box::leak(Box::new(library));
                }
                Err(e) => return Err(format!("failed to load onnxruntime.dll: {e}")),
            }
        }
        let library = libloading::Library::new(&c_api)
            .map_err(|e| format!("failed to load sherpa-onnx-c-api.dll: {e}"))?;
        let library: &'static libloading::Library = Box::leak(Box::new(library));

        macro_rules! bind {
            ($name:literal, $ty:ty) => {{
                let symbol: libloading::Symbol<'static, $ty> = library
                    .get(concat!($name, "\0").as_bytes())
                    .map_err(|e| format!("sherpa-onnx is missing {}: {e}", $name))?;
                *symbol
            }};
        }

        Ok(Api {
            create_recognizer: bind!("SherpaOnnxCreateOnlineRecognizer", CreateRecognizerFn),
            destroy_recognizer: bind!("SherpaOnnxDestroyOnlineRecognizer", DestroyRecognizerFn),
            create_stream: bind!("SherpaOnnxCreateOnlineStream", CreateStreamFn),
            create_stream_with_hotwords: bind!(
                "SherpaOnnxCreateOnlineStreamWithHotwords",
                CreateStreamWithHotwordsFn
            ),
            destroy_stream: bind!("SherpaOnnxDestroyOnlineStream", DestroyStreamFn),
            accept_waveform: bind!("SherpaOnnxOnlineStreamAcceptWaveform", AcceptWaveformFn),
            is_ready: bind!("SherpaOnnxIsOnlineStreamReady", IsReadyFn),
            decode: bind!("SherpaOnnxDecodeOnlineStream", DecodeFn),
            get_result: bind!("SherpaOnnxGetOnlineStreamResult", GetResultFn),
            destroy_result: bind!("SherpaOnnxDestroyOnlineRecognizerResult", DestroyResultFn),
            input_finished: bind!("SherpaOnnxOnlineStreamInputFinished", InputFinishedFn),
        })
    }
}
