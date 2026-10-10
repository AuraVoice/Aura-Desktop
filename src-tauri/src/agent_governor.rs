//! Progress-based stopping for Aura's agent loops (future-features.txt,
//! "OPERATOR HANDS + DYNAMIC STEPPING", section 5).
//!
//! No loop here counts steps. A task keeps going for as long as each action
//! reaches a state of the world it has not seen before in this task. When it
//! stops reaching anything new, the loop first tells the model so (a stall
//! note) and only then ends it. The one backstop for a task that keeps finding
//! new things forever is money: every `CHECKIN_EVERY_MICROUSD` spent, the loop
//! pauses and the user decides whether it continues. Nothing else ends a task
//! that is still getting somewhere.
//!
//! The browser agent is the first caller; the desktop Operator will be the
//! second, which is why this sits outside `agent_browser/`.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

/// Consecutive actions that reached nothing new before the model is told.
pub const NUDGE_AFTER: u32 = 3;
/// Consecutive actions that reached nothing new before the task ends `stuck`.
pub const STUCK_AFTER: u32 = 6;
/// Spend between check-ins: $1.
pub const CHECKIN_EVERY_MICROUSD: u64 = 1_000_000;

/// Hashes whatever identifies "where the task is" for one loop. Collisions
/// only cost a false stall, which the nudge then recovers from.
pub fn fingerprint<T: Hash + ?Sized>(state: &T) -> u64 {
    let mut hasher = DefaultHasher::new();
    state.hash(&mut hasher);
    hasher.finish()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The last action reached a new state.
    Progressing,
    /// Nothing new for this many actions in a row, below `STUCK_AFTER`.
    Stalled(u32),
    /// Nothing new for `STUCK_AFTER` actions in a row: end the task.
    Stuck,
}

pub struct Governor {
    seen: HashSet<u64>,
    stall: u32,
    spent_microusd: u64,
    next_checkin_microusd: u64,
}

impl Default for Governor {
    fn default() -> Self {
        Self {
            seen: HashSet::new(),
            stall: 0,
            spent_microusd: 0,
            next_checkin_microusd: CHECKIN_EVERY_MICROUSD,
        }
    }
}

impl Governor {
    /// Records the state the last action led to. Call once per model action,
    /// never for a transport retry, which is not an action.
    pub fn observe(&mut self, state: u64) -> Verdict {
        if self.seen.insert(state) {
            self.stall = 0;
            return Verdict::Progressing;
        }
        self.stall += 1;
        if self.stall >= STUCK_AFTER {
            Verdict::Stuck
        } else {
            Verdict::Stalled(self.stall)
        }
    }

    /// True while the model should be told it is going nowhere.
    pub fn needs_nudge(&self) -> bool {
        self.stall >= NUDGE_AFTER
    }

    pub fn stall(&self) -> u32 {
        self.stall
    }

    /// Adds one step's cost. True when this step crossed a check-in mark.
    pub fn add_spend(&mut self, microusd: u64) -> bool {
        self.spent_microusd = self.spent_microusd.saturating_add(microusd);
        self.spent_microusd >= self.next_checkin_microusd
    }

    /// The user said continue: the next check-in is one more step size past
    /// what has already been spent.
    pub fn extend(&mut self) {
        self.next_checkin_microusd = self.spent_microusd.saturating_add(CHECKIN_EVERY_MICROUSD);
    }

    pub fn spent_microusd(&self) -> u64 {
        self.spent_microusd
    }
}
