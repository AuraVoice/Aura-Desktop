//! Opt-in, fully local training-trace capture.
//!
//! Local is still the right word even though recognition is not: nothing here
//! is written or sent anywhere unless the user separately turns on sharing.
//!
//! One trace is one utterance: the audio, what the recognizer returned, what was
//! actually typed, and then - by watching the real text field for up to nine
//! minutes - what the user turned it into. That last part is the only signal in
//! the product that says the model was wrong about a specific sound, and it is
//! the reason this exists.
//!
//! ## What is guaranteed, not merely intended
//!
//! * **Nothing happens until the user switches it on.** Default off. With it
//!   off, no field is read, no directory is created, and this thread parks on an
//!   empty channel.
//! * **Nothing leaves the machine.** There is no network call anywhere in this
//!   module or anything it calls. Export writes to a folder the user asked for.
//!   `sentry_setup.rs` already drops any event from `aura_desktop_lib::dictation`,
//!   which this is under.
//! * **Nothing is logged but counts and outcomes.** Same discipline as
//!   `dictation/mod.rs` and `meeting/audio.rs`: never a transcript, never an
//!   edit, never a field's contents, at any level. `redact.rs` runs on the log
//!   READ path only and its rules are key=value shaped, so prose would sail
//!   straight through it.
//! * **Time is never ground truth.** An edit is recorded only when the span is
//!   re-found by its surrounding characters on a verified element
//!   (`uia::span`). The observation schedule below decides WHEN to look, never
//!   WHAT is true. When the span cannot be re-found, nothing is recorded.
//!
//! ## Why this runs on its own thread
//!
//! The dictation worker's only added cost is building a struct and sending it.
//! Everything expensive - the UI Automation round trip that confirms where the
//! text landed, encryption, the WAV encode, the index write, and every later
//! observation - happens here, so none of it can land on the keyup latency the
//! recognizer is already measured against.

#![cfg(windows)]

pub mod diff;
pub mod export;
pub mod flac;
pub mod record;
pub mod sensitive;
pub mod settings;
pub mod store;
pub mod upload;
pub mod wav;

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use log::{info, warn};
use tauri::{AppHandle, Manager};

use crate::uia::{AnchorId, SpanOutcome};

use record::{TokenTiming, TraceRecord, TraceState};
use settings::{SharedSettings, TraceSettings};

/// When a watched field is re-read, measured from the moment the text was
/// typed. Front-loaded because most corrections happen while the user is still
/// looking at the sentence, then spread out so a fix noticed on the way back
/// from a meeting is still caught. The last entry ends the watch.
///
/// These are observation times, not evidence. Nothing about a user's edit is
/// inferred from WHICH of these fired.
const OBSERVE_AT: [Duration; 7] = [
    Duration::from_secs(2),
    Duration::from_secs(6),
    Duration::from_secs(15),
    Duration::from_secs(45),
    Duration::from_secs(120),
    Duration::from_secs(300),
    Duration::from_secs(540),
];

/// Hard stop for correction tracking. The last scheduled read gets 30 seconds
/// of retry room, but a busy field can never extend the watch to ten minutes.
const MAX_WATCH_DURATION: Duration = Duration::from_secs(570);

/// How long a tick waits when it could not run: a chord is being held, or the
/// UI Automation worker is inside another process. Short enough that a deferred
/// observation is not effectively skipped.
const BACKOFF: Duration = Duration::from_secs(2);

/// Utterances being watched at once. Comfortably above the eight fields
/// `uia::anchor` will hold, so this bound is only ever reached by a burst of
/// dictations into the same few boxes.
const MAX_WATCHES: usize = 32;

/// Named so `logging.rs`'s panic hook recognises it and refuses to format a
/// payload raised here. This thread holds transcript text.
pub const TRACE_THREAD: &str = "aura-dictation-trace";

/// One finished utterance, handed over by the dictation worker.
///
/// `samples` is moved, never copied: it is the utterance buffer the worker
/// already owns and is about to drop.
pub struct Utterance {
    /// Monotonic start of the correction window, captured immediately after
    /// SendInput returns rather than after background encoding and storage.
    pub typed_at: Instant,
    pub raw_transcript: String,
    pub inserted_text: String,
    pub locally_corrected: bool,
    pub tokens: Vec<TokenTiming>,
    pub samples: Vec<f32>,
    /// Executable stem of the window that was typed into, from the dictation
    /// worker's own snapshot. Used to honour the user's app exclusions before
    /// any field is read.
    pub app_hint: Option<String>,
}

enum Message {
    Capture(Box<Utterance>),
    SettingsChanged(TraceSettings),
    Shutdown,
}

/// One field being watched for one utterance's edits.
struct Watch {
    trace_id: String,
    anchor_id: AnchorId,
    /// Index into `OBSERVE_AT`.
    step: usize,
    due_at: Instant,
    expires_at: Instant,
}

/// Managed as Tauri state. The dictation worker reads `enabled` through it and
/// hands finished utterances to it; the settings commands change it.
pub struct TraceHandle {
    settings: SharedSettings,
    sender: Mutex<Option<Sender<Message>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl TraceHandle {
    /// The opt-in, read on the dictation path. One state lookup and one
    /// uncontended lock.
    pub fn enabled(&self) -> bool {
        settings::snapshot(&self.settings).enabled
    }

    pub fn snapshot(&self) -> TraceSettings {
        settings::snapshot(&self.settings)
    }

    /// Whether the upload pump has any reason to run. Read by the JS pump on
    /// every tick, so it stays a snapshot rather than a store read.
    pub fn shares(&self) -> bool {
        settings::snapshot(&self.settings).shares()
    }

    /// Replaces the settings and tells the worker, so a retention change is
    /// applied immediately rather than at the next restart.
    pub fn apply(&self, next: TraceSettings) {
        *self
            .settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = next.clone();
        self.send(Message::SettingsChanged(next));
    }

    /// Hands one utterance over. Never blocks and never fails loudly: a trace
    /// that cannot be queued is a training sample not collected, which must
    /// never become an error the user sees in the middle of dictating.
    pub fn capture(&self, utterance: Utterance) {
        self.send(Message::Capture(Box::new(utterance)));
    }

    fn send(&self, message: Message) {
        if let Some(sender) = self
            .sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let _ = sender.send(message);
        }
    }
}

impl Drop for TraceHandle {
    fn drop(&mut self) {
        self.send(Message::Shutdown);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}

/// Starts the trace worker. Cheap even when the feature is off: it reads one
/// small JSON file and then parks on an empty channel.
pub fn start(app: AppHandle) -> TraceHandle {
    let loaded = settings::load(&app);
    let shared = settings::shared(loaded.clone());
    let (sender, receiver) = std::sync::mpsc::channel::<Message>();

    let worker_settings = shared.clone();
    let worker = std::thread::Builder::new()
        .name(TRACE_THREAD.to_string())
        .spawn(move || worker_thread(app, receiver, worker_settings, loaded));

    match worker {
        Ok(worker) => TraceHandle {
            settings: shared,
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
        },
        Err(error) => {
            warn!("dictation.trace: worker could not start: {error}");
            TraceHandle {
                settings: shared,
                sender: Mutex::new(None),
                worker: Mutex::new(None),
            }
        }
    }
}

fn worker_thread(
    app: AppHandle,
    receiver: Receiver<Message>,
    shared: SharedSettings,
    initial: TraceSettings,
) {
    let mut current = initial;
    // Converges a settings write that reached disk just before a crash. Active
    // owner-bound work must become deletion obligations even if the worker
    // never observed the original on-to-off transition.
    if !current.shares() {
        if let Err(error) = store::tombstone_all_shared(&app) {
            warn!("dictation.trace: startup revocation queue failed: {error}");
        }
    }
    // A UI Automation anchor cannot survive the process, so anything left
    // watching from the last run is settled now rather than waiting forever.
    if current.enabled {
        match store::settle_orphans(&app) {
            Ok(settled) if settled > 0 => {
                info!("dictation.trace: settled {settled} orphaned trace(s) from a previous run")
            }
            Ok(_) => {}
            Err(error) => warn!("dictation.trace: could not settle orphans: {error}"),
        }
        maintain(&app, &current);
    }

    let mut watches: Vec<Watch> = Vec::new();
    // Anchors whose watches have all finished, retired on the next round trip
    // so retiring never costs a request of its own.
    let mut retire: Vec<AnchorId> = Vec::new();

    loop {
        // Run due work before receiving another capture so a burst of queued
        // utterances cannot starve observation or the hard retirement bound.
        observe_due(&app, &current, &mut watches, &mut retire);
        let timeout = watches
            .iter()
            .map(|watch| watch.due_at)
            .min()
            .map(|due| due.saturating_duration_since(Instant::now()));
        let received = match timeout {
            Some(timeout) => match receiver.recv_timeout(timeout) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match receiver.recv() {
                Ok(message) => Some(message),
                Err(_) => break,
            },
        };

        match received {
            Some(Message::Shutdown) => break,
            Some(Message::SettingsChanged(next)) => {
                let was_enabled = current.enabled;
                let was_sharing = current.shares();
                current = next;
                *shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = current.clone();
                if !current.enabled {
                    // Switching off stops the watching immediately. Already
                    // stored traces stay until the user deletes them, which is
                    // a separate and explicit action.
                    retire.extend(watches.drain(..).map(|watch| watch.anchor_id));
                    let _ = crate::uia::anchor_observe(&app, Vec::new(), std::mem::take(&mut retire));
                } else if !was_enabled {
                    maintain(&app, &current);
                }
                match (was_sharing, current.shares()) {
                    // Turning sharing ON covers the backlog too. Only sharing
                    // future dictations would quietly ignore the traces the user
                    // was looking at when they decided to consent.
                    (false, true) => match upload::enqueue_backlog(&app, &current) {
                        Ok(queued) => info!("dictation.trace: sharing on, queued {queued} trace(s)"),
                        Err(error) => warn!("dictation.trace: backlog queue failed: {error}"),
                    },
                    // Turning it OFF has to reach back for what was already sent,
                    // or revocation is cosmetic: it would stop future uploads and
                    // leave everything prior sitting on the server.
                    (true, false) => match store::tombstone_all_shared(&app) {
                        Ok(count) => {
                            info!("dictation.trace: sharing off, {count} server copy/copies queued for deletion")
                        }
                        Err(error) => warn!("dictation.trace: revocation queue failed: {error}"),
                    },
                    _ => {}
                }
            }
            Some(Message::Capture(utterance)) => {
                if !current.enabled {
                    continue;
                }
                if let Some(watch) = capture(&app, &current, *utterance) {
                    if watches.len() >= MAX_WATCHES {
                        let dropped = watches.remove(0);
                        // Only retire the anchor once nothing else refers to
                        // it: two dictations into one field share one anchor,
                        // and retiring it would blind the other watch too.
                        if !watches.iter().any(|w| w.anchor_id == dropped.anchor_id) {
                            retire.push(dropped.anchor_id);
                        }
                    }
                    watches.push(watch);
                }
            }
            None => observe_due(&app, &current, &mut watches, &mut retire),
        }
    }

    if !retire.is_empty() {
        let _ = crate::uia::anchor_observe(&app, Vec::new(), retire);
    }
}

/// Retention, run at startup and after each stored utterance.
fn maintain(app: &AppHandle, settings: &TraceSettings) {
    match store::prune(app, settings.retention_days) {
        Ok(dropped) if dropped > 0 => {
            info!(
                "dictation.trace: retention dropped {dropped} trace(s) older than {} day(s)",
                settings.retention_days
            );
        }
        Ok(_) => {}
        Err(error) => warn!("dictation.trace: retention pass failed: {error}"),
    }
}

/// Stores one utterance and, when the insert could be verified, starts watching
/// the field it landed in.
fn capture(app: &AppHandle, settings: &TraceSettings, utterance: Utterance) -> Option<Watch> {
    let typed_at = utterance.typed_at;
    // The user's own exclusion list, checked against the window the dictation
    // worker snapshotted, BEFORE any field is read.
    if let Some(hint) = utterance.app_hint.as_deref() {
        if settings.excludes(hint) {
            return None;
        }
    }
    // Content that must never be written down, whatever the field claims to be.
    // A hit drops the whole utterance, audio included: a redacted transcript
    // beside unredacted audio is the same leak with a misleading label on it.
    if let Some(refusal) = sensitive::refuse(&[
        &utterance.raw_transcript,
        &utterance.inserted_text,
    ]) {
        info!("dictation.trace: utterance refused, reason={refusal}");
        return None;
    }

    let trace_id = match random_id() {
        Ok(id) => id,
        Err(error) => {
            warn!("dictation.trace: could not mint a trace id: {error}");
            return None;
        }
    };

    // Confirms where the keystrokes actually landed. Runs here rather than on
    // the dictation worker so the round trip is off the keyup path entirely.
    let anchor = crate::uia::anchor_insert(app, &trace_id, &utterance.inserted_text);
    let app_name = if anchor.identity.app.is_empty() {
        utterance.app_hint.clone().unwrap_or_default()
    } else {
        anchor.identity.app.clone()
    };
    if settings.excludes(&app_name) {
        return None;
    }

    let audio_ms = wav::duration_ms(&utterance.samples);
    let has_audio = settings.capture_audio && !utterance.samples.is_empty();
    if has_audio {
        let encoded = wav::encode(&utterance.samples);
        if let Err(error) = store::save_audio(app, &trace_id, &encoded) {
            warn!("dictation.trace: audio could not be stored: {error}");
        }
    }

    let record = TraceRecord {
        trace_id: trace_id.clone(),
        recorded_at_ms: store::now_ms(),
        model_id: super::asr::deepgram::RECOGNIZER_ID.to_string(),
        app: app_name,
        field_id: anchor.identity.field_id.clone(),
        role: anchor.identity.role.clone(),
        audio_ms,
        has_audio,
        raw_transcript: utterance.raw_transcript,
        inserted_text: utterance.inserted_text,
        locally_corrected: utterance.locally_corrected,
        tokens: utterance.tokens,
        state: if anchor.anchor_id.is_some() {
            TraceState::Watching
        } else {
            TraceState::Unanchored
        },
        observations: 0,
        last_observed_at_ms: 0,
        final_text: None,
        edits: Vec::new(),
        ground_truth: None,
        anchor_note: anchor.refusal.map(|reason| reason.to_string()),
        // Never shareable at capture time, whatever the settings say: the label
        // is not confirmed until the field has been watched to the end. Only
        // `settle()` may promote this.
        share_state: record::ShareState::Ineligible,
        upload_owner_uid: None,
        share_attempts: 0,
        share_next_attempt_ms: 0,
        shared_at_ms: None,
        consent_version: None,
    };
    let anchored = record.state == TraceState::Watching;
    if let Err(error) = store::append(app, record) {
        warn!("dictation.trace: trace could not be stored: {error}");
        return None;
    }
    maintain(app, settings);
    info!(
        "dictation.trace: captured audio_ms={audio_ms} anchored={anchored} refusal={:?}",
        anchor.refusal
    );

    anchor.anchor_id.map(|anchor_id| {
        Watch {
            trace_id,
            anchor_id,
            step: 0,
            due_at: typed_at + OBSERVE_AT[0],
            expires_at: typed_at + MAX_WATCH_DURATION,
        }
    })
}

/// One observation tick.
fn observe_due(
    app: &AppHandle,
    settings: &TraceSettings,
    watches: &mut Vec<Watch>,
    retire: &mut Vec<AnchorId>,
) {
    let now = Instant::now();
    let mut index = 0;
    while index < watches.len() {
        if now < watches[index].expires_at {
            index += 1;
            continue;
        }
        settle(
            app,
            settings,
            &watches[index].trace_id,
            TraceState::AnchorLost,
            None,
        );
        let expired = watches.remove(index);
        if !watches.iter().any(|watch| watch.anchor_id == expired.anchor_id) {
            retire.push(expired.anchor_id);
        }
        info!("dictation.trace: settled state=anchor_lost reason=window_elapsed");
    }
    if watches.is_empty() {
        return;
    }
    // Never contend with a hold. `probe_focus` fails open to "type anyway", so
    // a busy worker would only ever make dictation slightly less careful, but
    // there is no reason to spend that when the tick can simply wait.
    if super::is_capturing() {
        for watch in watches.iter_mut().filter(|watch| watch.due_at <= now) {
            watch.due_at = now + BACKOFF;
        }
        return;
    }

    let due: Vec<String> = watches
        .iter()
        .filter(|watch| watch.due_at <= now)
        .map(|watch| watch.trace_id.clone())
        .collect();
    if due.is_empty() {
        return;
    }
    let mut read: Vec<AnchorId> = watches
        .iter()
        .filter(|watch| watch.due_at <= now)
        .map(|watch| watch.anchor_id)
        .collect();
    read.sort_unstable();
    read.dedup();

    let observations = crate::uia::anchor_observe(app, read, std::mem::take(retire));
    if observations.is_empty() {
        // The worker was busy inside another process, or every anchor had
        // already been retired. Either way this tick learned nothing, so no
        // step is advanced: an unobserved field must not be treated as an
        // unedited one.
        for watch in watches.iter_mut().filter(|watch| watch.due_at <= now) {
            watch.due_at = now + BACKOFF;
        }
        return;
    }

    let mut finished: Vec<AnchorId> = Vec::new();
    for observation in observations {
        let Some(index) = watches
            .iter()
            .position(|watch| watch.trace_id == observation.trace_id)
        else {
            continue;
        };
        let last_step = watches[index].step + 1 >= OBSERVE_AT.len();
        match observation.outcome {
            SpanOutcome::Located { text, exact } => {
                let refusal = sensitive::refuse(&[&text]);
                if let Some(reason) = refusal {
                    // The user pasted or typed something into the span that
                    // must not be stored. The trace goes entirely, rather than
                    // being frozen at its previous value.
                    info!("dictation.trace: trace dropped after observation, reason={reason}");
                    let _ = store::delete(app, &watches[index].trace_id);
                    finished.push(watches.remove(index).anchor_id);
                    continue;
                }
                let state = if last_step {
                    TraceState::Finalized
                } else {
                    TraceState::Watching
                };
                let edits = settle(app, settings, &watches[index].trace_id, state, Some(text));
                if last_step {
                    // Counts and outcomes only, never the text either side.
                    // `exact` says the span's own characters were re-found
                    // alongside their context rather than only its edges, which
                    // is the difference between a high and a merely adequate
                    // confidence relocation.
                    info!(
                        "dictation.trace: settled state=finalized exact={exact} edits={edits} \
                         step={}",
                        watches[index].step + 1
                    );
                    finished.push(watches.remove(index).anchor_id);
                } else {
                    watches[index].step += 1;
                    watches[index].due_at =
                        Instant::now() + step_gap(watches[index].step);
                }
            }
            SpanOutcome::Removed => {
                settle(
                    app,
                    settings,
                    &watches[index].trace_id,
                    TraceState::Discarded,
                    Some(String::new()),
                );
                finished.push(watches.remove(index).anchor_id);
            }
            SpanOutcome::Lost => {
                settle(app, settings, &watches[index].trace_id, TraceState::AnchorLost, None);
                finished.push(watches.remove(index).anchor_id);
            }
        }
    }

    // A due watch the worker said nothing about no longer has a live anchor.
    // Settled as lost rather than retried forever.
    let now = Instant::now();
    let mut index = 0;
    while index < watches.len() {
        if due.contains(&watches[index].trace_id) && watches[index].due_at <= now {
            settle(app, settings, &watches[index].trace_id, TraceState::AnchorLost, None);
            finished.push(watches.remove(index).anchor_id);
            continue;
        }
        index += 1;
    }

    // An anchor is only genuinely retired once no watch still refers to it: two
    // dictations into one field share one anchor.
    for anchor_id in finished {
        if !watches.iter().any(|watch| watch.anchor_id == anchor_id) {
            retire.push(anchor_id);
        }
    }
}

/// The gap between observation `step - 1` and `step`, so the schedule is spaced
/// from the utterance rather than from whenever the last tick happened to run.
fn step_gap(step: usize) -> Duration {
    let previous = OBSERVE_AT[step - 1];
    OBSERVE_AT
        .get(step)
        .map(|next| next.saturating_sub(previous))
        .unwrap_or(BACKOFF)
}

/// Writes one observation into the stored record, running the diff when there
/// is a final text to compare against. Returns how many classified edits the
/// trace now carries, for the log line - never the edits themselves.
fn settle(
    app: &AppHandle,
    settings: &TraceSettings,
    trace_id: &str,
    state: TraceState,
    final_text: Option<String>,
) -> usize {
    let mut edits = 0usize;
    let result = store::update(app, trace_id, |record| {
        record.state = state;
        record.observations = record.observations.saturating_add(1);
        record.last_observed_at_ms = store::now_ms();
        match final_text {
            // A discarded span has no replacement text, so there is nothing for
            // the recognizer to have got right. Recorded, never diffed.
            Some(text) if state == TraceState::Discarded => {
                record.final_text = Some(text);
                record.edits.clear();
                record.ground_truth = None;
            }
            Some(text) => {
                let comparison = diff::compare(&record.inserted_text, &text);
                record.final_text = Some(text);
                record.edits = comparison.edits;
                record.ground_truth = Some(comparison.ground_truth);
            }
            None => {}
        }
        edits = record.edits.len();
        // The ONLY place a trace enters the upload queue. Gated on the record's
        // own state, so a trace that never reached `Finalized` - and therefore
        // never had its label confirmed against the real text field - can never
        // be queued from anywhere else.
        upload::mark_eligible(record, settings);
    });
    if let Err(error) = result {
        warn!("dictation.trace: observation could not be stored: {error}");
    }
    edits
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The trace handle, when the feature has been started. Absent only if the
/// worker failed to start at all.
pub fn handle(app: &AppHandle) -> Option<tauri::State<'_, TraceHandle>> {
    app.try_state::<TraceHandle>()
}

/// Whether an insert should park a training-trace baseline on its focus probe.
pub fn wants_anchor(app: &AppHandle) -> bool {
    handle(app).is_some_and(|handle| handle.enabled())
}
