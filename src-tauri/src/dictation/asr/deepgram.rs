//! Deepgram Nova-3 streaming speech recognition over one WebSocket per hold.
//!
//! This is the ONLY Deepgram-aware file in the codebase. Everything the
//! dictation worker sees is `AsrSession` in the parent module.
//!
//! Shape: `start` returns immediately and spawns a task on tauri's async
//! runtime that owns the socket. Audio is pushed onto an unbounded channel and
//! is buffered there while the handshake is still in flight, so the first
//! phoneme after the chord completes is never lost waiting for TLS. A
//! handshake failure comes back as `AsrEvent::Failed`, not as an error from
//! `start`, because blocking the hotkey on a network round trip is exactly
//! what this design is avoiding.
//!
//! ENDPOINTING IS OFF (`endpointing=false`), deliberately, and this is the
//! single most important parameter here. The chord IS the endpoint - the same
//! argument the on-device recognizer this replaced made for itself. With
//! endpointing on, Deepgram finalizes on trailing silence, so a mid-sentence
//! pause would split one utterance in two and a short trailing word could be
//! cut off. With it off the provider never decides the utterance is over; the
//! client-sent `Finalize` after the microphone tail drain is the only thing
//! that closes it, which is what preserves the last word.
//!
//! Deepgram still settles text into `is_final` segments as it goes (that is
//! its own chunking, not endpointing), so the final transcript is the
//! concatenation of every `is_final` segment - Deepgram's documented pattern.
//! Interim text is HUD-only and is structurally incapable of reaching the
//! inserted string; see `TranscriptAccumulator` in the parent module.
//!
//! Nothing here logs a transcript, a partial, a keyterm, or the credential, at
//! any level. Counts, durations and outcomes only. The credential is
//! particularly load bearing: it lives in the URL-adjacent request headers, so
//! no code path may ever format the request, the URL, or a tungstenite error
//! that might quote them.

#![cfg(windows)]

use std::collections::BTreeSet;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;

use super::{
    AsrError, AsrEvent, AsrProvider, AsrSession, ContinuousAsrEvent,
    ContinuousAsrSession, ContinuousSessionConfig, SessionConfig, TranscriptAccumulator,
};

const ENDPOINT: &str = "wss://api.deepgram.com/v1/listen";
/// Monolingual English Nova-3. `keyterm` is Nova-3 English only, so the model
/// and the personalization mechanism have to agree; do not switch this to
/// `language=multi` without dropping the keyterms with it.
const MODEL: &str = "nova-3";
const LANGUAGE: &str = "en";
/// Stamped onto opt-in training traces so a trace can be attributed to the
/// recognizer that produced it. Not used for anything at runtime.
pub const RECOGNIZER_ID: &str = "deepgram-nova-3-en";
/// A hard ceiling on biasing terms sent per utterance. Every term is a query
/// parameter on the handshake URL, and an unbounded vocabulary would grow that
/// URL until the request itself started failing.
pub const MAX_KEYTERMS: usize = 50;
/// How long the handshake may take before the hold is failed. Generous enough
/// for a cold TLS session on a slow link, short enough that a dead network is
/// reported while the user is still holding the keys.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

/// What the session hands to the socket task. Deliberately not `Message`, so
/// the wire format stays inside `run_socket`.
enum Command {
    Audio {
        bytes: Vec<u8>,
        captured_at_ms: Option<u64>,
    },
    /// The chord came up: flush what the provider already has.
    Finalize,
    /// Give up now. No final, close the billed stream immediately.
    Close,
}

pub struct DeepgramProvider;

impl AsrProvider for DeepgramProvider {
    fn start(&self, config: SessionConfig) -> Result<Box<dyn AsrSession>, AsrError> {
        if config.credential.trim().is_empty() {
            return Err(AsrError::NotAuthenticated);
        }
        let url = build_url(&config);
        let credential = config.credential;

        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel::<Command>();
        let (event_tx, event_rx) = std::sync::mpsc::channel::<AsrEvent>();

        // tauri owns a process-wide runtime, so this is reachable from the
        // blocking dictation worker thread without it having to own one.
        tauri::async_runtime::spawn(async move {
            run_socket(url, credential, command_rx, event_tx).await;
        });

        Ok(Box::new(DeepgramSession {
            commands: command_tx,
            events: event_rx,
            terminal: None,
            finalize_sent: false,
        }))
    }

    fn start_continuous(
        &self,
        config: ContinuousSessionConfig,
    ) -> Result<Box<dyn ContinuousAsrSession>, AsrError> {
        if config.credential.trim().is_empty() {
            return Err(AsrError::NotAuthenticated);
        }
        let url = build_continuous_url(&config);
        let credential = config.credential;
        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel::<Command>();
        let (event_tx, event_rx) = std::sync::mpsc::channel::<ContinuousAsrEvent>();

        tauri::async_runtime::spawn(async move {
            run_continuous_socket(url, credential, command_rx, event_tx).await;
        });

        Ok(Box::new(DeepgramContinuousSession {
            commands: command_tx,
            events: event_rx,
            closed: false,
        }))
    }
}

/// Builds the handshake URL. Split out from `start` purely so it can be
/// asserted against without a socket.
fn build_url(config: &SessionConfig) -> String {
    let mut url = url::Url::parse(ENDPOINT).expect("the Deepgram endpoint is a valid URL");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("model", MODEL);
        query.append_pair("language", LANGUAGE);
        // Raw microphone PCM. `linear16` is signed 16-bit little-endian, which
        // is what `audio::to_i16` produces from WASAPI's f32 frames.
        query.append_pair("encoding", "linear16");
        query.append_pair("sample_rate", &config.sample_rate.to_string());
        query.append_pair("channels", "1");
        // Revisable partials for the HUD.
        query.append_pair("interim_results", "true");
        // See the module header: the chord is the endpoint.
        query.append_pair("endpointing", "false");
        // Dictation is typed into someone else's text box, so it should read
        // like written text rather than a transcript dump.
        query.append_pair("punctuate", "true");
        query.append_pair("dictation", "true");
        query.append_pair("smart_format", "true");
        // Stable low-cardinality label for Deepgram usage and billing reports.
        query.append_pair("tag", "aura-desktop-dictation");
        // Do not hold interim results back for extra context. This is a
        // latency knob for exactly this kind of interactive use.
        query.append_pair("no_delay", "true");
        for term in config.keyterms.iter().take(MAX_KEYTERMS) {
            let trimmed = term.trim();
            if !trimmed.is_empty() {
                query.append_pair("keyterm", trimmed);
            }
        }
    }
    url.into()
}

fn build_continuous_url(config: &ContinuousSessionConfig) -> String {
    let mut url = url::Url::parse(ENDPOINT).expect("the Deepgram endpoint is a valid URL");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("model", MODEL);
        query.append_pair("language", LANGUAGE);
        query.append_pair("encoding", "linear16");
        query.append_pair("sample_rate", &config.sample_rate.to_string());
        query.append_pair("channels", "1");
        query.append_pair("interim_results", "true");
        query.append_pair("endpointing", &config.endpointing_ms.to_string());
        query.append_pair("punctuate", "true");
        query.append_pair("smart_format", "true");
        query.append_pair("tag", "aura-desktop-interview");
        query.append_pair("no_delay", "true");
        if config.diarize {
            query.append_pair("diarize_model", "latest");
        }
        for term in config.keyterms.iter().take(MAX_KEYTERMS) {
            let trimmed = term.trim();
            if !trimmed.is_empty() {
                query.append_pair("keyterm", trimmed);
            }
        }
    }
    url.into()
}

struct DeepgramSession {
    commands: UnboundedSender<Command>,
    events: Receiver<AsrEvent>,
    /// The terminal event, once seen. Latched so a session can never hand out
    /// two finals, and so a `Failed` that arrived during the hold is still
    /// available to `await_final` after the chord comes up.
    terminal: Option<Result<String, AsrError>>,
    finalize_sent: bool,
}

impl DeepgramSession {
    /// Records a terminal event the first time one is seen and reports whether
    /// this event was terminal.
    fn latch(&mut self, event: &AsrEvent) -> bool {
        match event {
            AsrEvent::Partial(_) => false,
            AsrEvent::Final(text) => {
                if self.terminal.is_none() {
                    self.terminal = Some(Ok(text.clone()));
                }
                true
            }
            AsrEvent::Failed(error) => {
                if self.terminal.is_none() {
                    self.terminal = Some(Err(*error));
                }
                true
            }
        }
    }
}

impl AsrSession for DeepgramSession {
    fn send_pcm(&mut self, samples: &[i16]) -> Result<(), AsrError> {
        if samples.is_empty() {
            return Ok(());
        }
        if self.terminal.is_some() {
            // Already over. Silently drop rather than erroring: the worker's
            // tail drain can legitimately arrive after a mid-hold failure.
            return Ok(());
        }
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.commands
            .send(Command::Audio {
                bytes,
                captured_at_ms: None,
            })
            .map_err(|_| AsrError::Network)
    }

    fn poll(&mut self) -> Option<AsrEvent> {
        if self.terminal.is_some() {
            return None;
        }
        match self.events.try_recv() {
            Ok(event) => {
                self.latch(&event);
                Some(event)
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                let event = AsrEvent::Failed(AsrError::Network);
                self.latch(&event);
                Some(event)
            }
        }
    }

    fn finish(&mut self) -> Result<(), AsrError> {
        if self.terminal.is_some() || self.finalize_sent {
            return Ok(());
        }
        self.finalize_sent = true;
        self.commands
            .send(Command::Finalize)
            .map_err(|_| AsrError::Network)
    }

    fn await_final(&mut self, deadline: Instant) -> Result<String, AsrError> {
        if let Some(terminal) = self.terminal.clone() {
            return terminal;
        }
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.terminal = Some(Err(AsrError::Timeout));
                // Never leave a billed stream open on a timeout.
                let _ = self.commands.send(Command::Close);
                return Err(AsrError::Timeout);
            }
            match self.events.recv_timeout(remaining) {
                Ok(event) => {
                    if self.latch(&event) {
                        return self
                            .terminal
                            .clone()
                            .unwrap_or(Err(AsrError::Provider));
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.terminal = Some(Err(AsrError::Timeout));
                    let _ = self.commands.send(Command::Close);
                    return Err(AsrError::Timeout);
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.terminal = Some(Err(AsrError::Network));
                    return Err(AsrError::Network);
                }
            }
        }
    }

    fn cancel(&mut self) {
        let _ = self.commands.send(Command::Close);
        if self.terminal.is_none() {
            self.terminal = Some(Err(AsrError::Provider));
        }
    }
}

impl Drop for DeepgramSession {
    fn drop(&mut self) {
        // Dropping the command sender ends the socket task on its own, but say
        // so explicitly: an open stream is billed for as long as it is open.
        let _ = self.commands.send(Command::Close);
    }
}

struct DeepgramContinuousSession {
    commands: UnboundedSender<Command>,
    events: Receiver<ContinuousAsrEvent>,
    closed: bool,
}

impl ContinuousAsrSession for DeepgramContinuousSession {
    fn send_pcm(&mut self, samples: &[i16], captured_at_ms: u64) -> Result<(), AsrError> {
        if samples.is_empty() || self.closed {
            return Ok(());
        }
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.commands
            .send(Command::Audio {
                bytes,
                captured_at_ms: Some(captured_at_ms),
            })
            .map_err(|_| AsrError::Network)
    }

    fn poll(&mut self) -> Option<ContinuousAsrEvent> {
        if self.closed {
            return None;
        }
        match self.events.try_recv() {
            Ok(event) => {
                if matches!(event, ContinuousAsrEvent::Failed(_)) {
                    self.closed = true;
                }
                Some(event)
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.closed = true;
                Some(ContinuousAsrEvent::Failed(AsrError::Network))
            }
        }
    }

    fn cancel(&mut self) {
        if !self.closed {
            let _ = self.commands.send(Command::Close);
            self.closed = true;
        }
    }
}

impl Drop for DeepgramContinuousSession {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Close);
    }
}

/// rustls config with the crypto provider named explicitly. See the Cargo.toml
/// comment: this tree carries both ring and aws-lc-rs, so letting rustls pick
/// for itself is a runtime panic waiting to happen.
pub(super) fn tls_connector() -> Connector {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("ring supports the default protocol versions")
    .with_root_certificates(roots)
    .with_no_client_auth();
    Connector::Rustls(Arc::new(config))
}

/// Owns the socket for one utterance. Every exit path closes it.
async fn run_socket(
    url: String,
    credential: String,
    mut commands: UnboundedReceiver<Command>,
    events: Sender<AsrEvent>,
) {
    let started_at = Instant::now();

    let mut request = match url.into_client_request() {
        Ok(request) => request,
        Err(_) => {
            // Never format the error: it can quote the URL, which carries the
            // user's keyterms.
            let _ = events.send(AsrEvent::Failed(AsrError::Provider));
            return;
        }
    };
    // Temporary Deepgram tokens are Bearer credentials. A raw API key would be
    // `Token <key>`, and no raw key ever exists in this process.
    match HeaderValue::from_str(&format!("Bearer {credential}")) {
        Ok(mut value) => {
            value.set_sensitive(true);
            request.headers_mut().insert("Authorization", value);
        }
        Err(_) => {
            let _ = events.send(AsrEvent::Failed(AsrError::NotAuthenticated));
            return;
        }
    }
    drop(credential);

    let connected = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_tls_with_config(
            request,
            None,
            false,
            Some(tls_connector()),
        ),
    )
    .await;

    let socket = match connected {
        Ok(Ok((socket, response))) => {
            info!(
                "dictation.asr: provider=deepgram model={MODEL} phase=connect state=ready connect_ms={} status={}",
                started_at.elapsed().as_millis(),
                response.status().as_u16()
            );
            socket
        }
        Ok(Err(error)) => {
            let mapped = map_handshake_error(&error);
            warn!(
                "dictation.asr: provider=deepgram phase=connect failure={} connect_ms={}",
                mapped.category(),
                started_at.elapsed().as_millis()
            );
            let _ = events.send(AsrEvent::Failed(mapped));
            return;
        }
        Err(_) => {
            warn!("dictation.asr: provider=deepgram phase=connect failure=connect_timeout");
            let _ = events.send(AsrEvent::Failed(AsrError::Network));
            return;
        }
    };

    let (mut sink, mut stream) = socket.split();
    let mut accumulator = TranscriptAccumulator::new();
    let mut finalize_requested = false;
    let mut bytes_sent = 0usize;

    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(Command::Audio { bytes, .. }) => {
                        bytes_sent += bytes.len();
                        if sink.send(Message::Binary(bytes.into())).await.is_err() {
                            let _ = events.send(AsrEvent::Failed(AsrError::Network));
                            break;
                        }
                    }
                    Some(Command::Finalize) => {
                        finalize_requested = true;
                        if sink
                            .send(Message::Text(r#"{"type":"Finalize"}"#.into()))
                            .await
                            .is_err()
                        {
                            let _ = events.send(AsrEvent::Failed(AsrError::Network));
                            break;
                        }
                    }
                    // Both an explicit cancel and a dropped session land here.
                    Some(Command::Close) | None => {
                        let _ = sink
                            .send(Message::Text(r#"{"type":"CloseStream"}"#.into()))
                            .await;
                        break;
                    }
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(payload))) => {
                        match interpret(&payload, &mut accumulator) {
                            Interpretation::Partial => {
                                let _ = events.send(AsrEvent::Partial(accumulator.displayed()));
                            }
                            Interpretation::Final => {
                                let _ = events.send(AsrEvent::Final(accumulator.finalized()));
                                let _ = sink
                                    .send(Message::Text(r#"{"type":"CloseStream"}"#.into()))
                                    .await;
                                break;
                            }
                            Interpretation::Failed => {
                                let _ = events.send(AsrEvent::Failed(AsrError::Provider));
                                break;
                            }
                            Interpretation::Ignored => {}
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        // A close after Finalize means the provider is done and
                        // the settled segments ARE the utterance. A close before
                        // it is a dropped connection and must type nothing.
                        if finalize_requested {
                            let _ = events.send(AsrEvent::Final(accumulator.finalized()));
                        } else {
                            let _ = events.send(AsrEvent::Failed(AsrError::Network));
                        }
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => {
                        let _ = events.send(AsrEvent::Failed(AsrError::Network));
                        break;
                    }
                }
            }
        }
    }

    // Byte counts and durations only, never text.
    info!(
        "dictation.asr: provider=deepgram phase=close audio_bytes={bytes_sent} session_ms={} finalized={finalize_requested}",
        started_at.elapsed().as_millis()
    );
}

async fn run_continuous_socket(
    url: String,
    credential: String,
    mut commands: UnboundedReceiver<Command>,
    events: Sender<ContinuousAsrEvent>,
) {
    let mut request = match url.into_client_request() {
        Ok(request) => request,
        Err(_) => {
            let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Provider));
            return;
        }
    };
    match HeaderValue::from_str(&format!("Bearer {credential}")) {
        Ok(mut value) => {
            value.set_sensitive(true);
            request.headers_mut().insert("Authorization", value);
        }
        Err(_) => {
            let _ = events.send(ContinuousAsrEvent::Failed(AsrError::NotAuthenticated));
            return;
        }
    }
    drop(credential);

    let socket = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_tls_with_config(
            request,
            None,
            false,
            Some(tls_connector()),
        ),
    )
    .await
    {
        Ok(Ok((socket, response))) => {
            info!(
                "dictation.asr: provider=deepgram mode=continuous phase=connect state=ready status={}",
                response.status().as_u16()
            );
            socket
        }
        Ok(Err(error)) => {
            let failure = map_handshake_error(&error);
            let status = match &error {
                tokio_tungstenite::tungstenite::Error::Http(response) => {
                    response.status().as_u16()
                }
                _ => 0,
            };
            warn!(
                "dictation.asr: provider=deepgram mode=continuous phase=connect state=failed code={} status={status}",
                failure.category()
            );
            let _ = events.send(ContinuousAsrEvent::Failed(failure));
            return;
        }
        Err(_) => {
            warn!(
                "dictation.asr: provider=deepgram mode=continuous phase=connect state=failed code=network status=0"
            );
            let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Network));
            return;
        }
    };

    let (mut sink, mut stream) = socket.split();
    let mut accumulator = TranscriptAccumulator::new();
    let mut keepalive = tokio::time::interval(Duration::from_secs(5));
    let mut last_audio_at = Instant::now();
    let mut audio_started_at_ms = None;
    let mut turn_metadata = ContinuousTurnMetadata::default();
    keepalive.tick().await;
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(Command::Audio { bytes, captured_at_ms }) => {
                        last_audio_at = Instant::now();
                        if audio_started_at_ms.is_none() {
                            audio_started_at_ms = captured_at_ms;
                        }
                        if sink.send(Message::Binary(bytes.into())).await.is_err() {
                            let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Network));
                            break;
                        }
                    }
                    Some(Command::Close) | None => {
                        let _ = sink
                            .send(Message::Text(r#"{"type":"CloseStream"}"#.into()))
                            .await;
                        break;
                    }
                    Some(Command::Finalize) => {}
                }
            }
            _ = keepalive.tick() => {
                if last_audio_at.elapsed() < Duration::from_secs(3) {
                    continue;
                }
                if sink
                    .send(Message::Text(r#"{"type":"KeepAlive"}"#.into()))
                    .await
                    .is_err()
                {
                    let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Network));
                    break;
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(payload))) => {
                        match interpret_continuous(&payload, &mut accumulator, &mut turn_metadata) {
                            ContinuousInterpretation::Partial => {
                                let _ = events.send(ContinuousAsrEvent::Partial(
                                    turn_metadata.transcript(accumulator.displayed(), audio_started_at_ms),
                                ));
                            }
                            ContinuousInterpretation::Final => {
                                let final_text = accumulator.finalized();
                                if !final_text.is_empty() {
                                    let _ = events.send(ContinuousAsrEvent::Final(
                                        turn_metadata.transcript(final_text, audio_started_at_ms),
                                    ));
                                }
                                accumulator = TranscriptAccumulator::new();
                                turn_metadata = ContinuousTurnMetadata::default();
                            }
                            ContinuousInterpretation::Failed => {
                                let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Provider));
                                break;
                            }
                            ContinuousInterpretation::Ignored => {}
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Network));
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => {
                        let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Network));
                        break;
                    }
                }
            }
        }
    }
}

/// A handshake failure that names the credential as the cause has to be told
/// apart from a network one, because only the first is worth re-minting for.
fn map_handshake_error(error: &tokio_tungstenite::tungstenite::Error) -> AsrError {
    use tokio_tungstenite::tungstenite::Error as WsError;
    match error {
        WsError::Http(response) => {
            let status = response.status().as_u16();
            if status == 401 || status == 403 {
                AsrError::Rejected
            } else {
                AsrError::Provider
            }
        }
        WsError::Io(_) | WsError::Tls(_) => AsrError::Network,
        _ => AsrError::Provider,
    }
}

/// What one server frame meant. Kept separate from the socket loop so the
/// parsing rules are testable against literal payloads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Interpretation {
    /// The HUD should be updated.
    Partial,
    /// The utterance is over; the accumulator holds the final text.
    Final,
    /// The provider reported a failure.
    Failed,
    /// Metadata and everything else the dictation path has no use for.
    Ignored,
}

#[derive(serde::Deserialize)]
struct Alternative {
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    words: Vec<Word>,
}

#[derive(serde::Deserialize)]
struct Word {
    #[serde(default)]
    end: Option<f64>,
    #[serde(default)]
    speaker: Option<u32>,
}

#[derive(serde::Deserialize)]
struct Channel {
    #[serde(default)]
    alternatives: Vec<Alternative>,
}

#[derive(serde::Deserialize)]
struct ServerFrame {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    channel: Option<Channel>,
    #[serde(default)]
    is_final: bool,
    /// True on the Results frame produced in answer to `Finalize`. That frame,
    /// and nothing else, ends the utterance.
    #[serde(default)]
    from_finalize: bool,
    /// Provider endpointing marks a completed spoken turn with this field.
    /// Dictation ignores it; the continuous interview path consumes it.
    #[serde(default)]
    speech_final: bool,
}

fn interpret(payload: &str, accumulator: &mut TranscriptAccumulator) -> Interpretation {
    let Ok(frame) = serde_json::from_str::<ServerFrame>(payload) else {
        // An unparseable frame is not fatal on its own; the utterance is still
        // ended by Finalize or by the socket closing.
        return Interpretation::Ignored;
    };
    match frame.kind.as_str() {
        "Results" => {
            let transcript = frame
                .channel
                .as_ref()
                .and_then(|channel| channel.alternatives.first())
                .map(|alternative| alternative.transcript.as_str())
                .unwrap_or("");
            if frame.is_final {
                accumulator.push_settled(transcript);
            } else {
                accumulator.push_interim(transcript);
            }
            if frame.from_finalize {
                Interpretation::Final
            } else {
                Interpretation::Partial
            }
        }
        "Error" => Interpretation::Failed,
        _ => Interpretation::Ignored,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ContinuousInterpretation {
    Partial,
    Final,
    Failed,
    Ignored,
}

#[derive(Default)]
struct ContinuousTurnMetadata {
    speakers: BTreeSet<u32>,
    latest_word_end_s: Option<f64>,
}

impl ContinuousTurnMetadata {
    fn include(&mut self, alternative: &Alternative) {
        for word in &alternative.words {
            if let Some(speaker) = word.speaker {
                self.speakers.insert(speaker);
            }
            if let Some(end) = word.end.filter(|end| end.is_finite() && *end >= 0.0) {
                self.latest_word_end_s = Some(
                    self.latest_word_end_s
                        .map_or(end, |current| current.max(end)),
                );
            }
        }
    }

    fn transcript(
        &self,
        text: String,
        audio_started_at_ms: Option<u64>,
    ) -> super::ContinuousTranscript {
        let speaker_overlap = self.speakers.len() > 1;
        let speaker_id = if speaker_overlap {
            None
        } else {
            self.speakers.iter().next().copied()
        };
        let final_word_at_ms = audio_started_at_ms.zip(self.latest_word_end_s).map(
            |(started_at_ms, end_s)| {
                started_at_ms.saturating_add((end_s * 1_000.0).round() as u64)
            },
        );
        super::ContinuousTranscript {
            text,
            speaker_id,
            speaker_overlap,
            final_word_at_ms,
        }
    }
}

fn interpret_continuous(
    payload: &str,
    accumulator: &mut TranscriptAccumulator,
    metadata: &mut ContinuousTurnMetadata,
) -> ContinuousInterpretation {
    let Ok(frame) = serde_json::from_str::<ServerFrame>(payload) else {
        return ContinuousInterpretation::Ignored;
    };
    match frame.kind.as_str() {
        "Results" => {
            let alternative = frame
                .channel
                .as_ref()
                .and_then(|channel| channel.alternatives.first());
            let transcript = alternative
                .map(|alternative| alternative.transcript.as_str())
                .unwrap_or("");
            if frame.is_final || frame.speech_final {
                accumulator.push_settled(transcript);
                if let Some(alternative) = alternative {
                    metadata.include(alternative);
                }
            } else {
                accumulator.push_interim(transcript);
            }
            if frame.speech_final {
                ContinuousInterpretation::Final
            } else {
                ContinuousInterpretation::Partial
            }
        }
        "Error" => ContinuousInterpretation::Failed,
        _ => ContinuousInterpretation::Ignored,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(keyterms: Vec<&str>) -> SessionConfig {
        SessionConfig {
            sample_rate: super::super::SAMPLE_RATE,
            keyterms: keyterms.into_iter().map(str::to_string).collect(),
            credential: "test-token".to_string(),
        }
    }

    #[test]
    fn the_url_carries_every_parameter_the_dictation_path_depends_on() {
        let url = build_url(&config(vec![]));
        assert!(url.starts_with("wss://api.deepgram.com/v1/listen?"));
        for expected in [
            "model=nova-3",
            "language=en",
            "encoding=linear16",
            "sample_rate=16000",
            "channels=1",
            "interim_results=true",
            "punctuate=true",
            "smart_format=true",
            "no_delay=true",
        ] {
            assert!(url.contains(expected), "missing {expected} in {url}");
        }
    }

    #[test]
    fn endpointing_is_off_so_the_provider_can_never_end_the_utterance_early() {
        // The last-word guarantee depends on this exact parameter. If it ever
        // flips to a duration, a trailing short word can be cut off.
        let url = build_url(&config(vec![]));
        assert!(url.contains("endpointing=false"), "{url}");
    }

    #[test]
    fn keyterms_are_repeated_and_percent_encoded() {
        let url = build_url(&config(vec!["Aura", "Buddy", "Varun Tej"]));
        assert!(url.contains("keyterm=Aura"));
        assert!(url.contains("keyterm=Buddy"));
        // A space must not break the query string.
        assert!(url.contains("keyterm=Varun+Tej") || url.contains("keyterm=Varun%20Tej"));
        assert!(!url.contains("keyterm=Varun Tej"));
    }

    #[test]
    fn blank_keyterms_are_dropped_and_the_list_is_capped() {
        let mut terms: Vec<String> = (0..MAX_KEYTERMS + 20).map(|i| format!("term{i}")).collect();
        terms.push("   ".to_string());
        let url = build_url(&SessionConfig {
            sample_rate: super::super::SAMPLE_RATE,
            keyterms: terms,
            credential: "test-token".to_string(),
        });
        assert_eq!(url.matches("keyterm=").count(), MAX_KEYTERMS);
    }

    #[test]
    fn an_empty_credential_is_refused_before_any_socket_is_opened() {
        let outcome = DeepgramProvider.start(SessionConfig {
            sample_rate: super::super::SAMPLE_RATE,
            keyterms: Vec::new(),
            credential: "   ".to_string(),
        });
        assert!(matches!(outcome.err(), Some(AsrError::NotAuthenticated)));
    }

    // ------------------------------------------------------------------
    // Frame interpretation.
    // ------------------------------------------------------------------

    fn results(transcript: &str, is_final: bool, from_finalize: bool) -> String {
        format!(
            r#"{{"type":"Results","channel":{{"alternatives":[{{"transcript":"{transcript}"}}]}},"is_final":{is_final},"from_finalize":{from_finalize}}}"#
        )
    }

    #[test]
    fn interim_frames_update_the_display_but_not_the_final() {
        let mut acc = TranscriptAccumulator::new();
        assert_eq!(
            interpret(&results("send the", false, false), &mut acc),
            Interpretation::Partial
        );
        assert_eq!(acc.displayed(), "send the");
        assert_eq!(acc.finalized(), "");
    }

    #[test]
    fn settled_frames_accumulate_across_a_long_utterance() {
        let mut acc = TranscriptAccumulator::new();
        interpret(&results("send the invoice", true, false), &mut acc);
        interpret(&results("to accounts", false, false), &mut acc);
        interpret(&results("to accounting", true, false), &mut acc);
        assert_eq!(acc.finalized(), "send the invoice to accounting");
    }

    #[test]
    fn only_a_from_finalize_frame_ends_the_utterance() {
        let mut acc = TranscriptAccumulator::new();
        assert_eq!(
            interpret(&results("first", true, false), &mut acc),
            Interpretation::Partial
        );
        assert_eq!(
            interpret(&results("second", true, true), &mut acc),
            Interpretation::Final
        );
        assert_eq!(acc.finalized(), "first second");
    }

    #[test]
    fn a_whole_utterance_reads_correctly_frame_by_frame() {
        // The realistic shape of one hold: metadata, interim revisions, a
        // settled segment mid-sentence, more interims, then the Finalize
        // answer. Asserts what is on screen AND what is typable at each step,
        // because the gap between those two is the entire safety property.
        let mut acc = TranscriptAccumulator::new();

        interpret(r#"{"type":"Metadata","request_id":"abc"}"#, &mut acc);
        assert_eq!(acc.displayed(), "");

        interpret(&results("send", false, false), &mut acc);
        interpret(&results("send the in", false, false), &mut acc);
        assert_eq!(acc.displayed(), "send the in");
        assert_eq!(acc.finalized(), "", "nothing is typable mid-word");

        interpret(&results("Send the invoice", true, false), &mut acc);
        assert_eq!(acc.finalized(), "Send the invoice");

        interpret(&results("to accou", false, false), &mut acc);
        assert_eq!(acc.displayed(), "Send the invoice to accou");
        assert_eq!(
            acc.finalized(),
            "Send the invoice",
            "a half-typed word must never become typable"
        );

        // The user releases the chord here; the client sends Finalize and the
        // provider answers with the rest.
        assert_eq!(
            interpret(&results("to accounting.", true, true), &mut acc),
            Interpretation::Final
        );
        assert_eq!(acc.finalized(), "Send the invoice to accounting.");
    }

    #[test]
    fn a_provider_error_frame_is_terminal() {
        let mut acc = TranscriptAccumulator::new();
        assert_eq!(
            interpret(r#"{"type":"Error","description":"whatever"}"#, &mut acc),
            Interpretation::Failed
        );
    }

    #[test]
    fn metadata_and_unparseable_frames_are_ignored_rather_than_fatal() {
        let mut acc = TranscriptAccumulator::new();
        assert_eq!(
            interpret(r#"{"type":"Metadata","request_id":"abc"}"#, &mut acc),
            Interpretation::Ignored
        );
        assert_eq!(interpret("not json at all", &mut acc), Interpretation::Ignored);
        assert_eq!(
            interpret(r#"{"type":"UtteranceEnd","last_word_end":1.0}"#, &mut acc),
            Interpretation::Ignored
        );
        assert_eq!(acc.finalized(), "");
    }

    #[test]
    fn a_results_frame_with_no_alternatives_does_not_panic() {
        let mut acc = TranscriptAccumulator::new();
        assert_eq!(
            interpret(r#"{"type":"Results","is_final":true}"#, &mut acc),
            Interpretation::Partial
        );
        assert_eq!(acc.finalized(), "");
    }

    #[test]
    fn an_empty_finalize_frame_still_ends_the_utterance_with_the_settled_text() {
        let mut acc = TranscriptAccumulator::new();
        interpret(&results("the whole sentence", true, false), &mut acc);
        assert_eq!(
            interpret(&results("", true, true), &mut acc),
            Interpretation::Final
        );
        assert_eq!(acc.finalized(), "the whole sentence");
    }

    // ------------------------------------------------------------------
    // Session state machine, exercised without a socket by driving the
    // channels the socket task would otherwise own.
    // ------------------------------------------------------------------

    fn session() -> (
        DeepgramSession,
        UnboundedReceiver<Command>,
        Sender<AsrEvent>,
    ) {
        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel::<Command>();
        let (event_tx, event_rx) = std::sync::mpsc::channel::<AsrEvent>();
        (
            DeepgramSession {
                commands: command_tx,
                events: event_rx,
                terminal: None,
                finalize_sent: false,
            },
            command_rx,
            event_tx,
        )
    }

    #[test]
    fn pcm_is_encoded_as_signed_little_endian_16_bit() {
        let (mut session, mut commands, _events) = session();
        session.send_pcm(&[1i16, -2i16]).unwrap();
        match commands.try_recv() {
            Ok(Command::Audio { bytes, .. }) => {
                assert_eq!(bytes, vec![0x01, 0x00, 0xFE, 0xFF]);
            }
            _ => panic!("expected an audio frame"),
        }
    }

    #[test]
    fn a_terminal_event_is_latched_so_a_second_final_can_never_be_handed_out() {
        let (mut session, _commands, events) = session();
        events.send(AsrEvent::Final("done".into())).unwrap();
        assert_eq!(session.poll(), Some(AsrEvent::Final("done".into())));
        // A late duplicate from the socket task must not be observable.
        events.send(AsrEvent::Final("done again".into())).unwrap();
        assert_eq!(session.poll(), None);
        assert_eq!(
            session.await_final(Instant::now() + Duration::from_secs(1)),
            Ok("done".to_string())
        );
    }

    #[test]
    fn a_failure_during_the_hold_is_still_returned_after_the_chord_comes_up() {
        let (mut session, _commands, events) = session();
        events.send(AsrEvent::Failed(AsrError::Network)).unwrap();
        assert_eq!(session.poll(), Some(AsrEvent::Failed(AsrError::Network)));
        session.finish().unwrap();
        assert_eq!(
            session.await_final(Instant::now() + Duration::from_secs(1)),
            Err(AsrError::Network)
        );
    }

    #[test]
    fn finish_sends_finalize_exactly_once() {
        let (mut session, mut commands, _events) = session();
        session.finish().unwrap();
        session.finish().unwrap();
        assert!(matches!(commands.try_recv(), Ok(Command::Finalize)));
        assert!(commands.try_recv().is_err(), "Finalize must not repeat");
    }

    #[test]
    fn a_missing_final_times_out_and_closes_the_billed_stream() {
        let (mut session, mut commands, _events) = session();
        session.finish().unwrap();
        assert!(matches!(commands.try_recv(), Ok(Command::Finalize)));
        assert_eq!(
            session.await_final(Instant::now() + Duration::from_millis(20)),
            Err(AsrError::Timeout)
        );
        assert!(
            matches!(commands.try_recv(), Ok(Command::Close)),
            "a timed-out stream must be closed, not left billing"
        );
    }

    #[test]
    fn cancel_closes_the_stream_and_yields_no_final() {
        let (mut session, mut commands, events) = session();
        session.cancel();
        assert!(matches!(commands.try_recv(), Ok(Command::Close)));
        // Anything the socket task said afterwards is not observable.
        events.send(AsrEvent::Final("too late".into())).unwrap();
        assert_eq!(session.poll(), None);
        assert!(session
            .await_final(Instant::now() + Duration::from_millis(20))
            .is_err());
    }

    #[test]
    fn a_dead_socket_task_reports_network_rather_than_hanging() {
        let (mut session, commands, events) = session();
        drop(events);
        drop(commands);
        assert_eq!(session.poll(), Some(AsrEvent::Failed(AsrError::Network)));
    }

    #[test]
    fn audio_after_a_terminal_event_is_dropped_instead_of_erroring() {
        let (mut session, _commands, events) = session();
        events.send(AsrEvent::Failed(AsrError::Network)).unwrap();
        session.poll();
        // The worker's tail drain runs after a mid-hold failure; it must not
        // turn into a second, different error.
        assert_eq!(session.send_pcm(&[0i16; 160]), Ok(()));
    }

    #[test]
    fn handshake_status_codes_map_to_actionable_errors() {
        use tokio_tungstenite::tungstenite::http::Response;
        use tokio_tungstenite::tungstenite::Error as WsError;

        let http = |status: u16| {
            WsError::Http(Box::new(
                Response::builder().status(status).body(None).unwrap(),
            ))
        };
        assert_eq!(map_handshake_error(&http(401)), AsrError::Rejected);
        assert_eq!(map_handshake_error(&http(403)), AsrError::Rejected);
        assert_eq!(map_handshake_error(&http(502)), AsrError::Provider);

        let io = WsError::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert_eq!(map_handshake_error(&io), AsrError::Network);
    }
}
