//! The interview's own audio, sealed on this device.
//!
//! Interview Companion already transcribes both legs; this keeps what was
//! actually SAID, so a candidate can hear the question again rather than trust
//! a transcript of it. Everything here mirrors `dictation/history.rs`'s clip
//! path deliberately, down to the encoder call, because that pattern is already
//! shipping: FLAC via `meeting::audio::encode_flac`, AES-256-GCM via
//! `crypto::encrypt_with_aad`, atomic writes via `fsx`.
//!
//! Three things are NOT like dictation, and each is load-bearing:
//!
//! - **The recording is chunked.** A session runs up to two hours, which is
//!   about 230 MB of raw 16 kHz mono PCM. Buffering that to encode once at the
//!   end would hold it all in memory and lose everything on a crash. Each
//!   `CHUNK_SECONDS` of audio is encoded, sealed and written on its own, so peak
//!   memory is one chunk and a killed process keeps every chunk already written.
//!
//! - **There is no database column.** The directory IS the record: a session has
//!   audio exactly when `interview-clips/<session_id>/` holds chunks. A path
//!   column would be a second copy of that fact and could disagree with the disk
//!   after a failed write or a partial delete. `interview_store`'s schema and
//!   its FROZEN AAD grammar are untouched by this module.
//!
//! - **Both legs are mixed down.** The broker hands over microphone and render
//!   loopback as separate frames at one fixed rate (`audio_capture::SAMPLE_RATE`),
//!   and a recording that appended them in arrival order would alternate between
//!   two speakers mid-word. They are summed per chunk instead, which re-aligns
//!   every chunk boundary so no clock drift accumulates across the session.
//!
//! Nothing here is ever logged beyond counts, byte sizes and outcomes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use tauri::{AppHandle, Manager};

use crate::audio_capture::{self, AudioSource, CaptureEvent, Delivery};
/// The SAME key `interview_store` seals its turns and exchanges with. An
/// interview's transcript and its audio are one record, so splitting them across
/// two key files would let a key loss leave half of it readable. (That key lives
/// under the meeting captures directory today, which is a coupling this module
/// inherits rather than introduces.)
use crate::meeting::crypto;

/// Sits beside `interview-sessions.sqlite3` in the app's local data dir.
const CLIPS_DIR: &str = "interview-clips";

/// The broker fans out by NAME, so this is a second consumer alongside the ASR
/// one rather than a share of it. That is the whole point: the ASR leg is
/// `Bounded` and drops frames under pressure, which is right for transcription
/// and wrong for a recording, and making it lossless instead would trade answer
/// latency for audio fidelity.
const CONSUMER_NAME: &str = "interview-audio";

/// One chunk is ~3.8 MB of i32 samples in memory and ~1 to 2 MB on disk.
const CHUNK_SECONDS: usize = 120;
const CHUNK_SAMPLES: usize = CHUNK_SECONDS * audio_capture::SAMPLE_RATE;

/// Idle poll. The consumer only offers `try_recv`, same as the worker loop.
const POLL_MS: u64 = 50;

/// Whichever bites first, evicted oldest session first. Speech FLAC at 16 kHz
/// mono runs roughly 30 MB an hour, so this holds on the order of a dozen full
/// length interviews.
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// A NEW namespace, not a slot added to `interview_store`'s. That one is frozen
/// because rows already sealed under it must keep decrypting; this module seals
/// nothing that exists yet, so it gets its own grammar and cannot disturb it.
const AAD_NAMESPACE: &str = "aura-interview-audio-v1";

fn chunk_aad(uid: &str, session_id: &str, index: u32) -> String {
    crate::sealed_store::aad(AAD_NAMESPACE, &[uid, session_id, &index.to_string()])
}

fn clips_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(CLIPS_DIR);
    Ok(dir)
}

/// Session ids come from the worker (`interview-<ms>-<n>`), but this builds a
/// path from one, so anything that could escape the directory is refused rather
/// than sanitised into something that silently misses.
fn session_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid interview session id".to_string());
    }
    Ok(clips_dir(app)?.join(session_id))
}

fn chunk_path(dir: &Path, index: u32) -> PathBuf {
    dir.join(format!("{index:05}.flac.enc"))
}

// ------------------------------------------------------------------ recording

/// Owns the recorder thread. Dropping it stops the recording the same way
/// `stop()` does, so a worker that unwinds still finalises its audio.
pub(crate) struct Recorder {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Recorder {
    pub(crate) fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts recording, or returns `None` with a warning logged.
///
/// Never an `Err`: this is not allowed to be a reason Start fails. A missing
/// key, a directory that will not create, or a stale consumer of the same name
/// costs the recording and nothing else, which is the right trade against
/// failing an interview the candidate is already sitting in.
pub(crate) fn start(app: &AppHandle, uid: &str, session_id: &str) -> Option<Recorder> {
    if uid.is_empty() {
        return None;
    }
    let dir = match session_dir(app, session_id) {
        Ok(dir) => dir,
        Err(error) => {
            log::warn!("interview_audio: path rejected: {error}");
            return None;
        }
    };
    if let Err(error) = std::fs::create_dir_all(&dir) {
        log::warn!("interview_audio: clips dir failed: {error}");
        return None;
    }
    let key = match crypto::load_or_create_key(app) {
        Ok(key) => key,
        Err(error) => {
            log::warn!("interview_audio: key unavailable: {error}");
            return None;
        }
    };
    let mut consumer = match audio_capture::subscribe(CONSUMER_NAME, Delivery::Lossless) {
        Ok(consumer) => consumer,
        Err(error) => {
            log::warn!("interview_audio: subscribe failed: {error}");
            return None;
        }
    };

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let uid = uid.to_string();
    let session_id = session_id.to_string();
    let handle = std::thread::Builder::new()
        .name("aura-interview-audio".into())
        .spawn(move || {
            let mut mic: Vec<i32> = Vec::with_capacity(CHUNK_SAMPLES);
            let mut loopback: Vec<i32> = Vec::with_capacity(CHUNK_SAMPLES);
            let mut index: u32 = 0;
            let mut written: u64 = 0;

            loop {
                let mut idle = true;
                while let Ok(event) = consumer.try_recv() {
                    idle = false;
                    if let CaptureEvent::Frame(frame) = event {
                        let target = match frame.source {
                            AudioSource::Microphone => &mut mic,
                            AudioSource::Loopback => &mut loopback,
                        };
                        target.extend(frame.samples.iter().map(|sample| {
                            let scaled = sample.clamp(-1.0, 1.0) * i16::MAX as f32;
                            scaled.round() as i32
                        }));
                    }
                }
                if mic.len() >= CHUNK_SAMPLES || loopback.len() >= CHUNK_SAMPLES {
                    written += flush(&dir, &key, &uid, &session_id, index, &mut mic, &mut loopback);
                    index += 1;
                }
                if thread_stop.load(Ordering::Relaxed) {
                    break;
                }
                if idle {
                    std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
                }
            }

            // One final drain: `stop()` leaves the receiver readable precisely
            // so the tail of the interview is not lost with it.
            consumer.stop();
            while let Ok(CaptureEvent::Frame(frame)) = consumer.try_recv() {
                let target = match frame.source {
                    AudioSource::Microphone => &mut mic,
                    AudioSource::Loopback => &mut loopback,
                };
                target.extend(frame.samples.iter().map(|sample| {
                    let scaled = sample.clamp(-1.0, 1.0) * i16::MAX as f32;
                    scaled.round() as i32
                }));
            }
            written += flush(&dir, &key, &uid, &session_id, index, &mut mic, &mut loopback);
            log::info!(
                "interview.audio: finished chunks={} bytes={}",
                index + 1,
                written
            );
        });

    match handle {
        Ok(handle) => Some(Recorder {
            stop,
            handle: Some(handle),
        }),
        Err(error) => {
            log::warn!("interview_audio: thread spawn failed: {error}");
            None
        }
    }
}

/// Mixes one chunk down, encodes, seals and writes it. Returns the sealed byte
/// count, or 0 when there was nothing to write or the write failed: a chunk that
/// cannot be stored must not take the interview down with it.
fn flush(
    dir: &Path,
    key: &[u8; 32],
    uid: &str,
    session_id: &str,
    index: u32,
    mic: &mut Vec<i32>,
    loopback: &mut Vec<i32>,
) -> u64 {
    let len = mic.len().max(loopback.len());
    if len == 0 {
        return 0;
    }
    // Summed, then clamped. Both legs are the same rate and start at the same
    // chunk boundary, so a shorter one is simply silence for the remainder -
    // which is the normal case, since loopback stays silent whenever nothing is
    // playing through this machine.
    let mixed: Vec<i32> = (0..len)
        .map(|i| {
            let a = mic.get(i).copied().unwrap_or(0);
            let b = loopback.get(i).copied().unwrap_or(0);
            (a + b).clamp(i16::MIN as i32, i16::MAX as i32)
        })
        .collect();
    mic.clear();
    loopback.clear();

    let written = (|| -> Result<u64, String> {
        let flac = crate::meeting::audio::encode_flac(&mixed, 1)?;
        let sealed =
            crypto::encrypt_with_aad(key, &flac, chunk_aad(uid, session_id, index).as_bytes())?;
        crate::fsx::write_atomic(
            &chunk_path(dir, index),
            &sealed,
            crate::fsx::Durability::Fsync,
        )?;
        Ok(sealed.len() as u64)
    })();

    match written {
        Ok(bytes) => bytes,
        Err(error) => {
            log::warn!("interview_audio: chunk {index} not stored: {error}");
            0
        }
    }
}

// ------------------------------------------------------------------- playback

fn chunk_files(dir: &Path) -> Vec<(u32, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(u32, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let index = name.strip_suffix(".flac.enc")?.parse::<u32>().ok()?;
            Some((index, path))
        })
        .collect();
    files.sort_by_key(|(index, _)| *index);
    files
}

/// True when this session has any audio left on disk. Retention can evict the
/// clips while keeping the session row, so "transcript present, audio gone" is a
/// normal state every caller has to render rather than treat as an error.
pub(crate) fn has_audio(app: &AppHandle, session_id: &str) -> bool {
    session_dir(app, session_id)
        .map(|dir| !chunk_files(&dir).is_empty())
        .unwrap_or(false)
}

/// The whole session as one WAV.
///
/// WAV rather than the stored FLAC for the same reason `dictation/history.rs`
/// converts: WKWebView does not decode FLAC. Chunks are decoded and concatenated
/// as PCM, so the join is sample-exact and the header is written once.
pub(crate) fn session_wav(
    app: &AppHandle,
    uid: &str,
    session_id: &str,
) -> Result<Vec<u8>, String> {
    let dir = session_dir(app, session_id)?;
    let files = chunk_files(&dir);
    if files.is_empty() {
        return Err("no audio is stored for this interview".to_string());
    }
    let key = crypto::load_or_create_key(app)?;
    let mut pcm: Vec<u8> = Vec::new();
    for (index, path) in files {
        let sealed = std::fs::read(&path).map_err(|e| e.to_string())?;
        let flac = crypto::decrypt_with_aad(
            &key,
            &sealed,
            chunk_aad(uid, session_id, index).as_bytes(),
        )?;
        let mut reader = claxon::FlacReader::new(std::io::Cursor::new(flac))
            .map_err(|e| format!("flac open: {e:?}"))?;
        for sample in reader.samples() {
            let sample = sample.map_err(|e| format!("flac decode: {e:?}"))?;
            pcm.extend_from_slice(&(sample as i16).to_le_bytes());
        }
    }

    const BITS: u16 = 16;
    const CHANNELS: u16 = 1;
    let rate = audio_capture::SAMPLE_RATE as u32;
    let block_align = CHANNELS * (BITS / 8);
    let data_len = u32::try_from(pcm.len()).map_err(|_| "recording too large".to_string())?;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes()); // PCM, uncompressed
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * u32::from(block_align)).to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&BITS.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(&pcm);
    Ok(wav)
}

// ------------------------------------------------------------------ retention

fn dir_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.metadata().ok())
                .map(|meta| meta.len())
                .sum()
        })
        .unwrap_or(0)
}

fn remove_session(app: &AppHandle, session_id: &str) {
    if let Ok(dir) = session_dir(app, session_id) {
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("interview_audio: delete failed: {error}");
            }
        }
    }
}

pub(crate) fn delete_session(app: &AppHandle, session_id: &str) {
    remove_session(app, session_id);
}

/// Drops every recording whose session is gone, then enforces age and size.
///
/// `live` is the set of session ids the store still holds, so the database stays
/// the index and the filesystem follows it. A directory with no row can only be
/// an orphan, and keeping it would be storage nobody can reach or delete from
/// the UI.
pub(crate) fn sweep(app: &AppHandle, live: &[String], now_ms: i64) {
    let Ok(root) = clips_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let mut kept: Vec<(i64, u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !live.iter().any(|id| id == name) {
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|delta| delta.as_millis() as i64)
            .unwrap_or(now_ms);
        if now_ms - modified > MAX_AGE_MS {
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        kept.push((modified, dir_bytes(&path), path));
    }

    let mut total: u64 = kept.iter().map(|(_, bytes, _)| *bytes).sum();
    if total <= MAX_TOTAL_BYTES {
        return;
    }
    // Oldest first, and only as far as it takes to fit. Eviction removes the
    // clips and nothing else: the session row, its turns and its exchanges stay,
    // so the interview is still readable with its audio gone.
    kept.sort_by_key(|(modified, _, _)| *modified);
    for (_, bytes, path) in kept {
        if total <= MAX_TOTAL_BYTES {
            break;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
}

// -------------------------------------------------------------------- command

/// The whole interview as one WAV, for the Interview page's player.
///
/// `async` and off the main thread: this decrypts and decodes every chunk of a
/// session that can run two hours, which is exactly the work a synchronous
/// command would freeze the window with.
#[tauri::command]
pub async fn interview_session_audio(
    app: AppHandle,
    uid: String,
    session_id: String,
) -> Result<tauri::ipc::Response, String> {
    if uid.is_empty() || session_id.is_empty() {
        return Err("no audio is stored for this interview".to_string());
    }
    crate::security::authorize(&app, crate::security::Operation::StartInterviewHacker)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(tauri::ipc::Response::new(session_wav(&app, &uid, &session_id)?))
    })
    .await
    .map_err(|e| e.to_string())?
}
