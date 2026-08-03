//! Where Guide Mode's pixels come from.
//!
//! Guide fingerprints the screen every 750 ms for the whole time it is armed.
//! Doing that with a fresh full-monitor `xcap` capture per tick means a
//! complete GPU-to-CPU readback of every pixel, several times a second, whether
//! or not anything on screen actually moved - which on a static screen is the
//! common case, since Guide is usually watching the user read something.
//!
//! So the tick now asks a persistent DXGI Desktop Duplication session instead.
//! Duplication already knows whether the desktop was presented since the last
//! read, so an unchanged tick costs one `AcquireNextFrame` that returns
//! `WAIT_TIMEOUT` and nothing else: no readback, no downsample, no fingerprint.
//!
//! Be precise about what this does and does not save. The saving is entirely on
//! ticks where NOTHING was presented. A tick on which anything at all changed -
//! a blinking caret, a video frame, a spinner - still pays a full-monitor
//! GPU-to-CPU readback and BGRA-to-RGBA conversion, exactly like `xcap` did.
//! Dirty and move rectangles are NOT used yet, so an animated application costs
//! the same per tick as before. Narrowing that is the obvious next step (see
//! the note in `dda.rs`); it is not implemented here and must not be claimed.
//!
//! `xcap` does not go away. It stays as the fallback for every case duplication
//! cannot serve - a lost device, a rotated display, a forced tick that needs a
//! frame right now on a static screen, and non-Windows builds - so the
//! behaviour Guide already depends on never regresses.

#[cfg(windows)]
mod dda;
mod session;

pub use session::GuideCaptureSession;

use xcap::image::RgbaImage;

/// One tick's worth of pixels, or why there are none.
///
/// The distinction between the last two variants is load-bearing and was got
/// wrong once: "duplication proved nothing was presented" and "duplication
/// could not answer" are completely different facts. Collapsing them makes a
/// failed capture session look like a still screen, so Guide reports `Same`
/// forever and silently stops watching. Only `Unchanged` is evidence.
pub enum CaptureTick {
    Captured(RgbaImage),
    /// Positive proof from duplication that the desktop has not been presented
    /// since the previous tick, so the caller's fingerprint is still accurate.
    Unchanged,
    /// Duplication is unavailable, recovering, failed, or cannot serve this
    /// particular tick. Says NOTHING about the screen. The caller must capture
    /// for real.
    Unavailable,
}

/// Why a persistent capture session stopped working.
///
/// `Lost` is the recoverable one and is expected in normal use: a UAC prompt,
/// a lock screen, a resolution change, a GPU driver reset and a monitor being
/// unplugged all surface as a lost duplication.
pub enum CaptureError {
    Lost,
    Failed(String),
}
