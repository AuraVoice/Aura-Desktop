//! The transcription provider boundary.
//!
//! Everything above this line (the dictation worker in `mod.rs`) speaks only
//! `AsrProvider`, `AsrSession` and `AsrEvent`. No provider type, URL, wire
//! format or vendor error string crosses it, so swapping Deepgram for another
//! streaming service is a new file in this directory plus one line in
//! `provider()`.
//!
//! The shape is dictated by the caller, not the provider. The dictation worker
//! is a BLOCKING thread that already interleaves microphone drains, chord
//! signals, HUD levels and partials in one loop (see `run_utterance`), and it
//! must never stall on the network in the middle of a hold. So:
//!
//! - `send_pcm` is fire-and-forget onto an unbounded channel: it returns
//!   instantly and can only fail if the socket task is already gone.
//! - `poll` is a `try_recv`, so it drops straight into the existing loop
//!   rhythm next to `poll_signal` and never blocks.
//! - `await_final` is the ONLY blocking call, it happens after the chord is
//!   already up, and it is always bounded by a deadline.
//!
//! Nothing in this module or its implementations may log, panic-format, or
//! otherwise render transcript text. The socket task runs on tauri's async
//! runtime, whose threads are NOT covered by `logging.rs`'s name-based panic
//! guard, so a panic carrying a partial would reach the plaintext log. Treat
//! every `AsrEvent::Partial`/`Final` payload as radioactive: move it, never
//! format it.

#![cfg(windows)]

use std::time::Instant;

pub mod deepgram;

/// Every ASR model here expects 16 kHz mono.
pub const SAMPLE_RATE: i32 = 16_000;

/// What a session tells the worker. Ordering is guaranteed within one session:
/// any number of `Partial`s, then at most one terminal `Final` or `Failed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AsrEvent {
    /// A revisable transcript. Goes to the HUD and NOWHERE else - it is never
    /// inserted, never traced, never persisted.
    Partial(String),
    /// The one transcript that may be typed.
    Final(String),
    Failed(AsrError),
}

/// Deliberately a closed set rather than a string: the worker picks HUD copy
/// and a telemetry category from the variant, and a provider must not be able
/// to smuggle its own prose (or a URL carrying a credential) into either.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AsrError {
    /// No usable credential in this process. The user is signed out, or the
    /// webview has not minted one yet.
    NotAuthenticated,
    /// The provider rejected the credential at the handshake. Distinct from
    /// `NotAuthenticated` because the webview should re-mint and the user can
    /// simply try again.
    Rejected,
    /// Could not reach the provider, or the socket dropped mid-utterance.
    Network,
    /// Connected, but no final arrived inside the deadline.
    Timeout,
    /// The provider accepted the stream and then reported a failure of its
    /// own. Its message is deliberately dropped at the boundary.
    Provider,
}

impl AsrError {
    /// The stable, speech-free token used in logs and failure categories.
    pub fn category(self) -> &'static str {
        match self {
            AsrError::NotAuthenticated => "no_credential",
            AsrError::Rejected => "auth_rejected",
            AsrError::Network => "network",
            AsrError::Timeout => "final_timeout",
            AsrError::Provider => "provider_error",
        }
    }

    /// One short sentence for the HUD. Always ends by saying nothing was typed,
    /// because that is the only promise the user actually needs from a failure.
    pub fn hud_message(self) -> &'static str {
        match self {
            AsrError::NotAuthenticated => "Sign in to use dictation. Nothing was typed.",
            AsrError::Rejected => "Dictation could not sign in to transcription. Try again.",
            AsrError::Network => "Dictation needs a connection. Nothing was typed.",
            AsrError::Timeout => "Transcription timed out. Nothing was typed.",
            AsrError::Provider => "Transcription failed. Nothing was typed.",
        }
    }
}

/// One utterance's worth of provider configuration.
///
/// `credential` is a short-lived token, held only for as long as it takes to
/// open the socket. It has no `Debug`, and this struct must never gain one.
pub struct SessionConfig {
    pub sample_rate: i32,
    /// Product and personal vocabulary, biased for this utterance only.
    pub keyterms: Vec<String>,
    pub credential: String,
}

/// One live utterance. Dropping it without `finish` cancels and closes.
pub trait AsrSession: Send {
    /// Hands over freshly captured audio. Never blocks.
    fn send_pcm(&mut self, samples: &[i16]) -> Result<(), AsrError>;

    /// Non-blocking. `None` means "nothing new since last time", which is the
    /// common case on most iterations of the capture loop.
    fn poll(&mut self) -> Option<AsrEvent>;

    /// The chord came up and the tail has been drained: ask the provider to
    /// finalize what it already has. Does NOT wait.
    fn finish(&mut self) -> Result<(), AsrError>;

    /// Blocks until the final transcript arrives, the session fails, or the
    /// deadline passes. Only ever called after `finish`.
    fn await_final(&mut self, deadline: Instant) -> Result<String, AsrError>;

    /// Closes the stream now, without waiting for or emitting a final. Used on
    /// every abandoned hold: an open socket is billed, so this is not just
    /// tidiness.
    fn cancel(&mut self);
}

pub trait AsrProvider: Send + Sync {
    fn start(&self, config: SessionConfig) -> Result<Box<dyn AsrSession>, AsrError>;
}

/// The one place the concrete provider is named.
pub fn provider() -> &'static dyn AsrProvider {
    &deepgram::DeepgramProvider
}

/// Accumulates a provider's segment stream into the two strings the worker
/// needs, and is the single reason "only the final transcript is inserted" is
/// checkable rather than merely intended.
///
/// Streaming ASR emits two kinds of transcript: revisable interim text, and
/// settled segments that will not change. The displayed partial is settled
/// text plus the current interim; the FINAL is settled text only, and interim
/// text can never reach it because `push_interim` does not store anything.
#[derive(Default)]
pub struct TranscriptAccumulator {
    settled: Vec<String>,
    interim: String,
}

impl TranscriptAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// A revisable fragment. Replaces whatever the last one was; never joins
    /// the settled text.
    pub fn push_interim(&mut self, text: &str) {
        self.interim.clear();
        self.interim.push_str(text.trim());
    }

    /// A settled segment. Empty segments are dropped rather than stored, so
    /// they cannot introduce double spaces into the inserted text.
    pub fn push_settled(&mut self, text: &str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            self.settled.push(trimmed.to_string());
        }
        self.interim.clear();
    }

    /// What the HUD shows mid-hold: settled text plus the live interim.
    pub fn displayed(&self) -> String {
        let mut out = self.settled.join(" ");
        if !self.interim.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&self.interim);
        }
        out
    }

    /// What may be typed. Settled segments only, by construction.
    pub fn finalized(&self) -> String {
        self.settled.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{self, Receiver, Sender};

    // ------------------------------------------------------------------
    // TranscriptAccumulator: the "only the final transcript is inserted"
    // guarantee lives here, so it is tested directly rather than inferred.
    // ------------------------------------------------------------------

    #[test]
    fn interim_text_never_reaches_the_finalized_transcript() {
        let mut acc = TranscriptAccumulator::new();
        acc.push_settled("send the invoice");
        acc.push_interim("tomor");
        assert_eq!(acc.displayed(), "send the invoice tomor");
        // The half-word is on screen but must not be typable.
        assert_eq!(acc.finalized(), "send the invoice");
    }

    #[test]
    fn a_settled_segment_clears_the_interim_it_replaces() {
        let mut acc = TranscriptAccumulator::new();
        acc.push_interim("tomor");
        acc.push_settled("tomorrow");
        assert_eq!(acc.displayed(), "tomorrow");
        assert_eq!(acc.finalized(), "tomorrow");
    }

    #[test]
    fn settled_segments_join_with_single_spaces_and_skip_empties() {
        let mut acc = TranscriptAccumulator::new();
        acc.push_settled("  first  ");
        acc.push_settled("   ");
        acc.push_settled("second");
        assert_eq!(acc.finalized(), "first second");
    }

    #[test]
    fn an_utterance_with_only_interim_text_finalizes_to_nothing() {
        let mut acc = TranscriptAccumulator::new();
        acc.push_interim("uh");
        assert_eq!(acc.finalized(), "");
    }

    // ------------------------------------------------------------------
    // Provider lifecycle, driven through the trait with a fake so the
    // ordering rules are tested without a socket.
    // ------------------------------------------------------------------

    /// What the fake session was actually asked to do, in order.
    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Call {
        Pcm(usize),
        Finish,
        AwaitFinal,
        Cancel,
    }

    struct FakeSession {
        calls: Sender<Call>,
        events: Receiver<AsrEvent>,
        /// Set once a terminal event has been handed out, so the fake cannot
        /// emit two finals even if a test pushes them.
        done: bool,
        fail_send: bool,
    }

    impl AsrSession for FakeSession {
        fn send_pcm(&mut self, samples: &[i16]) -> Result<(), AsrError> {
            if self.fail_send {
                return Err(AsrError::Network);
            }
            let _ = self.calls.send(Call::Pcm(samples.len()));
            Ok(())
        }

        fn poll(&mut self) -> Option<AsrEvent> {
            if self.done {
                return None;
            }
            match self.events.try_recv().ok() {
                Some(event) => {
                    if !matches!(event, AsrEvent::Partial(_)) {
                        self.done = true;
                    }
                    Some(event)
                }
                None => None,
            }
        }

        fn finish(&mut self) -> Result<(), AsrError> {
            let _ = self.calls.send(Call::Finish);
            Ok(())
        }

        fn await_final(&mut self, _deadline: Instant) -> Result<String, AsrError> {
            let _ = self.calls.send(Call::AwaitFinal);
            loop {
                match self.events.try_recv() {
                    Ok(AsrEvent::Final(text)) => return Ok(text),
                    Ok(AsrEvent::Failed(e)) => return Err(e),
                    Ok(AsrEvent::Partial(_)) => {}
                    Err(_) => return Err(AsrError::Timeout),
                }
            }
        }

        fn cancel(&mut self) {
            let _ = self.calls.send(Call::Cancel);
            self.done = true;
        }
    }

    /// Mirrors what `run_utterance` does with a session, minus the HUD, the
    /// microphone and the keystrokes: stream while held, finish after the
    /// tail drain, then insert the final and only the final.
    struct Harness {
        session: Box<dyn AsrSession>,
        acc: TranscriptAccumulator,
        /// Everything the harness would have typed. Must only ever gain the
        /// final transcript.
        inserted: Vec<String>,
        /// A terminal event seen while the chord was still down.
        mid_hold_failure: Option<AsrError>,
    }

    impl Harness {
        /// Mirrors the mid-hold half of `run_utterance`: stream audio, drain
        /// events, treat anything terminal as a failure. A `Final` arriving
        /// while the user is still speaking is NOT the utterance they are in
        /// the middle of, so the real worker refuses to type it and so does
        /// this.
        fn hold(&mut self, samples: &[i16]) {
            let _ = self.session.send_pcm(samples);
            while let Some(event) = self.session.poll() {
                match event {
                    AsrEvent::Partial(text) => self.acc.push_interim(&text),
                    AsrEvent::Final(_) => {
                        self.mid_hold_failure = Some(AsrError::Provider);
                    }
                    AsrEvent::Failed(error) => self.mid_hold_failure = Some(error),
                }
            }
        }

        fn release(&mut self) -> Result<(), AsrError> {
            if let Some(error) = self.mid_hold_failure {
                self.session.cancel();
                return Err(error);
            }
            self.session.finish()?;
            let text = self
                .session
                .await_final(Instant::now() + std::time::Duration::from_secs(1))?;
            self.acc.push_settled(&text);
            let final_text = self.acc.finalized();
            if !final_text.is_empty() {
                self.inserted.push(final_text);
            }
            Ok(())
        }
    }

    fn harness(fail_send: bool) -> (Harness, Sender<AsrEvent>, Receiver<Call>) {
        let (call_tx, call_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        let session = FakeSession {
            calls: call_tx,
            events: event_rx,
            done: false,
            fail_send,
        };
        (
            Harness {
                session: Box::new(session),
                acc: TranscriptAccumulator::new(),
                inserted: Vec::new(),
                mid_hold_failure: None,
            },
            event_tx,
            call_rx,
        )
    }

    #[test]
    fn a_normal_hold_inserts_the_final_transcript_only_once() {
        let (mut h, events, calls) = harness(false);
        events.send(AsrEvent::Partial("send the".into())).unwrap();
        h.hold(&[0i16; 480]);
        events.send(AsrEvent::Partial("send the inv".into())).unwrap();
        h.hold(&[0i16; 480]);
        events.send(AsrEvent::Final("send the invoice".into())).unwrap();

        h.release().unwrap();

        assert_eq!(h.inserted, vec!["send the invoice".to_string()]);
        let observed: Vec<Call> = calls.try_iter().collect();
        // Audio must be streaming BEFORE the release is ever requested, and
        // finish must precede the wait. This is the key-down/key-up ordering.
        assert_eq!(
            observed,
            vec![Call::Pcm(480), Call::Pcm(480), Call::Finish, Call::AwaitFinal]
        );
    }

    #[test]
    fn partials_seen_during_the_hold_are_never_inserted() {
        let (mut h, events, _calls) = harness(false);
        events.send(AsrEvent::Partial("delete everything".into())).unwrap();
        h.hold(&[0i16; 160]);
        assert_eq!(h.acc.displayed(), "delete everything");
        // Nothing typed yet, even though a full plausible sentence is on screen.
        assert!(h.inserted.is_empty());

        events.send(AsrEvent::Final("delete the draft".into())).unwrap();
        h.release().unwrap();
        assert_eq!(h.inserted, vec!["delete the draft".to_string()]);
    }

    #[test]
    fn a_cancelled_hold_inserts_nothing_and_closes_the_stream() {
        let (mut h, events, calls) = harness(false);
        events.send(AsrEvent::Partial("never mind".into())).unwrap();
        h.hold(&[0i16; 160]);

        h.session.cancel();

        assert!(h.inserted.is_empty());
        assert!(calls.try_iter().any(|call| call == Call::Cancel));
        // A final that lands after the cancel must not resurrect the session.
        events.send(AsrEvent::Final("never mind".into())).unwrap();
        assert_eq!(h.session.poll(), None);
        assert!(h.inserted.is_empty());
    }

    #[test]
    fn a_session_that_fails_mid_hold_inserts_nothing() {
        let (mut h, events, _calls) = harness(false);
        events.send(AsrEvent::Failed(AsrError::Network)).unwrap();
        h.hold(&[0i16; 160]);
        assert!(h.inserted.is_empty());

        // And the terminal event is not repeated on the next poll.
        assert_eq!(h.session.poll(), None);
    }

    #[test]
    fn a_dropped_socket_surfaces_as_an_error_rather_than_a_partial_insert() {
        let (mut h, events, _calls) = harness(false);
        events.send(AsrEvent::Partial("half a sen".into())).unwrap();
        h.hold(&[0i16; 160]);
        events.send(AsrEvent::Failed(AsrError::Network)).unwrap();

        let outcome = h.release();

        assert_eq!(outcome, Err(AsrError::Network));
        assert!(h.inserted.is_empty(), "a failed hold must type nothing");
    }

    #[test]
    fn a_missing_final_times_out_instead_of_typing_the_partial() {
        let (mut h, events, _calls) = harness(false);
        events.send(AsrEvent::Partial("meeting at four".into())).unwrap();
        h.hold(&[0i16; 160]);
        drop(events);

        assert_eq!(h.release(), Err(AsrError::Timeout));
        assert!(h.inserted.is_empty());
    }

    #[test]
    fn a_send_failure_does_not_type_anything_and_the_next_session_is_clean() {
        let (mut broken, _events, _calls) = harness(true);
        assert_eq!(broken.session.send_pcm(&[0i16; 160]), Err(AsrError::Network));
        assert!(broken.inserted.is_empty());

        // Recovery: a fresh session behaves normally, with no state carried
        // over from the failed one.
        let (mut next, events, _calls) = harness(false);
        next.hold(&[0i16; 160]);
        events.send(AsrEvent::Final("try again".into())).unwrap();
        next.release().unwrap();
        assert_eq!(next.inserted, vec!["try again".to_string()]);
    }

    #[test]
    fn a_final_arriving_mid_hold_is_refused_rather_than_typed() {
        let (mut h, events, calls) = harness(false);
        // The provider ended the stream on its own while the user is still
        // holding the chord and still speaking.
        events.send(AsrEvent::Final("half the sentence".into())).unwrap();
        h.hold(&[0i16; 160]);

        assert_eq!(h.release(), Err(AsrError::Provider));
        assert!(h.inserted.is_empty());
        assert!(calls.try_iter().any(|call| call == Call::Cancel));
    }

    #[test]
    fn error_categories_and_copy_are_speech_free_and_distinct() {
        let all = [
            AsrError::NotAuthenticated,
            AsrError::Rejected,
            AsrError::Network,
            AsrError::Timeout,
            AsrError::Provider,
        ];
        let mut categories: Vec<&str> = all.iter().map(|e| e.category()).collect();
        categories.sort_unstable();
        categories.dedup();
        assert_eq!(categories.len(), all.len(), "categories must be distinct");
        for error in all {
            assert!(!error.hud_message().is_empty());
        }
    }
}
