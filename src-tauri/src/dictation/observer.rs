//! Watches the field Aura just typed into, and records what the user turned
//! the words into.
//!
//! This is the only signal in the product that says the recognizer or the
//! formatter was wrong about a specific utterance, and it is the reason the
//! training traces exist (architectures/dictation-model-plan.md, Phase 0).
//!
//! What is guaranteed, not merely intended:
//!
//! * **Nothing is observed unless sharing is on.** The dictation worker only
//!   parks a baseline and hands an utterance here when `share::sharing_hint`
//!   is true, which React sets from the consent record.
//! * **Time is never ground truth.** An edit is recorded only when the span is
//!   re-found by its surrounding characters (`uia::span`). The schedule below
//!   decides WHEN to look, never WHAT is true. A field that could not be
//!   re-read, that emptied because Enter sent the message, or whose window
//!   went away is recorded as `inserted_only`: the label the desktop used to
//!   assert without looking is now the label it gets only by looking.
//! * **Nothing is logged but counts and outcomes.** Never the text, never an
//!   edit.
//!
//! Why this runs on its own thread: the dictation worker's only added cost is
//! building a struct and sending it. The UI Automation round trip that
//! confirms where the text landed, every later observation and the diff all
//! happen here, so none of it can land on the keyup latency the recognizer is
//! measured against.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use log::{info, warn};
use tauri::{AppHandle, Manager};

use crate::uia::{self, AnchorId, SpanOutcome};

use super::{edits, history};

/// When a watched field is re-read, measured from the moment the text was
/// typed. Front-loaded because most corrections happen while the user is still
/// looking at the sentence; the last entry ends the watch. The next hold also
/// ends it early (`observe_now`), so a fast dictator never has two watches
/// open on the same box.
const OBSERVE_AT: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(6),
    Duration::from_secs(20),
];

/// Hard stop. The last scheduled read gets a few seconds of retry room and no
/// more: `share.rs` also takes any row older than 30 s unobserved, so a watch
/// must be settled before that.
const MAX_WATCH_DURATION: Duration = Duration::from_secs(26);

/// How long a tick waits when the UI Automation worker was busy inside another
/// process. Short, so a deferred observation is not effectively skipped.
const BACKOFF: Duration = Duration::from_secs(1);

/// Utterances being watched at once. Past this the oldest is settled with
/// whatever it has, which costs one trace its last observation and nothing
/// else.
const MAX_WATCHES: usize = 16;

/// Named so a panic here can be recognised by thread name in the logs. This
/// thread holds transcript text.
pub const OBSERVER_THREAD: &str = "aura-dictation-observer";

/// One typed utterance, handed over by the dictation worker right after
/// `SendInput` returned `Inserted` and the history row was created.
pub struct Observation {
    pub uid: String,
    /// The history row id. Doubles as the anchor's trace id.
    pub row_id: String,
    pub inserted_text: String,
    /// Monotonic start of the correction window, captured immediately after
    /// the keystrokes landed.
    pub typed_at: Instant,
}

enum Message {
    Observe(Box<Observation>),
    /// A new hold started: every open watch takes its final reading now.
    ObserveNow,
    Shutdown,
}

/// One field being watched for one utterance's edits.
struct Watch {
    uid: String,
    row_id: String,
    anchor_id: AnchorId,
    inserted_text: String,
    /// Index into `OBSERVE_AT`.
    step: usize,
    due_at: Instant,
    expires_at: Instant,
    /// The next successful reading is the last one.
    force_final: bool,
    /// The most recent located text, so a watch that later loses its anchor
    /// still settles on what was actually seen rather than on nothing.
    last_seen: Option<String>,
}

/// Managed as Tauri state. Absent only if the thread failed to start.
pub struct ObserverHandle {
    sender: Mutex<Option<Sender<Message>>>,
}

impl ObserverHandle {
    fn send(&self, message: Message) {
        let guard = self
            .sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(sender) = guard.as_ref() {
            let _ = sender.send(message);
        }
    }
}

impl Drop for ObserverHandle {
    fn drop(&mut self) {
        self.send(Message::Shutdown);
    }
}

pub fn start(app: AppHandle) -> ObserverHandle {
    let (tx, rx) = channel::<Message>();
    let spawned = std::thread::Builder::new()
        .name(OBSERVER_THREAD.into())
        .spawn(move || worker_thread(app, rx));
    match spawned {
        Ok(_) => ObserverHandle {
            sender: Mutex::new(Some(tx)),
        },
        Err(error) => {
            warn!("dictation.observer: thread failed to start ({error}); read-back disabled");
            ObserverHandle {
                sender: Mutex::new(None),
            }
        }
    }
}

/// Hands one typed utterance to the observer. Cheap: a struct and a send.
pub fn observe(app: &AppHandle, observation: Observation) {
    if let Some(handle) = app.try_state::<ObserverHandle>() {
        handle.send(Message::Observe(Box::new(observation)));
    }
}

/// A new hold has started: take the final reading of every open watch now.
pub fn observe_now(app: &AppHandle) {
    if let Some(handle) = app.try_state::<ObserverHandle>() {
        handle.send(Message::ObserveNow);
    }
}

fn worker_thread(app: AppHandle, receiver: Receiver<Message>) {
    let mut watches: Vec<Watch> = Vec::new();
    // Anchors whose watches have all finished, retired on the next round trip
    // so retiring never costs a request of its own.
    let mut retire: Vec<AnchorId> = Vec::new();

    loop {
        // Run due work before receiving another utterance so a burst cannot
        // starve observation or the hard expiry.
        observe_due(&app, &mut watches, &mut retire);
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
            Some(Message::ObserveNow) => {
                let now = Instant::now();
                for watch in watches.iter_mut() {
                    watch.due_at = now;
                    watch.force_final = true;
                }
            }
            Some(Message::Observe(observation)) => {
                if let Some(watch) = capture(&app, *observation) {
                    if watches.len() >= MAX_WATCHES {
                        let oldest = watches.remove(0);
                        settle(&app, &oldest, oldest.last_seen.clone());
                        if !watches.iter().any(|w| w.anchor_id == oldest.anchor_id) {
                            retire.push(oldest.anchor_id);
                        }
                    }
                    watches.push(watch);
                }
            }
            None => {}
        }
    }

    // Shutting down: settle what was seen so far rather than leaving rows
    // unlabelled for the 30 s fallback to pick up blind.
    for watch in watches.drain(..) {
        settle(&app, &watch, watch.last_seen.clone());
        retire.push(watch.anchor_id);
    }
    if !retire.is_empty() {
        let _ = uia::anchor_observe(&app, Vec::new(), retire);
    }
}

/// Confirms where the keystrokes landed and opens a watch, or settles the row
/// as unobserved right away when no anchor could be established.
fn capture(app: &AppHandle, observation: Observation) -> Option<Watch> {
    let anchor = uia::anchor_insert(app, &observation.row_id, &observation.inserted_text);
    match anchor.anchor_id {
        Some(anchor_id) => {
            info!("dictation.observer: anchored role={}", anchor.identity.role);
            Some(Watch {
                uid: observation.uid,
                row_id: observation.row_id,
                anchor_id,
                inserted_text: observation.inserted_text,
                step: 0,
                due_at: observation.typed_at + OBSERVE_AT[0],
                expires_at: observation.typed_at + MAX_WATCH_DURATION,
                force_final: false,
                last_seen: None,
            })
        }
        None => {
            info!(
                "dictation.observer: not anchored refusal={}",
                anchor.refusal.unwrap_or("unknown")
            );
            record(app, &observation.uid, &observation.row_id, &observation.inserted_text, None);
            None
        }
    }
}

/// One observation tick.
fn observe_due(app: &AppHandle, watches: &mut Vec<Watch>, retire: &mut Vec<AnchorId>) {
    let now = Instant::now();

    // Expired watches settle on whatever they last saw.
    let mut index = 0;
    while index < watches.len() {
        if now < watches[index].expires_at {
            index += 1;
            continue;
        }
        let expired = watches.remove(index);
        settle(app, &expired, expired.last_seen.clone());
        if !watches.iter().any(|watch| watch.anchor_id == expired.anchor_id) {
            retire.push(expired.anchor_id);
        }
    }

    let due_rows: Vec<String> = watches
        .iter()
        .filter(|watch| watch.due_at <= now)
        .map(|watch| watch.row_id.clone())
        .collect();
    if due_rows.is_empty() {
        if !retire.is_empty() && watches.is_empty() {
            let _ = uia::anchor_observe(app, Vec::new(), std::mem::take(retire));
        }
        return;
    }
    let mut read: Vec<AnchorId> = watches
        .iter()
        .filter(|watch| watch.due_at <= now)
        .map(|watch| watch.anchor_id)
        .collect();
    read.sort_unstable();
    read.dedup();

    let observations = uia::anchor_observe(app, read, std::mem::take(retire));
    if observations.is_empty() {
        // The worker was busy inside another process, or every anchor had
        // already been retired. This tick learned nothing, so no step is
        // advanced: an unobserved field must not be treated as an unedited one.
        for watch in watches.iter_mut().filter(|watch| watch.due_at <= now) {
            watch.due_at = now + BACKOFF;
        }
        return;
    }

    let mut finished: Vec<AnchorId> = Vec::new();
    for observation in observations {
        let Some(index) = watches
            .iter()
            .position(|watch| watch.row_id == observation.trace_id)
        else {
            continue;
        };
        let last_step = watches[index].force_final || watches[index].step + 1 >= OBSERVE_AT.len();
        match observation.outcome {
            SpanOutcome::Located { text, exact } => {
                if last_step {
                    let watch = watches.remove(index);
                    info!(
                        "dictation.observer: final reading exact={exact} step={}",
                        watch.step + 1
                    );
                    settle(app, &watch, Some(text));
                    finished.push(watch.anchor_id);
                } else {
                    let watch = &mut watches[index];
                    watch.last_seen = Some(text);
                    watch.step += 1;
                    watch.due_at = Instant::now() + step_gap(watch.step);
                }
            }
            // The surrounding text survived and the dictated words are gone:
            // the user threw them away. Not a correction, never a label, and
            // nothing more to watch.
            SpanOutcome::Removed => {
                let watch = watches.remove(index);
                info!("dictation.observer: span removed by the user");
                settle(app, &watch, None);
                finished.push(watch.anchor_id);
            }
            // The field could not be re-found. Whatever was seen before stands;
            // if nothing was, the row is honestly unobserved.
            SpanOutcome::Lost => {
                let watch = watches.remove(index);
                info!("dictation.observer: anchor lost seen_before={}", watch.last_seen.is_some());
                settle(app, &watch, watch.last_seen.clone());
                finished.push(watch.anchor_id);
            }
        }
    }

    // A due watch the worker said nothing about no longer has a live anchor.
    let now = Instant::now();
    let mut index = 0;
    while index < watches.len() {
        if due_rows.contains(&watches[index].row_id) && watches[index].due_at <= now {
            let watch = watches.remove(index);
            settle(app, &watch, watch.last_seen.clone());
            finished.push(watch.anchor_id);
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

fn settle(app: &AppHandle, watch: &Watch, observed: Option<String>) {
    record(app, &watch.uid, &watch.row_id, &watch.inserted_text, observed);
}

/// Writes the verdict onto the history row. `observed` is the text the field
/// held where Aura's words were; `None` means the field was never read
/// successfully and the row keeps the honest `inserted_only` label.
fn record(app: &AppHandle, uid: &str, row_id: &str, inserted: &str, observed: Option<String>) {
    let verdict = match observed {
        None => history::ObservationVerdict::Unobserved,
        Some(text) => {
            let comparison = edits::compare(inserted, &text);
            let quality = if comparison.edits.is_empty() {
                history::LABEL_CONFIRMED_GOLD
            } else if edits::is_substantial_rewrite(inserted, &comparison.edits) {
                // Observed, but the user replaced the sentence rather than
                // corrected it. Kept as silver so the exporter never treats
                // the rewrite as what the audio said; the edits still go up.
                history::LABEL_CORRECTED_SILVER
            } else {
                history::LABEL_CORRECTED_GOLD
            };
            let edits_json = match serde_json::to_string(&comparison.edits) {
                Ok(json) => json,
                Err(error) => {
                    warn!("dictation.observer: edits could not be serialized ({error})");
                    "[]".to_string()
                }
            };
            info!(
                "dictation.observer: settled quality={quality} edits={}",
                comparison.edits.len()
            );
            history::ObservationVerdict::Observed {
                final_text: text,
                training_text: comparison.ground_truth,
                edits_json,
                label_quality: quality,
            }
        }
    };
    if let Err(error) = history::record_observation(app, uid, row_id, verdict) {
        warn!("dictation.observer: observation could not be stored ({error})");
    }
}
