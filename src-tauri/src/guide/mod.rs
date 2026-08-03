pub mod fingerprint;

use std::io::Cursor;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use image::{DynamicImage, ImageFormat, RgbaImage};
use log::{info, warn};
use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Emitter, Manager};
use xcap::Monitor;

use fingerprint::{Classification, Detector, Fingerprint, Verdict as FingerprintVerdict};

const GUIDE_MAGIC: u32 = 0x4449_5547;
const GUIDE_PROTOCOL_VERSION: u16 = 1;
const GUIDE_FIXED_HEADER_LEN: u32 = 43;
const GEOMETRY_HEADER_LEN: usize = 28;
const FORCE_COOLDOWN: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq)]
struct PinnedMonitor {
    id: u32,
    name: String,
}

#[derive(Clone, Debug, PartialEq)]
struct Geometry {
    monitor_id: u32,
    monitor_left_px: i32,
    monitor_top_px: i32,
    monitor_width_px: u32,
    monitor_height_px: u32,
    scale_factor: f32,
    rotation: f32,
    jpeg_width_px: u32,
    jpeg_height_px: u32,
}

impl Geometry {
    fn identity_eq(&self, other: &Self) -> bool {
        self.monitor_id == other.monitor_id
            && self.monitor_width_px == other.monitor_width_px
            && self.monitor_height_px == other.monitor_height_px
            && self.jpeg_width_px == other.jpeg_width_px
            && self.jpeg_height_px == other.jpeg_height_px
            && self.scale_factor.to_bits() == other.scale_factor.to_bits()
            && self.rotation.to_bits() == other.rotation.to_bits()
    }

    fn write_le(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.monitor_left_px.to_le_bytes());
        out.extend_from_slice(&self.monitor_top_px.to_le_bytes());
        out.extend_from_slice(&self.monitor_width_px.to_le_bytes());
        out.extend_from_slice(&self.monitor_height_px.to_le_bytes());
        out.extend_from_slice(&self.scale_factor.to_le_bytes());
        out.extend_from_slice(&self.jpeg_width_px.to_le_bytes());
        out.extend_from_slice(&self.jpeg_height_px.to_le_bytes());
    }
}

#[derive(Clone, Debug)]
struct PendingFrame {
    sequence: u32,
    bytes: Vec<u8>,
    fingerprint: Fingerprint,
    geometry: Geometry,
    epoch: u64,
}

#[derive(Clone, Debug, Default)]
enum FrameLifecycle {
    #[default]
    Idle,
    PendingDelivery(PendingFrame),
    AwaitingResponse(PendingFrame),
}

#[derive(Debug, Default)]
pub struct GuideRuntime {
    monitor: Option<PinnedMonitor>,
    geometry: Option<Geometry>,
    prev_tick: Option<Fingerprint>,
    last_committed: Option<Fingerprint>,
    last_sent_at: Option<Instant>,
    detector: Detector,
    lifecycle: FrameLifecycle,
    dirty: bool,
    sequence: u32,
    session_id: u128,
    epoch: u64,
    capture_in_flight: bool,
    needs_reseed: bool,
}

pub struct GuideRuntimeHandle(pub Mutex<GuideRuntime>);

impl Default for GuideRuntimeHandle {
    fn default() -> Self {
        Self(Mutex::new(GuideRuntime::default()))
    }
}

#[derive(Debug, Default)]
struct GuideToggleState {
    in_flight: bool,
    target_armed: bool,
    generation: u64,
}

#[derive(Default)]
pub struct GuideToggleHandle(Mutex<GuideToggleState>);

fn request_toggle(state: &mut GuideToggleState, currently_armed: bool) -> Option<(bool, u64)> {
    if state.in_flight {
        // The arm operation resolves a monitor asynchronously. Preserve every
        // shortcut press while it is pending so an even number of presses ends
        // off and an odd number ends on.
        state.target_armed = !state.target_armed;
        return None;
    }
    state.in_flight = true;
    state.target_armed = !currently_armed;
    Some((state.target_armed, state.generation))
}

fn finish_toggle(state: &mut GuideToggleState, generation: u64) -> Option<bool> {
    if state.generation != generation {
        return None;
    }
    state.in_flight = false;
    Some(state.target_armed)
}

fn toggle_allows_arm(app: &AppHandle) -> bool {
    app.try_state::<GuideToggleHandle>()
        .map(|toggle| {
            let state = toggle.0.lock().unwrap_or_else(|e| e.into_inner());
            !state.in_flight || state.target_armed
        })
        .unwrap_or(true)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideArmedPayload {
    armed: bool,
    epoch: u64,
    session_id: Option<String>,
}

#[derive(Clone, Copy, Debug)]
#[repr(u8)]
enum EnvelopeVerdict {
    Same = 0,
    Hold = 1,
    Send = 2,
    Pending = 3,
    Skip = 4,
    // A frame the change-filter would NOT have sent (the screen is static), streamed
    // only because the caller forced it - the continuous ~2s Guide cadence. Carries
    // geometry + bytes exactly like Send; the client stamps change:"0" so the backend
    // refreshes its latest frame without firing a proactive nudge.
    SendForced = 5,
}

struct CapturedMonitor {
    image: RgbaImage,
    fingerprint: Fingerprint,
    geometry: Geometry,
}

impl GuideRuntime {
    fn begin_session(&mut self, monitor: PinnedMonitor, epoch: u64, session_id: u128) {
        *self = Self {
            monitor: Some(monitor),
            session_id,
            epoch,
            needs_reseed: true,
            ..Self::default()
        };
    }

    fn clear(&mut self) {
        *self = Self::default();
    }

    fn try_begin_capture(&mut self) -> bool {
        if self.capture_in_flight {
            return false;
        }
        self.capture_in_flight = true;
        true
    }

    fn force_allowed(&self) -> bool {
        self.last_sent_at
            .is_none_or(|sent| sent.elapsed() >= FORCE_COOLDOWN)
    }

    fn commit(&mut self, frame_id: &str, epoch: u64) -> Result<(), String> {
        if self.epoch != epoch {
            return Err("stale Guide epoch".to_string());
        }
        match &self.lifecycle {
            FrameLifecycle::AwaitingResponse(frame)
                if frame.epoch == epoch && self.frame_id(frame.sequence) == frame_id =>
            {
                return Ok(());
            }
            FrameLifecycle::PendingDelivery(frame)
                if frame.epoch == epoch && self.frame_id(frame.sequence) == frame_id => {}
            _ => return Err("Guide frame is not pending delivery".to_string()),
        }
        let FrameLifecycle::PendingDelivery(frame) =
            std::mem::replace(&mut self.lifecycle, FrameLifecycle::Idle)
        else {
            unreachable!();
        };
        self.last_committed = Some(frame.fingerprint.clone());
        self.last_sent_at = Some(Instant::now());
        self.lifecycle = FrameLifecycle::AwaitingResponse(frame);
        Ok(())
    }

    fn ack(&mut self, frame_id: &str, epoch: u64) -> Result<bool, String> {
        if self.epoch != epoch {
            return Err("stale Guide epoch".to_string());
        }
        let matches = match &self.lifecycle {
            FrameLifecycle::AwaitingResponse(frame) => {
                frame.epoch == epoch && self.frame_id(frame.sequence) == frame_id
            }
            _ => false,
        };
        if !matches {
            return Err("Guide response does not match the awaiting frame".to_string());
        }
        self.lifecycle = FrameLifecycle::Idle;
        Ok(std::mem::take(&mut self.dirty))
    }

    fn frame_id(&self, sequence: u32) -> String {
        format!("{:032x}:{sequence}", self.session_id)
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> usize {
        match &self.lifecycle {
            FrameLifecycle::Idle => 0,
            FrameLifecycle::PendingDelivery(frame) | FrameLifecycle::AwaitingResponse(frame) => {
                frame.bytes.len()
            }
        }
    }
}

fn runtime_handle(app: &AppHandle) -> Option<tauri::State<'_, GuideRuntimeHandle>> {
    app.try_state::<GuideRuntimeHandle>()
}

fn resolve_cursor_monitor(app: &AppHandle) -> Result<(i32, i32), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    Ok((cursor.x as i32, cursor.y as i32))
}

fn resolve_monitor(cursor_x: i32, cursor_y: i32) -> Result<PinnedMonitor, String> {
    let monitor = Monitor::from_point(cursor_x, cursor_y).map_err(|e| e.to_string())?;
    Ok(PinnedMonitor {
        id: monitor.id().map_err(|e| e.to_string())?,
        name: monitor.name().map_err(|e| e.to_string())?,
    })
}

fn capture_monitor(pinned: &PinnedMonitor) -> Result<CapturedMonitor, String> {
    let monitor = Monitor::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|monitor| monitor.id().ok() == Some(pinned.id))
        .ok_or_else(|| format!("pinned monitor {} is no longer connected", pinned.name))?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let fingerprint = Fingerprint::from_rgba(&image);
    let geometry = Geometry {
        monitor_id: monitor.id().map_err(|e| e.to_string())?,
        monitor_left_px: monitor.x().map_err(|e| e.to_string())?,
        monitor_top_px: monitor.y().map_err(|e| e.to_string())?,
        monitor_width_px: monitor.width().map_err(|e| e.to_string())?,
        monitor_height_px: monitor.height().map_err(|e| e.to_string())?,
        scale_factor: monitor.scale_factor().map_err(|e| e.to_string())?,
        rotation: monitor.rotation().map_err(|e| e.to_string())?,
        jpeg_width_px: image.width(),
        jpeg_height_px: image.height(),
    };
    Ok(CapturedMonitor {
        image,
        fingerprint,
        geometry,
    })
}

fn encode_jpeg(image: RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    DynamicImage::ImageRgba8(image)
        .into_rgb8()
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn response(
    verdict: EnvelopeVerdict,
    session_id: u128,
    epoch: u64,
    sequence: u32,
    frame: Option<(&Geometry, &[u8])>,
) -> Response {
    let payload_len = frame.map_or(0, |(_, bytes)| GEOMETRY_HEADER_LEN + bytes.len());
    let mut out = Vec::with_capacity(GUIDE_FIXED_HEADER_LEN as usize + payload_len);
    out.extend_from_slice(&GUIDE_MAGIC.to_le_bytes());
    out.extend_from_slice(&GUIDE_PROTOCOL_VERSION.to_le_bytes());
    out.push(verdict as u8);
    out.extend_from_slice(&session_id.to_le_bytes());
    out.extend_from_slice(&epoch.to_le_bytes());
    out.extend_from_slice(&sequence.to_le_bytes());
    out.extend_from_slice(&GUIDE_FIXED_HEADER_LEN.to_le_bytes());
    out.extend_from_slice(&(payload_len as u32).to_le_bytes());
    if let Some((geometry, bytes)) = frame {
        geometry.write_le(&mut out);
        out.extend_from_slice(bytes);
    }
    Response::new(out)
}

fn log_tick(verdict: EnvelopeVerdict, classification: Option<&Classification>) {
    let (changed_tiles, transient_tiles, dist_vs_committed) = classification
        .map(|value| {
            (
                value.changed_tiles,
                value.transient_tiles,
                value.dist_vs_committed,
            )
        })
        .unwrap_or((0, 0, 0.0));
    info!(
        "[Guide] {{verdict:{verdict:?}, changed_tiles:{changed_tiles}, transient_tiles:{transient_tiles}, dist_vs_committed:{dist_vs_committed:.2}}}"
    );
}

/// Whether Guide Mode is armed right now. Read by uia/mod.rs, which widens the
/// structured context walk's budget for a guide turn.
pub(crate) fn is_armed(app: &AppHandle) -> bool {
    armed_payload(app).armed
}

fn armed_payload(app: &AppHandle) -> GuideArmedPayload {
    // Lock order for the rare two-state reads and writes is SecurityState,
    // then GuideRuntime. Neither lock is held across event or window work.
    let Some(security) = crate::security::handle(app) else {
        return GuideArmedPayload {
            armed: false,
            epoch: 0,
            session_id: None,
        };
    };
    let security = security.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtime_handle(app) else {
        return GuideArmedPayload {
            armed: false,
            epoch: security.guide_epoch(),
            session_id: None,
        };
    };
    let runtime = runtime.0.lock().unwrap_or_else(|e| e.into_inner());
    GuideArmedPayload {
        armed: security.guide_armed(),
        epoch: security.guide_epoch(),
        session_id: security
            .guide_armed()
            .then(|| format!("{:032x}", runtime.session_id)),
    }
}

fn emit_armed(app: &AppHandle, payload: GuideArmedPayload) {
    if let Err(error) = app.emit("guide-armed", payload) {
        log::error!("guide: failed to emit guide-armed: {error}");
    }
}

fn complete_arm_transaction(
    security: &mut crate::security::SecurityState,
    runtime: &mut GuideRuntime,
    monitor: Result<PinnedMonitor, String>,
    session_id: u128,
) -> Result<(u64, bool), String> {
    let monitor = monitor?;
    let (epoch, screen_sight_cleared) = security.arm_guide()?;
    runtime.begin_session(monitor, epoch, session_id);
    Ok((epoch, screen_sight_cleared))
}

#[tauri::command]
pub async fn arm_guide(app: AppHandle) -> Result<GuideArmedPayload, String> {
    let (cursor_x, cursor_y) = resolve_cursor_monitor(&app)?;
    let monitor = tauri::async_runtime::spawn_blocking(move || resolve_monitor(cursor_x, cursor_y))
        .await
        .map_err(|e| e.to_string())??;
    let mut session_bytes = [0_u8; 16];
    getrandom::fill(&mut session_bytes).map_err(|e| e.to_string())?;
    let session_id = u128::from_le_bytes(session_bytes);

    let (epoch, screen_sight_cleared) = {
        let security_handle = crate::security::handle(&app)
            .ok_or_else(|| "security state unavailable".to_string())?;
        let mut security = security_handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let runtime_handle =
            runtime_handle(&app).ok_or_else(|| "Guide runtime unavailable".to_string())?;
        let mut runtime = runtime_handle.0.lock().unwrap_or_else(|e| e.into_inner());
        complete_arm_transaction(&mut security, &mut runtime, Ok(monitor), session_id)?
    };

    if screen_sight_cleared {
        crate::security::emit_screen_sight_armed(&app, false);
    }
    let payload = GuideArmedPayload {
        armed: true,
        epoch,
        session_id: Some(format!("{session_id:032x}")),
    };
    // A second hotkey press may have requested cancellation while monitor
    // discovery was in flight. Do not publish a transient armed event that
    // could make the UI light up or make the agent react to a session the user
    // has already turned off.
    if !toggle_allows_arm(&app) {
        clear(&app, false);
        return Ok(armed_payload(&app));
    }
    emit_armed(&app, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn disarm_guide(app: AppHandle) -> GuideArmedPayload {
    clear(&app, true);
    armed_payload(&app)
}

#[tauri::command]
pub fn guide_armed_state(app: AppHandle) -> GuideArmedPayload {
    armed_payload(&app)
}

pub fn clear(app: &AppHandle, emit: bool) {
    if let Some(toggle) = app.try_state::<GuideToggleHandle>() {
        let mut state = toggle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.in_flight = false;
        state.target_armed = false;
    }
    let changed = {
        let Some(security_handle) = crate::security::handle(app) else {
            return;
        };
        let mut security = security_handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(runtime_handle) = runtime_handle(app) else {
            return;
        };
        let mut runtime = runtime_handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let changed = security.disarm_guide();
        runtime.clear();
        changed
    };
    if emit && changed {
        emit_armed(app, armed_payload(app));
    }
}

pub fn on_security_disarmed(app: &AppHandle) {
    if let Some(runtime) = runtime_handle(app) {
        runtime.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    emit_armed(app, armed_payload(app));
}

pub fn toggle(app: &AppHandle) {
    let currently_armed = armed_payload(app).armed;
    let Some(toggle) = app.try_state::<GuideToggleHandle>() else {
        warn!("guide: toggle state unavailable");
        return;
    };
    let requested = {
        let mut state = toggle.0.lock().unwrap_or_else(|e| e.into_inner());
        request_toggle(&mut state, currently_armed)
    };
    match requested {
        Some((false, _)) => {
            clear(app, true);
        }
        Some((true, generation)) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = arm_guide(app.clone()).await {
                    warn!("guide: hotkey arm failed: {error}");
                    if let Some(toggle) = app.try_state::<GuideToggleHandle>() {
                        let mut state = toggle.0.lock().unwrap_or_else(|e| e.into_inner());
                        state.generation = state.generation.wrapping_add(1);
                        state.in_flight = false;
                    }
                    return;
                }
                let should_remain_armed = app
                    .try_state::<GuideToggleHandle>()
                    .map(|toggle| {
                        let mut state = toggle.0.lock().unwrap_or_else(|e| e.into_inner());
                        finish_toggle(&mut state, generation)
                    })
                    .flatten()
                    .unwrap_or(false);
                if !should_remain_armed {
                    clear(&app, true);
                }
            });
        }
        None => {}
    }
}

#[cfg(test)]
mod toggle_tests {
    use super::{finish_toggle, request_toggle, GuideToggleState};

    #[test]
    fn rapid_toggles_preserve_the_final_requested_state() {
        let mut state = GuideToggleState::default();
        assert_eq!(request_toggle(&mut state, false), Some((true, 0)));
        assert_eq!(request_toggle(&mut state, false), None);
        assert_eq!(finish_toggle(&mut state, 0), Some(false));
    }

    #[test]
    fn a_third_toggle_during_arm_requests_armed() {
        let mut state = GuideToggleState::default();
        assert_eq!(request_toggle(&mut state, false), Some((true, 0)));
        assert_eq!(request_toggle(&mut state, false), None);
        assert_eq!(request_toggle(&mut state, false), None);
        assert_eq!(finish_toggle(&mut state, 0), Some(true));
    }

    #[test]
    fn armed_payload_serializes_the_session_id_for_react() {
        let payload = super::GuideArmedPayload {
            armed: true,
            epoch: 7,
            session_id: Some("100f0e0d0c0b0a090807060504030201".to_string()),
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["sessionId"], "100f0e0d0c0b0a090807060504030201");
        assert!(value.get("session_id").is_none());
    }
}

#[tauri::command]
pub async fn capture_guide_frame(
    app: AppHandle,
    epoch: u64,
    force: bool,
) -> Result<Response, String> {
    let ticket = crate::security::authorize_guide(&app, epoch)?;
    if crate::overlay::is_pointing(&app) {
        let (session_id, sequence) = runtime_handle(&app)
            .map(|handle| {
                let mut runtime = handle.0.lock().unwrap_or_else(|e| e.into_inner());
                runtime.needs_reseed = true;
                (runtime.session_id, runtime.sequence)
            })
            .unwrap_or((0, 0));
        log_tick(EnvelopeVerdict::Skip, None);
        return Ok(response(
            EnvelopeVerdict::Skip,
            session_id,
            epoch,
            sequence,
            None,
        ));
    }

    let (pinned, session_id, sequence, awaiting) = {
        let handle = runtime_handle(&app).ok_or_else(|| "Guide runtime unavailable".to_string())?;
        let mut runtime = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if runtime.epoch != epoch {
            return Err("stale Guide caller".to_string());
        }
        if !runtime.try_begin_capture() {
            return Ok(response(
                EnvelopeVerdict::Skip,
                runtime.session_id,
                runtime.epoch,
                runtime.sequence,
                None,
            ));
        }
        if let FrameLifecycle::PendingDelivery(frame) = &runtime.lifecycle {
            return Ok(response(
                EnvelopeVerdict::Pending,
                runtime.session_id,
                runtime.epoch,
                frame.sequence,
                Some((&frame.geometry, &frame.bytes)),
            ));
        }
        let awaiting = matches!(runtime.lifecycle, FrameLifecycle::AwaitingResponse(_));
        if awaiting && force {
            runtime.dirty = true;
        }
        (
            runtime
                .monitor
                .clone()
                .ok_or_else(|| "Guide monitor is not pinned".to_string())?,
            runtime.session_id,
            runtime.sequence,
            awaiting,
        )
    };

    let captured = tauri::async_runtime::spawn_blocking(move || capture_monitor(&pinned))
        .await
        .map_err(|e| e.to_string())??;
    if let Err(error) =
        crate::security::recheck(&app, crate::security::Operation::CaptureGuide, &ticket)
    {
        if let Some(handle) = runtime_handle(&app) {
            handle
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .capture_in_flight = false;
        }
        return Err(error);
    }

    let classification: Option<Classification>;
    let should_encode = {
        let handle = runtime_handle(&app).ok_or_else(|| "Guide runtime unavailable".to_string())?;
        let mut runtime = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if runtime.epoch != epoch || runtime.session_id != session_id {
            runtime.capture_in_flight = false;
            return Err("Guide session changed during capture".to_string());
        }
        if captured.fingerprint.is_blank() {
            runtime.capture_in_flight = false;
            log_tick(EnvelopeVerdict::Skip, None);
            return Ok(response(
                EnvelopeVerdict::Skip,
                session_id,
                epoch,
                sequence,
                None,
            ));
        }
        let geometry_changed = runtime
            .geometry
            .as_ref()
            .is_some_and(|geometry| !geometry.identity_eq(&captured.geometry));
        if geometry_changed {
            runtime.last_committed = None;
            runtime.detector.reset();
            runtime.needs_reseed = true;
        }
        runtime.geometry = Some(captured.geometry.clone());
        if runtime.needs_reseed || runtime.prev_tick.is_none() {
            runtime.prev_tick = Some(captured.fingerprint.clone());
            runtime.needs_reseed = false;
            runtime.capture_in_flight = false;
            let verdict = if awaiting {
                EnvelopeVerdict::Pending
            } else {
                EnvelopeVerdict::Hold
            };
            log_tick(verdict, None);
            if let FrameLifecycle::AwaitingResponse(frame) = &runtime.lifecycle {
                return Ok(response(
                    verdict,
                    session_id,
                    epoch,
                    frame.sequence,
                    Some((&frame.geometry, &frame.bytes)),
                ));
            }
            return Ok(response(verdict, session_id, epoch, sequence, None));
        }

        let previous = runtime.prev_tick.clone().expect("checked above");
        let committed = runtime.last_committed.clone();
        let result =
            runtime
                .detector
                .classify(&previous, &captured.fingerprint, committed.as_ref());
        runtime.prev_tick = Some(captured.fingerprint.clone());
        classification = Some(result.clone());

        if awaiting {
            if result.verdict == FingerprintVerdict::ChangedStable {
                runtime.dirty = true;
            }
            // A per-frame ack can move the lifecycle out of AwaitingResponse while
            // this forced capture was still in flight (the fast per-frame ack races
            // the ~2s force tick). Only re-send the retained pending frame if it is
            // still awaiting; otherwise it was already acked, so fall through and
            // treat this tick as a fresh capture instead of hitting an unreachable
            // panic (see the 2026-07-24 mod.rs:704 crash).
            if matches!(runtime.lifecycle, FrameLifecycle::AwaitingResponse(_)) {
                runtime.capture_in_flight = false;
                let FrameLifecycle::AwaitingResponse(frame) = &runtime.lifecycle else {
                    unreachable!()
                };
                log_tick(EnvelopeVerdict::Pending, classification.as_ref());
                return Ok(response(
                    EnvelopeVerdict::Pending,
                    session_id,
                    epoch,
                    frame.sequence,
                    Some((&frame.geometry, &frame.bytes)),
                ));
            }
        }

        let force_allowed = force && runtime.force_allowed();
        force_allowed || result.verdict == FingerprintVerdict::ChangedStable
    };

    if !should_encode {
        let handle = runtime_handle(&app).ok_or_else(|| "Guide runtime unavailable".to_string())?;
        let mut runtime = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        runtime.capture_in_flight = false;
        let verdict = match classification.as_ref().map(|value| value.verdict) {
            Some(FingerprintVerdict::Hold) => EnvelopeVerdict::Hold,
            _ => EnvelopeVerdict::Same,
        };
        log_tick(verdict, classification.as_ref());
        return Ok(response(verdict, session_id, epoch, sequence, None));
    }

    let geometry = captured.geometry;
    let fingerprint = captured.fingerprint;
    let jpeg = tauri::async_runtime::spawn_blocking(move || encode_jpeg(captured.image))
        .await
        .map_err(|e| e.to_string())??;
    crate::security::recheck(&app, crate::security::Operation::CaptureGuide, &ticket)?;

    // A real (tile-classified) change sends Send and drives a proactive nudge; a
    // force-only send on a static screen sends SendForced so the backend refreshes
    // its latest frame without nudging. Both carry geometry + bytes identically.
    let changed = matches!(
        classification.as_ref().map(|value| value.verdict),
        Some(FingerprintVerdict::ChangedStable)
    );
    let send_verdict = if changed {
        EnvelopeVerdict::Send
    } else {
        EnvelopeVerdict::SendForced
    };
    let response = {
        let handle = runtime_handle(&app).ok_or_else(|| "Guide runtime unavailable".to_string())?;
        let mut runtime = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if runtime.epoch != epoch || runtime.session_id != session_id {
            runtime.capture_in_flight = false;
            return Err("Guide session changed during encoding".to_string());
        }
        if !matches!(runtime.lifecycle, FrameLifecycle::Idle) {
            runtime.capture_in_flight = false;
            return Err("Guide lifecycle changed during encoding".to_string());
        }
        runtime.sequence = runtime.sequence.saturating_add(1);
        let frame = PendingFrame {
            sequence: runtime.sequence,
            bytes: jpeg,
            fingerprint,
            geometry,
            epoch,
        };
        let result = response(
            send_verdict,
            runtime.session_id,
            runtime.epoch,
            frame.sequence,
            Some((&frame.geometry, &frame.bytes)),
        );
        runtime.lifecycle = FrameLifecycle::PendingDelivery(frame);
        runtime.capture_in_flight = false;
        result
    };
    log_tick(send_verdict, classification.as_ref());
    Ok(response)
}

#[tauri::command]
pub fn commit_guide_frame(app: AppHandle, frame_id: String, epoch: u64) -> Result<(), String> {
    crate::security::authorize_guide(&app, epoch)?;
    let handle = runtime_handle(&app).ok_or_else(|| "Guide runtime unavailable".to_string())?;
    handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .commit(&frame_id, epoch)?;
    crate::security::note_capture(&app);
    Ok(())
}

#[tauri::command]
pub fn ack_guide_response(app: AppHandle, frame_id: String, epoch: u64) -> Result<bool, String> {
    crate::security::authorize_guide(&app, epoch)?;
    let handle = runtime_handle(&app).ok_or_else(|| "Guide runtime unavailable".to_string())?;
    let result = handle
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ack(&frame_id, epoch);
    result
}

/// (process stem, window id, window title) for the foreground window.
/// Shared with `uia::tree`, which needs the same app identity alongside the
/// accessibility snapshot rather than a second copy of this Win32 dance.
#[cfg(windows)]
pub(crate) fn foreground_window_details() -> (String, String, String) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return (String::new(), String::new(), String::new());
        }
        let window_id = format!("{:x}", hwnd.0 as usize);
        let title_len = GetWindowTextLengthW(hwnd);
        let title = if title_len > 0 {
            let mut buffer = vec![0_u16; title_len as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut buffer);
            String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
        } else {
            String::new()
        };
        let mut pid = 0_u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return (String::new(), window_id, title);
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return (String::new(), window_id, title);
        };
        let mut path_buffer = vec![0_u16; 1024];
        let mut path_len = path_buffer.len() as u32;
        let process_name = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(path_buffer.as_mut_ptr()),
            &mut path_len,
        )
        .ok()
        .and_then(|_| {
            std::path::Path::new(&String::from_utf16_lossy(&path_buffer[..path_len as usize]))
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
        })
        .unwrap_or_default();
        let _ = CloseHandle(process);
        (process_name, window_id, title)
    }
}

#[cfg(not(windows))]
pub(crate) fn foreground_window_details() -> (String, String, String) {
    (String::new(), String::new(), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry() -> Geometry {
        Geometry {
            monitor_id: 1,
            monitor_left_px: 0,
            monitor_top_px: 0,
            monitor_width_px: 1920,
            monitor_height_px: 1080,
            scale_factor: 1.0,
            rotation: 0.0,
            jpeg_width_px: 1920,
            jpeg_height_px: 1080,
        }
    }

    fn fingerprint() -> Fingerprint {
        Fingerprint::from_rgba(&RgbaImage::from_pixel(
            64,
            36,
            image::Rgba([40, 40, 40, 255]),
        ))
    }

    fn pending(sequence: u32, epoch: u64) -> PendingFrame {
        PendingFrame {
            sequence,
            bytes: vec![1, 2, 3],
            fingerprint: fingerprint(),
            geometry: geometry(),
            epoch,
        }
    }

    #[test]
    fn pending_commit_ack_releases_retained_bytes() {
        let mut runtime = GuideRuntime::default();
        runtime.session_id = 9;
        runtime.epoch = 4;
        runtime.lifecycle = FrameLifecycle::PendingDelivery(pending(1, 4));
        assert_eq!(runtime.retained_bytes(), 3);
        runtime
            .commit("00000000000000000000000000000009:1", 4)
            .unwrap();
        assert!(matches!(
            runtime.lifecycle,
            FrameLifecycle::AwaitingResponse(_)
        ));
        assert_eq!(runtime.retained_bytes(), 3);
        assert!(!runtime
            .ack("00000000000000000000000000000009:1", 4)
            .unwrap());
        assert_eq!(runtime.retained_bytes(), 0);
        assert!(matches!(runtime.lifecycle, FrameLifecycle::Idle));
    }

    #[test]
    fn timeout_path_retains_bytes_until_ack() {
        let mut runtime = GuideRuntime::default();
        runtime.session_id = 9;
        runtime.epoch = 4;
        runtime.lifecycle = FrameLifecycle::AwaitingResponse(pending(2, 4));
        assert_eq!(runtime.retained_bytes(), 3);
    }

    #[test]
    fn stale_ack_is_rejected_without_freeing_bytes() {
        let mut runtime = GuideRuntime::default();
        runtime.session_id = 9;
        runtime.epoch = 4;
        runtime.lifecycle = FrameLifecycle::AwaitingResponse(pending(2, 4));
        assert!(runtime
            .ack("00000000000000000000000000000009:1", 4)
            .is_err());
        assert!(runtime
            .ack("00000000000000000000000000000009:2", 3)
            .is_err());
        assert_eq!(runtime.retained_bytes(), 3);
    }

    #[test]
    fn clear_frees_every_lifecycle_state() {
        let mut runtime = GuideRuntime::default();
        runtime.lifecycle = FrameLifecycle::PendingDelivery(pending(1, 1));
        runtime.clear();
        assert_eq!(runtime.retained_bytes(), 0);
        runtime.lifecycle = FrameLifecycle::AwaitingResponse(pending(2, 1));
        runtime.clear();
        assert_eq!(runtime.retained_bytes(), 0);
    }

    #[test]
    fn geometry_identity_includes_monitor_dimensions_scale_rotation_and_jpeg() {
        let original = geometry();
        let mut changed = original.clone();
        changed.scale_factor = 1.25;
        assert!(!original.identity_eq(&changed));
        changed = original.clone();
        changed.jpeg_width_px = 1280;
        assert!(!original.identity_eq(&changed));
    }

    #[test]
    fn monitor_resolution_failure_leaves_arm_transaction_untouched() {
        let mut security = crate::security::SecurityState::default();
        security.set_session(true, Some("uid-1".to_string()));
        let mut runtime = GuideRuntime::default();
        let result = complete_arm_transaction(
            &mut security,
            &mut runtime,
            Err("monitor unavailable".to_string()),
            10,
        );
        assert!(result.is_err());
        assert!(!security.guide_armed());
        assert!(runtime.monitor.is_none());
        assert_eq!(runtime.session_id, 0);
    }

    #[test]
    fn overlapping_capture_is_rejected() {
        let mut runtime = GuideRuntime::default();
        assert!(runtime.try_begin_capture());
        assert!(!runtime.try_begin_capture());
    }

    #[test]
    fn force_capture_respects_cooldown() {
        let mut runtime = GuideRuntime::default();
        assert!(runtime.force_allowed());
        runtime.last_sent_at = Some(Instant::now());
        assert!(!runtime.force_allowed());
        runtime.last_sent_at = Some(Instant::now() - FORCE_COOLDOWN);
        assert!(runtime.force_allowed());
    }
}
