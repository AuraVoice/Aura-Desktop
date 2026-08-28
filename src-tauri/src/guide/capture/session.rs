//! Lifecycle and recovery for the persistent Guide capture session.
//!
//! Owns the one duplication session for an armed Guide epoch, decides when to
//! fall back to `xcap`, and handles the loss/recovery cycle that Windows makes
//! routine rather than exceptional (UAC prompts, lock screen, resolution
//! changes, GPU driver resets, a monitor being unplugged mid-session).
//!
//! Two invariants the Guide frame contract depends on:
//!
//! * **A tick always answers.** Every failure path ends in either a real frame
//!   from `xcap` or an honest `Unchanged`. Nothing here can make a tick error
//!   out, because the scheduler, the ack/resend state machine and the response
//!   timeout upstream all assume a tick resolves.
//! * **Recreation is bounded.** A permanently broken duplication (an unusual
//!   driver, a protected-content overlay) must not retry every 750 ms forever.
//!   After `MAX_CONSECUTIVE_FAILURES` the session gives up on duplication for
//!   the rest of the epoch and only re-probes on a slow timer.

use std::time::{Duration, Instant};

use log::{info, warn};

use super::{CaptureError, CaptureTick};

/// Backoff between recreation attempts, then a hold at the last value.
const RECREATE_BACKOFF: [Duration; 5] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_millis(1000),
    Duration::from_millis(2000),
    Duration::from_millis(4000),
];

/// After this many consecutive create failures, stop trying on the tick path.
const MAX_CONSECUTIVE_FAILURES: u32 = 5;

/// How often a session that gave up re-probes. Long, because the conditions
/// that cause a permanent failure change on human timescales, not tick ones.
const REPROBE_INTERVAL: Duration = Duration::from_secs(10);

#[cfg(windows)]
type Backend = super::dda::DdaBackend;

enum Health {
    /// Duplication is running.
    Live,
    /// Duplication is down and will be retried once `retry_at` passes.
    Recovering { retry_at: Instant, failures: u32 },
    /// Duplication failed repeatedly. `xcap` serves every tick until the slow
    /// re-probe succeeds.
    Fallback { reprobe_at: Instant },
}

pub struct GuideCaptureSession {
    monitor_left: i32,
    monitor_top: i32,
    #[cfg(windows)]
    backend: Option<Backend>,
    health: Health,
}

impl GuideCaptureSession {
    /// Created when Guide arms, and again whenever the pinned monitor's
    /// geometry changes. Never fails: a session that cannot start duplication
    /// is a session that uses `xcap`, which is exactly the previous behaviour.
    pub fn new(monitor_left: i32, monitor_top: i32) -> Self {
        let mut session = Self {
            monitor_left,
            monitor_top,
            #[cfg(windows)]
            backend: None,
            health: Health::Recovering {
                retry_at: Instant::now(),
                failures: 0,
            },
        };
        session.try_create();
        session
    }

    /// Whether this session still describes the given monitor origin. The Guide
    /// runtime calls this on its existing geometry-change path so a display
    /// swap recreates duplication instead of silently duplicating the old
    /// output.
    pub fn matches(&self, monitor_left: i32, monitor_top: i32) -> bool {
        self.monitor_left == monitor_left && self.monitor_top == monitor_top
    }

    /// One tick.
    ///
    /// `allow_unchanged` is false for a forced or reseeding tick, which needs
    /// real pixels even on a completely static screen. In that case an
    /// `Unchanged` answer from duplication is converted into an `xcap` capture
    /// rather than being passed up, so forced frames keep working exactly as
    /// they did before.
    pub fn tick(&mut self, allow_unchanged: bool) -> CaptureTick {
        #[cfg(windows)]
        {
            match self.backend_tick() {
                Some(CaptureTick::Captured(image)) => CaptureTick::Captured(image),
                // The ONLY path that may claim the screen is unchanged: a live
                // duplication session positively reported no presentation, and
                // the caller said an unchanged answer is acceptable for this
                // tick. Everything else - a forced tick that needs real pixels,
                // a lost session, a session still backing off, a session that
                // gave up - is Unavailable, and the caller falls back to xcap.
                Some(CaptureTick::Unchanged) if allow_unchanged => CaptureTick::Unchanged,
                _ => CaptureTick::Unavailable,
            }
        }
        #[cfg(not(windows))]
        {
            let _ = allow_unchanged;
            CaptureTick::Unavailable
        }
    }

    #[cfg(windows)]
    fn backend_tick(&mut self) -> Option<CaptureTick> {
        self.maybe_recover();
        let backend = self.backend.as_mut()?;
        match backend.tick() {
            Ok(tick) => Some(tick),
            Err(CaptureError::Lost) => {
                // Expected and routine. Logged at info, not warn, so a lock
                // screen does not look like a defect.
                info!("[Guide] capture session lost, recreating");
                self.invalidate(0);
                None
            }
            Err(CaptureError::Failed(reason)) => {
                warn!("[Guide] capture session failed: {reason}");
                self.invalidate(0);
                None
            }
        }
    }

    #[cfg(windows)]
    fn maybe_recover(&mut self) {
        match self.health {
            Health::Live => {}
            Health::Recovering { retry_at, .. } if Instant::now() >= retry_at => self.try_create(),
            Health::Fallback { reprobe_at } if Instant::now() >= reprobe_at => self.try_create(),
            _ => {}
        }
    }

    fn try_create(&mut self) {
        #[cfg(windows)]
        {
            let failures = match self.health {
                Health::Recovering { failures, .. } => failures,
                _ => 0,
            };
            match Backend::create(self.monitor_left, self.monitor_top) {
                Ok(backend) => {
                    self.backend = Some(backend);
                    self.health = Health::Live;
                    info!("[Guide] persistent capture session active");
                }
                Err(reason) => {
                    self.backend = None;
                    let next = failures.saturating_add(1);
                    if next >= MAX_CONSECUTIVE_FAILURES {
                        warn!(
                            "[Guide] persistent capture unavailable ({reason}), using xcap for this epoch"
                        );
                        self.health = Health::Fallback {
                            reprobe_at: Instant::now() + REPROBE_INTERVAL,
                        };
                    } else {
                        let backoff = RECREATE_BACKOFF
                            [(next as usize - 1).min(RECREATE_BACKOFF.len() - 1)];
                        self.health = Health::Recovering {
                            retry_at: Instant::now() + backoff,
                            failures: next,
                        };
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    fn invalidate(&mut self, failures: u32) {
        // Dropping the backend releases any held frame and the duplication
        // interface itself; holding a dead one would block recreation.
        self.backend = None;
        self.health = Health::Recovering {
            retry_at: Instant::now() + RECREATE_BACKOFF[0],
            failures,
        };
    }
}
