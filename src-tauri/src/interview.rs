//! Explicit, video-call-only Interview Companion runtime.
//!
//! The shared audio broker supplies microphone and render-loopback frames.
//! Each physical source owns a separate continuous ASR session, preserving
//! speaker provenance before any transcript reaches the webview.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, mpsc};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use crate::audio_capture::{self, AudioSource, CaptureEvent, Delivery};
#[cfg(windows)]
use crate::dictation::asr::{
    self, AsrError, ContinuousAsrEvent, ContinuousAsrSession, ContinuousSessionConfig,
};

const STATUS_EVENT: &str = "interview-companion-status";
const TRANSCRIPT_EVENT: &str = "interview-companion-transcript";
const BRIEF_EVENT: &str = "interview-brief-updated";
const MAX_BRIEF_BYTES: usize = 128_000;
#[cfg(windows)]
const ENDPOINTING_MS: u16 = 300;
#[cfg(windows)]
const MAX_RECONNECTS: u8 = 10;
#[cfg(windows)]
const DEEPGRAM_RECONNECTS: u8 = 5;
#[cfg(windows)]
const MAX_RECONNECT_BACKOFF_SECS: u64 = 30;
#[cfg(windows)]
const SESSION_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);

enum RuntimeCommand {
    Pause,
    Resume,
    UpdateCredentials(TranscriptionCredentials),
    Stop,
}

struct TranscriptionCredentials {
    deepgram: String,
    openai: String,
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum TranscriptionProvider {
    Deepgram,
    OpenAi,
}

#[cfg(windows)]
impl TranscriptionProvider {
    fn credential<'a>(self, credentials: &'a TranscriptionCredentials) -> &'a str {
        match self {
            Self::Deepgram => &credentials.deepgram,
            Self::OpenAi => &credentials.openai,
        }
    }

    fn retry_floor(self) -> u8 {
        match self {
            Self::Deepgram => 0,
            Self::OpenAi => DEEPGRAM_RECONNECTS,
        }
    }
}

struct ActiveInterview {
    epoch: u64,
    session_id: String,
    app_name: String,
    paused: bool,
    phase: String,
    commands: mpsc::Sender<RuntimeCommand>,
}

#[derive(Default)]
pub struct InterviewHandle(
    Mutex<Option<ActiveInterview>>,
    AtomicU64,
    Mutex<Option<serde_json::Value>>,
);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedCallPayload {
    supported: bool,
    app: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewStatusPayload {
    phase: String,
    session_id: Option<String>,
    epoch: Option<u64>,
    app: Option<String>,
    reason: Option<String>,
}

#[cfg(windows)]
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum TranscriptSource {
    Candidate,
    Remote,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptPayload {
    session_id: String,
    epoch: u64,
    turn_id: String,
    source: TranscriptSource,
    start_ms: u64,
    end_ms: u64,
    text: String,
    is_final: bool,
    remote_speaker_id: Option<String>,
    speaker_overlap: bool,
    final_word_at_ms: Option<u64>,
}

fn snapshot(handle: &InterviewHandle) -> InterviewStatusPayload {
    let state = handle.0.lock().unwrap_or_else(|error| error.into_inner());
    match state.as_ref() {
        Some(active) => InterviewStatusPayload {
            phase: active.phase.clone(),
            session_id: Some(active.session_id.clone()),
            epoch: Some(active.epoch),
            app: Some(active.app_name.clone()),
            reason: None,
        },
        None => stopped_status(None),
    }
}

fn stopped_status(reason: Option<&str>) -> InterviewStatusPayload {
    InterviewStatusPayload {
        phase: "stopped".to_string(),
        session_id: None,
        epoch: None,
        app: None,
        reason: reason.map(str::to_string),
    }
}

#[tauri::command]
pub async fn interview_supported_call(app: AppHandle) -> Result<SupportedCallPayload, String> {
    let ticket = crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewCompanion,
    )?;
    #[cfg(windows)]
    let detected = tauri::async_runtime::spawn_blocking(crate::meeting::detect::find_meeting_window)
        .await
        .map_err(|_| "call detection failed".to_string())?;
    #[cfg(not(windows))]
    let detected: Option<(String, String)> = None;
    crate::security::recheck(
        &app,
        crate::security::Operation::StartInterviewCompanion,
        &ticket,
    )?;
    Ok(SupportedCallPayload {
        supported: detected.is_some(),
        app: detected.map(|(app_name, _)| app_name),
    })
}

#[tauri::command]
pub async fn start_interview_companion(
    app: AppHandle,
    access_token: String,
    openai_access_token: Option<String>,
) -> Result<InterviewStatusPayload, String> {
    let credentials = TranscriptionCredentials {
        deepgram: access_token,
        openai: openai_access_token.unwrap_or_default(),
    };
    if credentials.deepgram.trim().is_empty() && credentials.openai.trim().is_empty() {
        return Err("transcription credential is required".to_string());
    }
    let cancel_generation = app.state::<InterviewHandle>().1.load(Ordering::Relaxed);
    let ticket = crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewCompanion,
    )?;
    #[cfg(windows)]
    let detected = tauri::async_runtime::spawn_blocking(crate::meeting::detect::find_meeting_window)
        .await
        .map_err(|_| "call detection failed".to_string())?;
    #[cfg(not(windows))]
    let detected: Option<(String, String)> = None;
    crate::security::recheck(
        &app,
        crate::security::Operation::StartInterviewCompanion,
        &ticket,
    )?;
    let Some((app_name, _)) = detected else {
        return Err("Open a supported Zoom, Teams, or Google Meet call first.".to_string());
    };

    let handle = app.state::<InterviewHandle>();
    let mut state = handle.0.lock().unwrap_or_else(|error| error.into_inner());
    if handle.1.load(Ordering::Relaxed) != cancel_generation {
        return Err("Interview Companion start was cancelled.".to_string());
    }
    if state.is_some() {
        return Err("Interview Companion is already active.".to_string());
    }
    #[cfg(not(windows))]
    return Err("Interview Companion currently requires Windows.".to_string());
    #[cfg(windows)]
    {
        static NEXT_EPOCH: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        let epoch = NEXT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let session_id = format!("interview-{}-{epoch}", crate::meeting::now_ms());
        let (command_tx, command_rx) = mpsc::channel();
        *state = Some(ActiveInterview {
            epoch,
            session_id: session_id.clone(),
            app_name: app_name.clone(),
            paused: false,
            phase: "starting".to_string(),
            commands: command_tx,
        });
        drop(state);

        emit_status(
            &app,
            "starting",
            Some(&session_id),
            Some(epoch),
            Some(&app_name),
            None,
        );
        let worker_app = app.clone();
        std::thread::Builder::new()
            .name("aura-interview".to_string())
            .spawn(move || {
                run_worker(
                    worker_app,
                    credentials,
                    session_id,
                    app_name,
                    epoch,
                    command_rx,
                );
            })
            .map_err(|error| {
                let handle = app.state::<InterviewHandle>();
                *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
                format!("could not start Interview Companion: {error}")
            })?;
        Ok(snapshot(&handle))
    }
}

#[tauri::command]
pub fn pause_interview_companion(app: AppHandle) -> Result<InterviewStatusPayload, String> {
    set_paused(&app, true)
}

#[tauri::command]
pub fn resume_interview_companion(app: AppHandle) -> Result<InterviewStatusPayload, String> {
    set_paused(&app, false)
}

fn set_paused(app: &AppHandle, paused: bool) -> Result<InterviewStatusPayload, String> {
    let handle = app.state::<InterviewHandle>();
    let mut state = handle.0.lock().unwrap_or_else(|error| error.into_inner());
    let active = state
        .as_mut()
        .ok_or_else(|| "Interview Companion is not active.".to_string())?;
    let retrying_failure = !paused && matches!(active.phase.as_str(), "degraded" | "error");
    if active.paused == paused && !retrying_failure {
        return Ok(snapshot_locked(active));
    }
    active
        .commands
        .send(if paused {
            RuntimeCommand::Pause
        } else {
            RuntimeCommand::Resume
        })
        .map_err(|_| "Interview Companion worker is unavailable.".to_string())?;
    active.paused = paused;
    active.phase = if paused { "paused" } else { "starting" }.to_string();
    let status = snapshot_locked(active);
    drop(state);
    let _ = app.emit(STATUS_EVENT, status.clone());
    Ok(status)
}

fn snapshot_locked(active: &ActiveInterview) -> InterviewStatusPayload {
    InterviewStatusPayload {
        phase: active.phase.clone(),
        session_id: Some(active.session_id.clone()),
        epoch: Some(active.epoch),
        app: Some(active.app_name.clone()),
        reason: None,
    }
}

#[tauri::command]
pub fn interview_companion_status(app: AppHandle) -> InterviewStatusPayload {
    snapshot(&app.state::<InterviewHandle>())
}

#[tauri::command]
pub fn update_interview_companion_credential(
    app: AppHandle,
    session_id: String,
    epoch: u64,
    access_token: String,
    openai_access_token: Option<String>,
) -> Result<(), String> {
    let credentials = TranscriptionCredentials {
        deepgram: access_token,
        openai: openai_access_token.unwrap_or_default(),
    };
    if credentials.deepgram.trim().is_empty() && credentials.openai.trim().is_empty() {
        return Err("transcription credential is required".to_string());
    }
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewCompanion,
    )?;
    let handle = app.state::<InterviewHandle>();
    let state = handle.0.lock().unwrap_or_else(|error| error.into_inner());
    let active = state
        .as_ref()
        .filter(|active| active.session_id == session_id && active.epoch == epoch)
        .ok_or_else(|| "Interview Companion session is no longer active.".to_string())?;
    active
        .commands
        .send(RuntimeCommand::UpdateCredentials(credentials))
        .map_err(|_| "Interview Companion worker is unavailable.".to_string())
}

#[tauri::command]
pub fn set_interview_companion_brief(
    app: AppHandle,
    brief: serde_json::Value,
) -> Result<(), String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewCompanion,
    )?;
    let object = brief
        .as_object()
        .ok_or_else(|| "Interview brief must be an object.".to_string())?;
    if object.get("contractVersion").and_then(serde_json::Value::as_u64) != Some(3)
        || object.get("briefId").and_then(serde_json::Value::as_str).is_none()
        || object.get("reviewedAtMs").and_then(serde_json::Value::as_u64).is_none()
    {
        return Err("Interview brief has not been reviewed.".to_string());
    }
    let encoded = serde_json::to_vec(&brief)
        .map_err(|_| "Interview brief could not be read.".to_string())?;
    if encoded.len() > MAX_BRIEF_BYTES {
        return Err("Interview brief is too large.".to_string());
    }
    let handle = app.state::<InterviewHandle>();
    *handle.2.lock().unwrap_or_else(|error| error.into_inner()) = Some(brief.clone());
    let _ = app.emit(BRIEF_EVENT, brief);
    Ok(())
}

#[tauri::command]
pub fn interview_companion_brief(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewCompanion,
    )?;
    let handle = app.state::<InterviewHandle>();
    let brief = handle
        .2
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    Ok(brief)
}

#[tauri::command]
pub fn clear_interview_companion_brief(app: AppHandle) -> Result<(), String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewCompanion,
    )?;
    clear_preparation(&app);
    Ok(())
}

pub fn clear_preparation(app: &AppHandle) {
    let Some(handle) = app.try_state::<InterviewHandle>() else {
        return;
    };
    let removed = handle
        .2
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
        .is_some();
    if removed {
        let _ = app.emit(BRIEF_EVENT, Option::<serde_json::Value>::None);
    }
}

#[tauri::command]
pub fn stop_interview_companion(app: AppHandle) -> InterviewStatusPayload {
    request_stop(&app, "user");
    stopped_status(Some("user"))
}

pub fn request_stop(app: &AppHandle, reason: &str) {
    let Some(handle) = app.try_state::<InterviewHandle>() else {
        return;
    };
    handle.1.fetch_add(1, Ordering::Relaxed);
    let active = handle
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(active) = active {
        let _ = active.commands.send(RuntimeCommand::Stop);
        let _ = app.emit(
            STATUS_EVENT,
            InterviewStatusPayload {
                phase: "stopped".to_string(),
                session_id: Some(active.session_id),
                epoch: Some(active.epoch),
                app: Some(active.app_name),
                reason: Some(reason.to_string()),
            },
        );
    }
}

pub fn is_active(app: &AppHandle) -> bool {
    app.try_state::<InterviewHandle>()
        .map(|handle| {
            handle
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some()
        })
        .unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewReflectionExport {
    path: String,
}

#[tauri::command]
pub async fn save_interview_reflection(
    app: AppHandle,
    markdown: String,
) -> Result<InterviewReflectionExport, String> {
    let trimmed = markdown.trim();
    if trimmed.is_empty() || trimmed.len() > 64_000 {
        return Err("Interview reflection is empty or too large.".to_string());
    }
    let ticket = crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewCompanion,
    )?;
    let destination = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?
        .join("Aura Interview Reflections")
        .join(format!("interview-reflection-{}.md", crate::meeting::now_ms()));
    let content = format!("{}\n", trimmed);
    let output = destination.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let parent = output
            .parent()
            .ok_or_else(|| "Interview reflection path is invalid.".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| error.to_string())?;
        use std::io::Write as _;
        file.write_all(content.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::security::recheck(
        &app,
        crate::security::Operation::StartInterviewCompanion,
        &ticket,
    )?;
    Ok(InterviewReflectionExport {
        path: destination.to_string_lossy().to_string(),
    })
}

fn emit_status(
    app: &AppHandle,
    phase: &str,
    session_id: Option<&str>,
    epoch: Option<u64>,
    app_name: Option<&str>,
    reason: Option<&str>,
) {
    match phase {
        "error" => log::error!(
            "interview.companion: phase=error reason={} epoch={}",
            reason.unwrap_or("unknown"),
            epoch.unwrap_or_default()
        ),
        "degraded" => log::warn!(
            "interview.companion: phase=degraded reason={} epoch={}",
            reason.unwrap_or("unknown"),
            epoch.unwrap_or_default()
        ),
        _ if reason.is_some() => log::info!(
            "interview.companion: phase={phase} reason={} epoch={}",
            reason.unwrap_or("unknown"),
            epoch.unwrap_or_default()
        ),
        _ => {}
    }
    if let (Some(epoch), Some(handle)) = (epoch, app.try_state::<InterviewHandle>()) {
        let mut state = handle.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(active) = state.as_mut().filter(|active| active.epoch == epoch) {
            active.phase = phase.to_string();
            active.paused = phase == "paused";
        }
    }
    let _ = app.emit(
        STATUS_EVENT,
        InterviewStatusPayload {
            phase: phase.to_string(),
            session_id: session_id.map(str::to_string),
            epoch,
            app: app_name.map(str::to_string),
            reason: reason.map(str::to_string),
        },
    );
}

#[cfg(windows)]
struct Streams {
    capture: audio_capture::CaptureConsumer,
    candidate: Box<dyn ContinuousAsrSession>,
    remote: Box<dyn ContinuousAsrSession>,
}

#[cfg(windows)]
fn open_streams(
    provider: TranscriptionProvider,
    credentials: &TranscriptionCredentials,
) -> Result<Streams, AsrError> {
    let capture = audio_capture::subscribe(
        "interview-companion",
        Delivery::Bounded { capacity: 512 },
    )
    .map_err(|_| AsrError::Provider)?;
    let credential = provider.credential(credentials);
    let asr_provider = match provider {
        TranscriptionProvider::Deepgram => asr::deepgram_provider(),
        TranscriptionProvider::OpenAi => asr::openai_provider(),
    };
    let config = |diarize| ContinuousSessionConfig {
        sample_rate: asr::SAMPLE_RATE,
        keyterms: Vec::new(),
        credential: credential.to_string(),
        endpointing_ms: ENDPOINTING_MS,
        diarize,
    };
    let mut candidate = asr_provider.start_continuous(config(false))?;
    let remote = match asr_provider.start_continuous(config(true)) {
        Ok(session) => session,
        Err(error) => {
            candidate.cancel();
            return Err(error);
        }
    };
    Ok(Streams {
        capture,
        candidate,
        remote,
    })
}

#[cfg(windows)]
fn reconnect_delay(next_attempt: u8) -> Duration {
    let exponent = next_attempt.saturating_sub(1).min(5);
    Duration::from_secs((1u64 << exponent).min(MAX_RECONNECT_BACKOFF_SECS))
}

#[cfg(windows)]
fn close_streams(streams: &mut Option<Streams>) {
    if let Some(mut live) = streams.take() {
        live.candidate.cancel();
        live.remote.cancel();
        live.capture.stop();
    }
}

#[cfg(windows)]
fn source_failure_code(source: TranscriptSource, error: AsrError) -> &'static str {
    match (source, error) {
        (TranscriptSource::Candidate, AsrError::NotAuthenticated) => "candidate_no_credential",
        (TranscriptSource::Candidate, AsrError::Rejected) => "candidate_auth_rejected",
        (TranscriptSource::Candidate, AsrError::Network) => "candidate_network",
        (TranscriptSource::Candidate, AsrError::Timeout) => "candidate_timeout",
        (TranscriptSource::Candidate, AsrError::Provider) => "candidate_provider_error",
        (TranscriptSource::Remote, AsrError::NotAuthenticated) => "remote_no_credential",
        (TranscriptSource::Remote, AsrError::Rejected) => "remote_auth_rejected",
        (TranscriptSource::Remote, AsrError::Network) => "remote_network",
        (TranscriptSource::Remote, AsrError::Timeout) => "remote_timeout",
        (TranscriptSource::Remote, AsrError::Provider) => "remote_provider_error",
    }
}

#[cfg(windows)]
fn run_worker(
    app: AppHandle,
    mut credentials: TranscriptionCredentials,
    session_id: String,
    app_name: String,
    epoch: u64,
    commands: mpsc::Receiver<RuntimeCommand>,
) {
    let started_at = Instant::now();
    let mut provider = if credentials.deepgram.trim().is_empty() {
        TranscriptionProvider::OpenAi
    } else {
        TranscriptionProvider::Deepgram
    };
    let (mut streams, mut credential_blocked, initial_failure) = match open_streams(provider, &credentials) {
        Ok(streams) => (Some(streams), false, None),
        Err(error) => (
            None,
            matches!(error, AsrError::NotAuthenticated | AsrError::Rejected),
            Some(error.category()),
        ),
    };
    let mut paused = false;
    let mut reconnects = provider.retry_floor();
    let mut retry_at = Instant::now()
        + if streams.is_some() {
            Duration::ZERO
        } else {
            reconnect_delay(1)
        };
    let mut stable_since = streams.as_ref().map(|_| Instant::now());
    let mut candidate_start = None;
    let mut remote_start = None;
    let mut candidate_turn = 0u64;
    let mut remote_turn = 0u64;
    let mut stop_reason = None;

    if streams.is_some() {
        emit_status(
            &app,
            "listening",
            Some(&session_id),
            Some(epoch),
            Some(&app_name),
            None,
        );
    } else {
        emit_status(
            &app,
            "degraded",
            Some(&session_id),
            Some(epoch),
            Some(&app_name),
            Some(if credential_blocked {
                "credential_expired"
            } else {
                initial_failure.unwrap_or("transcription_unavailable")
            }),
        );
    }

    'runtime: loop {
        if started_at.elapsed() >= SESSION_LIMIT {
            stop_reason = Some("session_limit");
            break;
        }
        while let Ok(command) = commands.try_recv() {
            match command {
                RuntimeCommand::Pause => {
                    paused = true;
                    close_streams(&mut streams);
                    candidate_start = None;
                    remote_start = None;
                }
                RuntimeCommand::Resume => {
                    paused = false;
                    reconnects = provider.retry_floor();
                    retry_at = Instant::now();
                    // Resume is also the card's "Retry transcription". Leaving
                    // this set makes the reconnect guard below skip forever, so
                    // the retry emits no status at all and the card sits on the
                    // "starting" set_paused already painted. If the credential
                    // really is dead, the next open_streams sets it again and
                    // re-emits the error - one honest attempt either way.
                    credential_blocked = false;
                }
                RuntimeCommand::UpdateCredentials(next_credentials) => {
                    credentials = next_credentials;
                    if provider.credential(&credentials).trim().is_empty() {
                        provider = if credentials.deepgram.trim().is_empty() {
                            TranscriptionProvider::OpenAi
                        } else {
                            TranscriptionProvider::Deepgram
                        };
                    }
                    credential_blocked = false;
                    reconnects = provider.retry_floor();
                    retry_at = Instant::now();
                }
                RuntimeCommand::Stop => break 'runtime,
            }
        }

        if !paused
            && !credential_blocked
            && streams.is_none()
            && reconnects < MAX_RECONNECTS
            && Instant::now() >= retry_at
        {
            let next_provider = if reconnects < DEEPGRAM_RECONNECTS {
                TranscriptionProvider::Deepgram
            } else {
                TranscriptionProvider::OpenAi
            };
            let switched_provider = provider != next_provider;
            provider = next_provider;
            reconnects += 1;
            match open_streams(provider, &credentials) {
                Ok(next_streams) => {
                    streams = Some(next_streams);
                    stable_since = Some(Instant::now());
                    emit_status(
                        &app,
                        "listening",
                        Some(&session_id),
                        Some(epoch),
                        Some(&app_name),
                        Some(if switched_provider {
                            "fallback_openai"
                        } else {
                            "reconnected"
                        }),
                    );
                }
                Err(AsrError::NotAuthenticated | AsrError::Rejected) => {
                    if provider == TranscriptionProvider::Deepgram
                        && !credentials.openai.trim().is_empty()
                    {
                        reconnects = DEEPGRAM_RECONNECTS;
                        retry_at = Instant::now();
                        emit_status(
                            &app,
                            "degraded",
                            Some(&session_id),
                            Some(epoch),
                            Some(&app_name),
                            Some("fallback_openai"),
                        );
                    } else {
                        credential_blocked = true;
                        emit_status(
                            &app,
                            "error",
                            Some(&session_id),
                            Some(epoch),
                            Some(&app_name),
                            Some("credential_expired"),
                        );
                    }
                }
                Err(error) => {
                    let failure_code = error.category();
                    retry_at = Instant::now()
                        + reconnect_delay((reconnects % DEEPGRAM_RECONNECTS).saturating_add(1));
                    emit_status(
                        &app,
                        if reconnects == MAX_RECONNECTS { "error" } else { "degraded" },
                        Some(&session_id),
                        Some(epoch),
                        Some(&app_name),
                        Some(failure_code),
                    );
                }
            }
        }

        let mut failure = None;
        let mut failure_reason = None;
        if let Some(live) = streams.as_mut() {
            if stable_since.is_some_and(|since| since.elapsed() >= Duration::from_secs(10)) {
                reconnects = provider.retry_floor();
                stable_since = None;
            }
            if live.capture.take_overflowed() {
                emit_status(
                    &app,
                    "degraded",
                    Some(&session_id),
                    Some(epoch),
                    Some(&app_name),
                    Some("audio_overflow"),
                );
                failure = Some(AsrError::Provider);
                failure_reason = Some("audio_overflow");
            }
            while let Ok(event) = live.capture.try_recv() {
                match event {
                    CaptureEvent::Frame(frame) => {
                        let pcm = to_i16(&frame.samples);
                        let captured_at_ms = frame.captured_at_unix_ms;
                        let result = match frame.source {
                            AudioSource::Microphone => {
                                live.candidate.send_pcm(&pcm, captured_at_ms)
                            }
                            AudioSource::Loopback => live.remote.send_pcm(&pcm, captured_at_ms),
                        };
                        if let Err(error) = result {
                            failure_reason = Some(source_failure_code(
                                match frame.source {
                                    AudioSource::Microphone => TranscriptSource::Candidate,
                                    AudioSource::Loopback => TranscriptSource::Remote,
                                },
                                error,
                            ));
                            failure = Some(error);
                            break;
                        }
                    }
                    CaptureEvent::Failed { source } => {
                        failure = Some(AsrError::Provider);
                        failure_reason = Some(match source {
                            AudioSource::Microphone => "candidate_device_unavailable",
                            AudioSource::Loopback => "remote_device_unavailable",
                        });
                        break;
                    }
                    CaptureEvent::DeviceRebound { source } => {
                        candidate_start = None;
                        remote_start = None;
                        failure = Some(AsrError::Provider);
                        failure_reason = Some(match source {
                            AudioSource::Microphone => "candidate_device_switch",
                            AudioSource::Loopback => "remote_device_switch",
                        });
                        break;
                    }
                    // A timing glitch is not a dead stream. Windows sets these
                    // flags at stream start and whenever a render stream goes
                    // idle and resumes, so tearing both ASR sockets down here
                    // would burn the reconnect budget during a normal call.
                    // Only the turn boundaries are no longer trustworthy.
                    CaptureEvent::Glitch { .. } => {
                        candidate_start = None;
                        remote_start = None;
                    }
                    CaptureEvent::DeviceBound { .. } => {}
                }
            }
            if failure.is_none() {
                if let Some(error) = drain_asr(
                    &app,
                    &session_id,
                    epoch,
                    TranscriptSource::Candidate,
                    &mut candidate_turn,
                    &mut candidate_start,
                    live.candidate.as_mut(),
                ) {
                    failure_reason = Some(source_failure_code(TranscriptSource::Candidate, error));
                    failure = Some(error);
                }
                if failure.is_none() {
                    if let Some(error) = drain_asr(
                        &app,
                        &session_id,
                        epoch,
                        TranscriptSource::Remote,
                        &mut remote_turn,
                        &mut remote_start,
                        live.remote.as_mut(),
                    ) {
                        failure_reason = Some(source_failure_code(TranscriptSource::Remote, error));
                        failure = Some(error);
                    }
                }
            }
        }
        if let Some(error) = failure {
            let failure_code = failure_reason.unwrap_or_else(|| error.category());
            close_streams(&mut streams);
            stable_since = None;
            candidate_start = None;
            remote_start = None;
            if matches!(error, AsrError::NotAuthenticated | AsrError::Rejected) {
                if provider == TranscriptionProvider::Deepgram
                    && !credentials.openai.trim().is_empty()
                {
                    reconnects = DEEPGRAM_RECONNECTS;
                    retry_at = Instant::now();
                    emit_status(
                        &app,
                        "degraded",
                        Some(&session_id),
                        Some(epoch),
                        Some(&app_name),
                        Some("fallback_openai"),
                    );
                } else {
                    credential_blocked = true;
                    emit_status(
                        &app,
                        "error",
                        Some(&session_id),
                        Some(epoch),
                        Some(&app_name),
                        Some("credential_expired"),
                    );
                }
            } else {
                retry_at = Instant::now()
                    + reconnect_delay((reconnects % DEEPGRAM_RECONNECTS).saturating_add(1));
                let fallback_ready = provider == TranscriptionProvider::Deepgram
                    && reconnects >= DEEPGRAM_RECONNECTS
                    && !credentials.openai.trim().is_empty();
                emit_status(
                    &app,
                    if reconnects >= MAX_RECONNECTS { "error" } else { "degraded" },
                    Some(&session_id),
                    Some(epoch),
                    Some(&app_name),
                    Some(if fallback_ready {
                        "fallback_openai"
                    } else {
                        failure_code
                    }),
                );
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    close_streams(&mut streams);
    let handle = app.state::<InterviewHandle>();
    let mut state = handle.0.lock().unwrap_or_else(|error| error.into_inner());
    let owned = state.as_ref().is_some_and(|active| active.epoch == epoch);
    if owned {
        *state = None;
    }
    drop(state);
    if owned {
        if let Some(reason) = stop_reason {
            let _ = app.emit(
                STATUS_EVENT,
                InterviewStatusPayload {
                    phase: "stopped".to_string(),
                    session_id: Some(session_id),
                    epoch: Some(epoch),
                    app: Some(app_name),
                    reason: Some(reason.to_string()),
                },
            );
        }
    }
}

#[cfg(windows)]
fn drain_asr(
    app: &AppHandle,
    session_id: &str,
    epoch: u64,
    source: TranscriptSource,
    turn: &mut u64,
    started_at: &mut Option<u64>,
    session: &mut dyn ContinuousAsrSession,
) -> Option<AsrError> {
    while let Some(event) = session.poll() {
        let now = crate::meeting::now_ms().max(0) as u64;
        match event {
            ContinuousAsrEvent::Partial(transcript) => {
                if transcript.text.trim().is_empty() {
                    continue;
                }
                let start_ms = *started_at.get_or_insert(now);
                emit_transcript(
                    app,
                    session_id,
                    epoch,
                    source,
                    *turn,
                    start_ms,
                    now,
                    transcript,
                    false,
                );
            }
            ContinuousAsrEvent::Final(transcript) => {
                if transcript.text.trim().is_empty() {
                    *started_at = None;
                    continue;
                }
                let start_ms = started_at.take().unwrap_or(now);
                emit_transcript(
                    app,
                    session_id,
                    epoch,
                    source,
                    *turn,
                    start_ms,
                    now,
                    transcript,
                    true,
                );
                *turn = turn.wrapping_add(1);
            }
            ContinuousAsrEvent::Failed(error) => return Some(error),
        }
    }
    None
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn emit_transcript(
    app: &AppHandle,
    session_id: &str,
    epoch: u64,
    source: TranscriptSource,
    turn: u64,
    start_ms: u64,
    end_ms: u64,
    transcript: asr::ContinuousTranscript,
    is_final: bool,
) {
    let Some(handle) = app.try_state::<InterviewHandle>() else {
        return;
    };
    if !handle
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .is_some_and(|active| active.epoch == epoch && active.session_id == session_id)
    {
        return;
    }
    let source_id = match source {
        TranscriptSource::Candidate => "candidate",
        TranscriptSource::Remote => "remote",
    };
    let _ = app.emit(
        TRANSCRIPT_EVENT,
        TranscriptPayload {
            session_id: session_id.to_string(),
            epoch,
            turn_id: format!("{epoch}-{source_id}-{turn}"),
            source,
            start_ms,
            end_ms,
            text: transcript.text,
            is_final,
            remote_speaker_id: match source {
                TranscriptSource::Candidate => None,
                TranscriptSource::Remote => transcript
                    .speaker_id
                    .map(|speaker| format!("speaker-{speaker}")),
            },
            speaker_overlap: transcript.speaker_overlap,
            final_word_at_ms: transcript.final_word_at_ms,
        },
    );
}

#[cfg(windows)]
fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| {
            let scaled = sample.clamp(-1.0, 1.0) * i16::MAX as f32;
            scaled.round() as i16
        })
        .collect()
}
