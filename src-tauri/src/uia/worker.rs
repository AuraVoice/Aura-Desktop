//! The COM apartment that owns UI Automation for this process.
//!
//! `IUIAutomation` and every element it hands out are COM objects: not `Send`,
//! bound to the apartment that created them, and capable of blocking for as
//! long as the application being inspected feels like taking. All three
//! properties make them unwelcome anywhere near Tauri's message-pump thread.
//!
//! So exactly one dedicated thread owns the apartment for the life of the
//! process, and callers talk to it over channels. This mirrors what the rest of
//! the codebase already does for long-lived native work (`meeting/audio.rs`,
//! `meeting/session.rs`, `voice_toggle_key.rs`).
//!
//! MTA, not STA: Microsoft's guidance for UI Automation *clients* is the
//! multithreaded apartment, and an MTA thread needs no message pump, which a
//! bare worker thread has no way to run correctly anyway.
//!
//! Two independent protections against a hung application:
//!
//! * The caller waits with a timeout and abandons a late reply. A slow app
//!   delays nothing; the turn falls back to pixels.
//! * An in-flight flag rejects a second request while one is still running.
//!
//! The second one only works if the flag is owned by the WORKER, not by the
//! caller. Clearing it when the caller's timeout expires is worthless: the COM
//! call is still blocked inside the other application, so every later turn
//! would happily queue another request behind the stuck one and the backlog
//! would grow without limit. So the worker clears the flag when it actually
//! finishes, and the request channel is bounded at one slot with a
//! non-blocking send, which makes an overflow structurally impossible rather
//! than merely unlikely.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use log::warn;

use super::anchor::{AnchorId, AnchorOutcome, AnchorStore, SpanObservation};
use super::contract::{QualityReason, StructuredContext};
use super::focus::FocusProbe;

/// The walk's own budget. Chosen so a structured capture is always cheaper
/// than the screenshot it replaces, even in the bad case.
pub const CAPTURE_BUDGET: Duration = Duration::from_millis(250);

/// Small margin so the caller's timeout loses to the worker's own deadline,
/// which produces a precise `bounds_hit` instead of an opaque timeout.
const REPLY_TIMEOUT: Duration = Duration::from_millis(300);

/// The focus probe's own reply budget. Far tighter than the walk's, because
/// this one sits directly in front of the user's keystrokes: a slow answer is
/// worse than no answer, and no answer means "type anyway".
const PROBE_TIMEOUT: Duration = Duration::from_millis(120);

/// Budget for the training-trace anchor calls. Generous next to the probe
/// because neither of them sits in front of a keystroke: the insert
/// confirmation runs after the text is already on screen, and observations run
/// minutes later on a background thread. A miss costs one trace its edit
/// tracking, so waiting a little longer for a real answer is the better trade.
const ANCHOR_TIMEOUT: Duration = Duration::from_millis(600);

enum Request {
    Capture {
        turn_context_id: String,
        cursor_x: i32,
        cursor_y: i32,
        guide_armed: bool,
        reply: std::sync::mpsc::Sender<StructuredContext>,
    },
    /// One question about the focused element, for dictation's insert path.
    /// Shares this apartment because every UI Automation call in the process
    /// must, and shares the busy flag so neither feature can stall the other.
    FocusProbe {
        /// Park a training-trace baseline on the same round trip. Only ever
        /// true when the user has switched trace capture on.
        capture_anchor: bool,
        reply: std::sync::mpsc::Sender<FocusProbe>,
    },
    /// Confirm where a freshly typed string landed, for training-trace capture.
    /// Runs after the keystrokes, so it is off the latency path entirely.
    AnchorInsert {
        trace_id: String,
        inserted: String,
        reply: std::sync::mpsc::Sender<AnchorOutcome>,
    },
    /// Re-read watched fields and report where their spans went. `retire` is
    /// carried on the same request so the observation schedule never needs a
    /// second round trip just to drop a finished anchor.
    AnchorObserve {
        read: Vec<AnchorId>,
        retire: Vec<AnchorId>,
        reply: std::sync::mpsc::Sender<Vec<SpanObservation>>,
    },
}

/// Managed as Tauri state. Cloning is not needed: callers reach it through
/// `app.try_state`.
pub struct UiaWorker {
    requests: Mutex<SyncSender<Request>>,
    /// Shared with the worker thread, which is the only thing allowed to clear
    /// it. True means a walk is still running inside another process.
    busy: Arc<AtomicBool>,
}

impl UiaWorker {
    pub fn start() -> Self {
        // One slot. Combined with try_send and the worker-owned busy flag, the
        // channel can hold at most a single pending request at any time.
        let (tx, rx) = sync_channel::<Request>(1);
        let busy = Arc::new(AtomicBool::new(false));
        let worker_busy = Arc::clone(&busy);
        if let Err(e) = std::thread::Builder::new()
            .name("aura-uia".into())
            .spawn(move || worker_loop(rx, worker_busy))
        {
            warn!("uia: worker thread failed to start: {e}");
        }
        Self {
            requests: Mutex::new(tx),
            busy,
        }
    }

    /// Blocking. Always returns a snapshot: on any failure it is an empty one
    /// carrying the reason, so the caller can fall back to pixels and report
    /// why rather than losing screen awareness silently.
    pub fn capture(
        &self,
        turn_context_id: String,
        cursor_x: i32,
        cursor_y: i32,
        guide_armed: bool,
    ) -> StructuredContext {
        let started = Instant::now();
        // Claim the worker. If a previous walk is still inside someone else's
        // process, refuse immediately rather than queueing behind it. This flag
        // is cleared by the worker, never here, so a caller timeout cannot
        // release a worker that is still blocked.
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return StructuredContext::unavailable(
                turn_context_id,
                QualityReason::CaptureTimeout,
                0,
            );
        }

        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let request = Request::Capture {
            turn_context_id: turn_context_id.clone(),
            cursor_x,
            cursor_y,
            guide_armed,
            reply: reply_tx,
        };
        let send_result = {
            let requests = self
                .requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            requests.try_send(request)
        };
        if let Err(error) = send_result {
            // Nothing was handed over, so this is the one place the caller may
            // release its own claim.
            self.busy.store(false, Ordering::Release);
            let reason = match error {
                // The worker is gone: COM or UI Automation could not be
                // initialised on this machine at all.
                TrySendError::Disconnected(_) => QualityReason::UiaUnavailable,
                // The single slot is occupied, so a walk is already pending.
                TrySendError::Full(_) => QualityReason::CaptureTimeout,
            };
            return StructuredContext::unavailable(
                turn_context_id,
                reason,
                started.elapsed().as_millis() as u64,
            );
        }

        match reply_rx.recv_timeout(REPLY_TIMEOUT) {
            Ok(context) => context,
            // Deliberately does NOT clear `busy`. The walk is still running;
            // the worker will release it when it genuinely finishes, and until
            // then every turn falls back to pixels instead of piling up.
            Err(_) => StructuredContext::unavailable(
                turn_context_id,
                QualityReason::CaptureTimeout,
                started.elapsed().as_millis() as u64,
            ),
        }
    }

    /// Blocking, and never for long. EVERY failure path returns `Unknown`,
    /// which the caller reads as "type anyway": a voice turn already inside
    /// someone else's process, a machine with no UI Automation, a hung
    /// application. Dictation must not become less reliable than it was because
    /// a second feature was busy.
    pub fn probe_focus(&self, capture_anchor: bool) -> FocusProbe {
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return FocusProbe::unknown();
        }

        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let send_result = {
            let requests = self
                .requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            requests.try_send(Request::FocusProbe {
                capture_anchor,
                reply: reply_tx,
            })
        };
        if send_result.is_err() {
            // Nothing was handed over, so this is the one place the caller may
            // release its own claim.
            self.busy.store(false, Ordering::Release);
            return FocusProbe::unknown();
        }

        // Same rule as `capture`: a timeout does NOT clear `busy`, because the
        // call is still inside the other process.
        reply_rx
            .recv_timeout(PROBE_TIMEOUT)
            .unwrap_or_else(|_| FocusProbe::unknown())
    }

    /// Blocking. Confirms where the text dictation just typed actually landed.
    ///
    /// Every failure resolves to "no anchor", which costs the utterance its
    /// edit tracking and nothing else: the audio and the transcript are already
    /// captured by the time this runs, and the text is already on screen.
    ///
    /// The claim/release discipline below is the same one `capture` documents.
    /// The caller releases its own claim only when nothing was handed over, and
    /// a timeout deliberately does NOT, because the call is still running inside
    /// the other process.
    pub fn anchor_insert(&self, trace_id: &str, inserted: &str) -> AnchorOutcome {
        let refused = |refusal: &'static str| AnchorOutcome {
            anchor_id: None,
            identity: Default::default(),
            refusal: Some(refusal),
        };
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return refused("worker_busy");
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let send_result = {
            let requests = self
                .requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            requests.try_send(Request::AnchorInsert {
                trace_id: trace_id.to_string(),
                inserted: inserted.to_string(),
                reply: reply_tx,
            })
        };
        if send_result.is_err() {
            self.busy.store(false, Ordering::Release);
            return refused("worker_unavailable");
        }
        reply_rx
            .recv_timeout(ANCHOR_TIMEOUT)
            .unwrap_or_else(|_| refused("anchor_timeout"))
    }

    /// Blocking. Re-reads the named anchors and retires the finished ones.
    /// An empty reply means nothing could be observed this tick; the caller
    /// simply tries again on the next one.
    pub fn anchor_observe(
        &self,
        read: Vec<AnchorId>,
        retire: Vec<AnchorId>,
    ) -> Vec<SpanObservation> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Vec::new();
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let send_result = {
            let requests = self
                .requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            requests.try_send(Request::AnchorObserve {
                read,
                retire,
                reply: reply_tx,
            })
        };
        if send_result.is_err() {
            self.busy.store(false, Ordering::Release);
            return Vec::new();
        }
        reply_rx.recv_timeout(ANCHOR_TIMEOUT).unwrap_or_default()
    }
}

fn worker_loop(requests: std::sync::mpsc::Receiver<Request>, busy: Arc<AtomicBool>) {
    use windows::core::Interface;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    // SAFETY: this thread owns its apartment for its whole life and calls
    // CoUninitialize only on the way out.
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if com.is_err() {
        warn!("uia: COM initialization failed, structured context unavailable");
        return;
    }
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(instance) => instance,
            Err(e) => {
                warn!("uia: CUIAutomation unavailable ({}), falling back to pixels", e.code().0);
                unsafe { CoUninitialize() };
                return;
            }
        };
    let _ = automation.as_raw();

    // Every watched text field lives here, on this thread, for exactly the
    // reason the module header gives for `IUIAutomation` itself: these are COM
    // proxies into other processes, they are not `Send`, and they belong to
    // this apartment. Callers only ever hold opaque ids.
    let mut anchors = AnchorStore::default();

    while let Ok(request) = requests.recv() {
        match request {
            Request::Capture {
                turn_context_id,
                cursor_x,
                cursor_y,
                guide_armed,
                reply,
            } => {
                let mut budget = super::tree::Budget::new(Instant::now() + CAPTURE_BUDGET);
                let context = super::tree::capture(
                    &automation,
                    turn_context_id,
                    POINT {
                        x: cursor_x,
                        y: cursor_y,
                    },
                    guide_armed,
                    &mut budget,
                );
                // Released here and only here, once the walk has genuinely
                // returned from COM. Before the reply, so the next turn can
                // claim the worker immediately rather than losing a tick to a
                // race with the caller.
                busy.store(false, Ordering::Release);
                // A send failure just means the caller already timed out and
                // moved on.
                let _ = reply.send(context);
            }
            Request::FocusProbe {
                capture_anchor,
                reply,
            } => {
                let probe = super::focus::probe(
                    &automation,
                    capture_anchor.then_some(&mut anchors),
                );
                busy.store(false, Ordering::Release);
                let _ = reply.send(probe);
            }
            Request::AnchorInsert {
                trace_id,
                inserted,
                reply,
            } => {
                let outcome = anchors.confirm_insert(&automation, &trace_id, &inserted);
                busy.store(false, Ordering::Release);
                let _ = reply.send(outcome);
            }
            Request::AnchorObserve {
                read,
                retire,
                reply,
            } => {
                let observations = anchors.observe(&read, &retire);
                busy.store(false, Ordering::Release);
                let _ = reply.send(observations);
            }
        }
    }

    // The channel closed, so no caller can be waiting. Leaving the flag set
    // would permanently disable structured context; the send path reports
    // UiaUnavailable from here on instead.
    busy.store(false, Ordering::Release);
    unsafe { CoUninitialize() };
}
