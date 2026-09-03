//! OpenAI Realtime transcription fallback for Interview Companion.
//!
//! This provider is continuous-only. Dictation remains Deepgram-primary and
//! cannot reach this implementation through `asr::provider()`.


use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use serde::Deserialize;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use super::{
    AsrError, AsrProvider, AsrSession, ContinuousAsrEvent, ContinuousAsrSession,
    ContinuousSessionConfig, ContinuousTranscript, SessionConfig,
};

const ENDPOINT: &str = "wss://api.openai.com/v1/realtime?model=gpt-live-transcribe";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

enum Command {
    Audio { bytes: Vec<u8> },
    Close,
}

pub struct OpenAiProvider;

impl AsrProvider for OpenAiProvider {
    fn start(&self, _config: SessionConfig) -> Result<Box<dyn AsrSession>, AsrError> {
        Err(AsrError::Provider)
    }

    fn start_continuous(
        &self,
        config: ContinuousSessionConfig,
    ) -> Result<Box<dyn ContinuousAsrSession>, AsrError> {
        if config.credential.trim().is_empty() {
            return Err(AsrError::NotAuthenticated);
        }
        let credential = config.credential;
        let endpointing_ms = config.endpointing_ms;
        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel::<Command>();
        let (event_tx, event_rx) = std::sync::mpsc::channel::<ContinuousAsrEvent>();

        tauri::async_runtime::spawn(async move {
            run_socket(credential, endpointing_ms, command_rx, event_tx).await;
        });

        Ok(Box::new(OpenAiContinuousSession {
            commands: command_tx,
            events: event_rx,
            resampler: PcmResampler::default(),
            closed: false,
        }))
    }
}

struct OpenAiContinuousSession {
    commands: UnboundedSender<Command>,
    events: Receiver<ContinuousAsrEvent>,
    resampler: PcmResampler,
    closed: bool,
}

impl ContinuousAsrSession for OpenAiContinuousSession {
    fn send_pcm(&mut self, samples: &[i16], _captured_at_ms: u64) -> Result<(), AsrError> {
        if samples.is_empty() || self.closed {
            return Ok(());
        }
        let resampled = self.resampler.resample(samples);
        let mut bytes = Vec::with_capacity(resampled.len() * 2);
        for sample in resampled {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.commands
            .send(Command::Audio { bytes })
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

impl Drop for OpenAiContinuousSession {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Default)]
struct PcmResampler {
    previous: Option<i16>,
    input_index: u64,
    next_output_numerator: u64,
}

impl PcmResampler {
    fn resample(&mut self, samples: &[i16]) -> Vec<i16> {
        let mut output = Vec::with_capacity(samples.len() * 3 / 2 + 2);
        let mut offset = 0;
        if self.previous.is_none() {
            self.previous = samples.first().copied();
            offset = 1;
        }
        for &current in &samples[offset..] {
            let previous = self.previous.unwrap_or(current);
            let interval_start = self.input_index * 3;
            let interval_end = interval_start + 3;
            while self.next_output_numerator < interval_end {
                let fraction = (self.next_output_numerator - interval_start) as i32;
                let interpolated = previous as i32
                    + ((current as i32 - previous as i32) * fraction + 1) / 3;
                output.push(interpolated.clamp(i16::MIN as i32, i16::MAX as i32) as i16);
                self.next_output_numerator += 2;
            }
            self.previous = Some(current);
            self.input_index += 1;
        }
        output
    }
}

#[derive(Deserialize)]
struct ServerEvent {
    #[serde(rename = "type")]
    kind: String,
    item_id: Option<String>,
    delta: Option<String>,
    transcript: Option<String>,
}

fn transcript(text: String) -> ContinuousTranscript {
    ContinuousTranscript {
        text,
        speaker_id: None,
        speaker_overlap: false,
        final_word_at_ms: None,
    }
}

async fn run_socket(
    credential: String,
    endpointing_ms: u16,
    mut commands: UnboundedReceiver<Command>,
    events: Sender<ContinuousAsrEvent>,
) {
    let mut request = match ENDPOINT.into_client_request() {
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
            Some(super::deepgram::tls_connector()),
        ),
    )
    .await
    {
        Ok(Ok((socket, response))) => {
            info!(
                "dictation.asr: provider=openai mode=continuous phase=connect state=ready status={}",
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
                "dictation.asr: provider=openai mode=continuous phase=connect state=failed code={} status={status}",
                failure.category()
            );
            let _ = events.send(ContinuousAsrEvent::Failed(failure));
            return;
        }
        Err(_) => {
            let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Network));
            return;
        }
    };

    let (mut sink, mut stream) = socket.split();
    let session_update = serde_json::json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": 24000 },
                    "transcription": { "model": "gpt-live-transcribe", "delay": "low" },
                    "turn_detection": {
                        "type": "server_vad",
                        "silence_duration_ms": endpointing_ms
                    }
                }
            }
        }
    });
    if sink
        .send(Message::Text(session_update.to_string().into()))
        .await
        .is_err()
    {
        let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Network));
        return;
    }

    let mut partials = HashMap::<String, String>::new();
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(Command::Audio { bytes }) => {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                        let payload = serde_json::json!({
                            "type": "input_audio_buffer.append",
                            "audio": encoded,
                        });
                        if sink.send(Message::Text(payload.to_string().into())).await.is_err() {
                            let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Network));
                            break;
                        }
                    }
                    Some(Command::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(payload))) => {
                        let Ok(event) = serde_json::from_str::<ServerEvent>(&payload) else {
                            continue;
                        };
                        match event.kind.as_str() {
                            "conversation.item.input_audio_transcription.delta" => {
                                let (Some(item_id), Some(delta)) = (event.item_id, event.delta) else {
                                    continue;
                                };
                                let partial = partials.entry(item_id).or_default();
                                partial.push_str(&delta);
                                if !partial.trim().is_empty() {
                                    let _ = events.send(ContinuousAsrEvent::Partial(
                                        transcript(partial.clone()),
                                    ));
                                }
                            }
                            "conversation.item.input_audio_transcription.completed" => {
                                let Some(item_id) = event.item_id else {
                                    continue;
                                };
                                partials.remove(&item_id);
                                let final_text = event.transcript.unwrap_or_default();
                                if !final_text.trim().is_empty() {
                                    let _ = events.send(ContinuousAsrEvent::Final(
                                        transcript(final_text),
                                    ));
                                }
                            }
                            "error" => {
                                let _ = events.send(ContinuousAsrEvent::Failed(AsrError::Provider));
                                break;
                            }
                            _ => {}
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

fn map_handshake_error(error: &tokio_tungstenite::tungstenite::Error) -> AsrError {
    use tokio_tungstenite::tungstenite::Error as WsError;
    match error {
        WsError::Http(response) => match response.status().as_u16() {
            401 | 403 => AsrError::Rejected,
            _ => AsrError::Provider,
        },
        WsError::Io(_) | WsError::Tls(_) => AsrError::Network,
        _ => AsrError::Provider,
    }
}
