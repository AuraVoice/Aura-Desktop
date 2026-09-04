use std::io::Cursor;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use log::{info, warn};
use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Emitter, Manager};
use xcap::Monitor;

/// Longest edge the model ever needs. A 2880x1800 panel encodes to ~1.6MB and
/// roughly 2.5k vision tokens per turn, and the backend downscaled it to
/// exactly this anyway - so the capture is resized here instead, before the
/// JPEG encode, the IPC copy, the LiveKit upload AND the encrypted write. Every
/// one of those was paying for pixels the model never saw.
const MODEL_FRAME_LONG_EDGE_PX: u32 = 1280;

/// Matches the backend's own encode quality, so a frame that survives the
/// safety-net downscale there looks the same as one that skipped it.
///
/// `pub(crate)` so Guide encodes at the same quality as the per-turn path
/// rather than the `image` crate's default (see `guide::encode_jpeg`).
pub(crate) const MODEL_FRAME_JPEG_QUALITY: u8 = 82;

/// Geometry of one captured frame - carried as a fixed-width binary header in
/// front of the JPEG bytes (see `write_le`) so an `element.point` response
/// naming a JPEG-space coordinate can be mapped back onto the real screen.
/// Direct port of `ScreenFrameGeometry` (desktop_screen_capture_service.dart).
/// Guide wraps this same struct for its envelope, so there is exactly one
/// Rust serializer for the layout the TS `DataView` readers parse.
#[derive(Clone, Debug)]
pub(crate) struct ScreenFrameGeometry {
    pub(crate) monitor_left_px: i32,
    pub(crate) monitor_top_px: i32,
    pub(crate) monitor_width_px: u32,
    pub(crate) monitor_height_px: u32,
    pub(crate) scale_factor: f32,
    pub(crate) jpeg_width_px: u32,
    pub(crate) jpeg_height_px: u32,
}

/// Byte length of the header `write_le` produces - 7 little-endian 4-byte
/// fields. `useScreenSight.ts`'s `DataView` reads must match this layout.
pub(crate) const GEOMETRY_HEADER_LEN: usize = 4 * 7;

const LEGACY_SCREENSHOTS_DIR: &str = "screenshots";

struct CapturedFrame {
    payload: Vec<u8>,
    jpeg_bytes: Vec<u8>,
    stages: CaptureStages,
}

impl CapturedFrame {
    fn into_response(self) -> Response {
        Response::new(self.payload)
    }
}

/// Per-stage timings for one capture, emitted as a `capture-stages` event just
/// before the command returns. Deliberately carried on an event rather than in
/// the response body: the 28-byte geometry header is mirrored in Rust, three
/// TypeScript `DataView` readers and the Guide envelope, and widening it to
/// carry telemetry would be a wire change for no functional gain.
///
/// Nothing here can identify what was on screen: durations, byte counts and
/// pixel dimensions only.
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStages {
    turn_context_id: String,
    native_capture_ms: u64,
    resize_ms: u64,
    jpeg_encode_ms: u64,
    persistence_enqueue_ms: u64,
    /// Only "after" exists, and that is the point: the frame is resized BEFORE
    /// it is ever encoded, so a full-resolution JPEG is never produced and its
    /// size cannot be measured without doing the work this change removed. The
    /// source/output pixel dimensions below carry the shrink instead.
    jpeg_bytes_after: u64,
    source_width_px: u32,
    source_height_px: u32,
    jpeg_width_px: u32,
    jpeg_height_px: u32,
    resized: bool,
}

impl ScreenFrameGeometry {
    pub(crate) fn write_le(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.monitor_left_px.to_le_bytes());
        out.extend_from_slice(&self.monitor_top_px.to_le_bytes());
        out.extend_from_slice(&self.monitor_width_px.to_le_bytes());
        out.extend_from_slice(&self.monitor_height_px.to_le_bytes());
        out.extend_from_slice(&self.scale_factor.to_le_bytes());
        out.extend_from_slice(&self.jpeg_width_px.to_le_bytes());
        out.extend_from_slice(&self.jpeg_height_px.to_le_bytes());
    }
}

/// The cursor position in whatever space `xcap`'s `Monitor::from_point` wants,
/// which is NOT the same space on both platforms. Win32's `MonitorFromPoint`
/// takes physical pixels; CoreGraphics' `CGGetDisplaysWithPoint` takes points.
/// Handing one the other's numbers is silent: the lookup simply matches no
/// display and every capture fails with "Monitor not found".
#[cfg(not(target_os = "macos"))]
pub(crate) fn cursor_point(app: &AppHandle) -> Result<(i32, i32), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    Ok((cursor.x as i32, cursor.y as i32))
}

/// Read straight from CoreGraphics rather than through Tauri.
///
/// `window.cursor_position()` is wrong here twice over. tao reads
/// `NSEvent.mouseLocation` (Cocoa, bottom-left origin, points), flips it to
/// top-left correctly, and then multiplies by the primary display's backing
/// scale to satisfy the Windows-shaped "physical pixels" contract. On a Retina
/// Mac that hands `CGGetDisplaysWithPoint` a point twice as far right and down
/// as the real cursor, so it lands outside the display unless the pointer
/// happens to be in the top-left quadrant. It also flips against the MAIN
/// display's height only, so the Y is wrong on any second display that is not
/// vertically aligned with the primary.
///
/// `CGEvent::location` is already in the exact global display space
/// `Monitor::from_point` looks up in: top-left origin, points, all displays.
/// No conversion, and nothing to get wrong on a multi-monitor arrangement.
#[cfg(target_os = "macos")]
pub(crate) fn cursor_point(_app: &AppHandle) -> Result<(i32, i32), String> {
    use objc2_core_graphics::CGEvent;

    let event = CGEvent::new(None).ok_or_else(|| "could not read the cursor position".to_string())?;
    let point = CGEvent::location(Some(&event));
    Ok((point.x as i32, point.y as i32))
}

/// The shared middle of every screen-capture command: cursor -> blocking
/// capture -> security recheck. Each command keeps its own `authorize` (and
/// any extra gates between it and the capture) so error precedence is
/// unchanged, and keeps its own persistence tail. The recheck runs AFTER the
/// capture on purpose: a disarm or sign-out that lands during the
/// capture+encode window drops the frame instead of returning it.
async fn captured_under(
    app: &AppHandle,
    op: crate::security::Operation,
    ticket: &crate::security::Ticket,
) -> Result<CapturedFrame, String> {
    let (cursor_x, cursor_y) = cursor_point(app)?;
    let frame = tauri::async_runtime::spawn_blocking(move || capture_frame(cursor_x, cursor_y))
        .await
        .map_err(|e| e.to_string())??;
    crate::security::recheck(app, op, ticket)?;
    Ok(frame)
}

/// Captures the monitor the main window (or, once pointing lands, the cursor)
/// currently sits on, encoded as JPEG. Used only for an explicit screen-sight
/// arm/turn-start capture or the one-shot first-look demo - never on a timer
/// or in the background.
///
/// Async so the capture/encode below (`capture_frame`) runs on a blocking
/// thread rather than Tauri's main thread: a non-async command executes
/// in-line on the same thread that pumps the window's message loop, and
/// xcap's capture plus JPEG encoding is slow enough (worse on 4K/multi-monitor
/// or debug builds) that it was tripping Windows' "Not Responding" state.
#[tauri::command]
pub async fn capture_cursor_display_with_geometry(
    app: AppHandle,
    turn_context_id: Option<String>,
) -> Result<Response, String> {
    // Native authorization, not the frontend's armed boolean: capture needs a
    // signed-in session, a live voice call, and screen sight armed - all
    // tracked in security.rs, all cleared on sign-out/disconnect/restart.
    let ticket = crate::security::authorize(&app, crate::security::Operation::CaptureScreen)?;
    let frame = captured_under(&app, crate::security::Operation::CaptureScreen, &ticket).await?;
    // An explicit capture is something the user asked for, so it keeps the
    // synchronous write: the command only succeeds once the frame is safely on
    // disk. Only the incidental per-turn capture below trades that for latency.
    let persistence_app = app.clone();
    let mut frame = tauri::async_runtime::spawn_blocking(move || {
        crate::screenshot_store::save_capture(&persistence_app, "explicit", &frame.jpeg_bytes)?;
        Ok::<CapturedFrame, String>(frame)
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::security::note_capture(&app);
    frame.stages.turn_context_id = turn_context_id.unwrap_or_default();
    emit_capture_stages(&app, &frame.stages);
    Ok(frame.into_response())
}

/// One frame for an explicit Interview Companion Screen Sight action. Unlike
/// voice screen sight and turn capture, this path never writes or queues the
/// JPEG. The active interview and auth epoch are checked both before and after
/// capture so stop, sign-out, or account switch drops an in-flight frame.
#[tauri::command]
pub async fn capture_interview_screen_with_geometry(
    app: AppHandle,
) -> Result<Response, String> {
    let ticket = crate::security::authorize(
        &app,
        crate::security::Operation::CaptureInterviewScreen,
    )?;
    if !crate::interview::is_active(&app) {
        return Err("Interview Companion is not active.".to_string());
    }
    let frame = captured_under(
        &app,
        crate::security::Operation::CaptureInterviewScreen,
        &ticket,
    )
    .await?;
    if !crate::interview::is_active(&app) {
        return Err("Interview Companion stopped during screen capture.".to_string());
    }
    emit_capture_stages(&app, &frame.stages);
    Ok(frame.into_response())
}

/// The per-spoken-turn capture. Unlike the explicit capture above, this one
/// hands persistence to the background queue and returns immediately: the
/// frame's job is to reach the model, and making the user wait on AES-GCM plus
/// a directory prune before it could even start uploading bought nothing.
#[tauri::command]
pub async fn capture_turn_screen_with_geometry(
    app: AppHandle,
    turn_context_id: Option<String>,
) -> Result<Response, String> {
    let ticket = crate::security::authorize(&app, crate::security::Operation::CaptureTurnScreen)?;
    let mut frame =
        captured_under(&app, crate::security::Operation::CaptureTurnScreen, &ticket).await?;

    let enqueue_started = Instant::now();
    #[cfg(windows)]
    {
        use tauri::Manager as _;
        if let Some(queue) = app.try_state::<crate::screenshot_store::PersistenceQueue>() {
            queue.enqueue("turn", frame.jpeg_bytes.clone());
        }
    }
    frame.stages.persistence_enqueue_ms = enqueue_started.elapsed().as_millis() as u64;

    crate::security::note_capture(&app);
    frame.stages.turn_context_id = turn_context_id.unwrap_or_default();
    emit_capture_stages(&app, &frame.stages);
    Ok(frame.into_response())
}

// ── Chat screen context ─────────────────────────────────────────────────────
//
// The text chat remembers which monitor was active when its hotkey fired, but
// captures no pixels until the user turns on the composer attachment. Two rules
// make this different from every other capture path in this file:
//
//   - It is NEVER persisted. The attachment is held only in memory until the
//     user sends it, removes it, or closes chat.
//   - The source monitor is remembered BEFORE the overlay takes foreground
//     (see overlay::summon_chat), so a later opt-in capture still points at the
//     app the user came from rather than whichever monitor holds the composer.

/// Header in front of the JPEG in `take_chat_capture`'s response: two u32s and
/// one i64, little-endian, read by a `DataView` in chatScreenCapture.ts.
const CHAT_CAPTURE_HEADER_LEN: usize = 4 + 4 + 8;

struct PendingChatCapture {
    jpeg: Vec<u8>,
    width_px: u32,
    height_px: u32,
    captured_at_ms: i64,
}

#[derive(Default)]
struct ChatCaptureState {
    pending: Option<PendingChatCapture>,
    /// A point on the monitor the user was working on when chat was summoned.
    /// Kept so a re-arm later in the session captures the same screen rather
    /// than whichever monitor the overlay happens to sit on.
    source_point: Option<(i32, i32)>,
}

#[derive(Default)]
pub struct ChatCaptureHandle(Mutex<ChatCaptureState>);

fn chat_state(app: &AppHandle) -> Option<tauri::State<'_, ChatCaptureHandle>> {
    app.try_state::<ChatCaptureHandle>()
}

/// Captures the given monitor point into the pending buffer.
///
/// A failure still leaves the buffer empty rather than breaking chat, so a
/// message always goes out with or without a picture. What changed is that the
/// reason is now RETURNED as well as logged: arming the eye and silently
/// getting nothing looked identical to a working capture, so a broken capture
/// path went unnoticed until someone read the log.
async fn capture_into_pending(app: AppHandle, point: (i32, i32)) -> Result<(), String> {
    let ticket = match crate::security::authorize(&app, crate::security::Operation::CaptureChatScreen)
    {
        Ok(ticket) => ticket,
        Err(e) => {
            info!("screenshot: chat capture not authorized ({e})");
            return Err(e);
        }
    };

    let (x, y) = point;
    let frame = match tauri::async_runtime::spawn_blocking(move || capture_frame(x, y)).await {
        Ok(Ok(frame)) => frame,
        Ok(Err(e)) => {
            warn!("screenshot: chat capture failed: {e}");
            return Err(e);
        }
        Err(e) => {
            warn!("screenshot: chat capture thread failed: {e}");
            return Err(e.to_string());
        }
    };
    // A sign-out that landed during the capture drops the frame, exactly as the
    // voice paths do - an account switch must never hand B a picture taken
    // under A.
    if let Err(e) = crate::security::recheck(&app, crate::security::Operation::CaptureChatScreen, &ticket)
    {
        info!("screenshot: chat capture dropped after capture ({e})");
        return Err(e);
    }

    if let Some(handle) = chat_state(&app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.pending = Some(PendingChatCapture {
            width_px: frame.stages.jpeg_width_px,
            height_px: frame.stages.jpeg_height_px,
            jpeg: frame.jpeg_bytes,
            captured_at_ms: crate::util::now_ms(),
        });
        state.source_point = Some(point);
    }
    Ok(())
}

/// Called from `overlay::summon_chat` while the user's own app is still the
/// foreground window. Remembers only the source monitor; capture remains off
/// until the user enables the attachment in the composer.
pub fn prepare_chat_capture(app: &AppHandle, point: (i32, i32)) {
    if let Some(handle) = chat_state(app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.pending = None;
        state.source_point = Some(point);
    }
}

/// Drops any pending frame. Called when the user removes the chip, closes the
/// slot, sends the message, or signs out.
pub fn clear_chat_capture(app: &AppHandle) {
    if let Some(handle) = chat_state(app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.pending = None;
    }
}

/// The pending frame, as the `CHAT_CAPTURE_HEADER_LEN`-byte header followed by
/// the JPEG bytes. An empty response means nothing is pending. Raw bytes rather
/// than a serialized struct: Tauri encodes a `Vec<u8>` field as a JSON array of
/// numbers, which would turn a 200 KB frame into roughly 700 KB of text.
#[tauri::command]
pub fn take_chat_capture(app: AppHandle) -> Response {
    let Some(handle) = chat_state(&app) else {
        return Response::new(Vec::new());
    };
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some(pending) = state.pending.as_ref() else {
        return Response::new(Vec::new());
    };
    let mut payload = Vec::with_capacity(CHAT_CAPTURE_HEADER_LEN + pending.jpeg.len());
    payload.extend_from_slice(&pending.width_px.to_le_bytes());
    payload.extend_from_slice(&pending.height_px.to_le_bytes());
    payload.extend_from_slice(&pending.captured_at_ms.to_le_bytes());
    payload.extend_from_slice(&pending.jpeg);
    Response::new(payload)
}

/// Re-captures the screen the chat was summoned over. Used when the user
/// re-arms the toggle, and when the pending frame has gone stale under the
/// composer. Awaits the capture so the caller can `take_chat_capture` straight
/// after and be sure it is looking at the new frame.
#[tauri::command]
pub async fn refresh_chat_capture(app: AppHandle) -> Result<(), String> {
    let point = {
        let Some(handle) = chat_state(&app) else {
            return Err("chat capture state unavailable".to_string());
        };
        let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.source_point
    };
    // No remembered point means chat was opened without going through the
    // hotkey, so the cursor's monitor is the only signal available.
    let point = match point {
        Some(point) => point,
        None => cursor_point(&app)?,
    };
    capture_into_pending(app, point).await
}

#[tauri::command]
pub fn discard_chat_capture(app: AppHandle) {
    clear_chat_capture(&app);
}

/// Publishes the stage timings for one capture. Failing to emit telemetry must
/// never fail a capture, so the result is deliberately dropped.
fn emit_capture_stages(app: &AppHandle, stages: &CaptureStages) {
    // turn_context_id joins this line to the JS turn_context_upload event and
    // the worker's receipt logs; without it a capture log entry could not be
    // attributed to a turn at all.
    info!(
        "[Capture] {{turn_context_id:{}, native_capture_ms:{}, resize_ms:{}, jpeg_encode_ms:{}, \
         persistence_enqueue_ms:{}, jpeg_bytes_after:{}, source_px:{}x{}, jpeg_px:{}x{}}}",
        stages.turn_context_id,
        stages.native_capture_ms,
        stages.resize_ms,
        stages.jpeg_encode_ms,
        stages.persistence_enqueue_ms,
        stages.jpeg_bytes_after,
        stages.source_width_px,
        stages.source_height_px,
        stages.jpeg_width_px,
        stages.jpeg_height_px,
    );
    let _ = app.emit(crate::events::CAPTURE_STAGES, stages);
}

/// Removes plaintext turn screenshots written by v0.3.0 before turn capture
/// became memory-only. Runs once per process on a blocking worker.
pub fn startup_maintenance(app: &AppHandle) {
    let Ok(base_dir) = app.path().app_local_data_dir() else {
        warn!("screenshot maintenance: app-local data directory unavailable");
        return;
    };
    tauri::async_runtime::spawn_blocking(move || match remove_legacy_screenshots(&base_dir) {
        Ok(true) => info!("screenshot maintenance: removed legacy plaintext turn captures"),
        Ok(false) => {}
        Err(e) => warn!("screenshot maintenance: failed to remove legacy captures: {e}"),
    });
}

fn remove_legacy_screenshots(base_dir: &Path) -> Result<bool, String> {
    let screenshots_dir = base_dir.join(LEGACY_SCREENSHOTS_DIR);
    if !screenshots_dir.exists() {
        return Ok(false);
    }
    std::fs::remove_dir_all(screenshots_dir).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Fails loudly when macOS has not granted Screen Recording.
///
/// Without this the denial is invisible rather than fatal: CoreGraphics does
/// not error, it returns a frame containing only the desktop wallpaper and this
/// app's own windows. The capture "succeeds" and the wrong image is what
/// reaches the model. Preflight only, never request - the prompt is one-shot
/// per app identity and macOS ignores every later call, so asking here would
/// burn it silently in the background instead of at a moment the user can
/// connect to what they just clicked.
#[cfg(target_os = "macos")]
fn screen_capture_permitted() -> Result<(), String> {
    if objc2_core_graphics::CGPreflightScreenCaptureAccess() {
        return Ok(());
    }
    // The "permission_denied:" prefix is a machine contract: the capture hook
    // parses it to pick the reason it reports to the voice worker, and shows
    // the human half after the colon. Keep the prefix stable.
    Err("permission_denied: Screen Recording is off for Aura. Turn it on in System Settings > Privacy & Security > Screen Recording, then restart Aura.".to_string())
}

#[cfg(not(target_os = "macos"))]
fn screen_capture_permitted() -> Result<(), String> {
    Ok(())
}

/// Returns a raw IPC response: the `GEOMETRY_HEADER_LEN`-byte geometry header
/// followed directly by the JPEG bytes, so the frontend reads it as an
/// `ArrayBuffer` with no base64 encode/decode round trip.
fn capture_frame(cursor_x: i32, cursor_y: i32) -> Result<CapturedFrame, String> {
    let mut stages = CaptureStages::default();

    screen_capture_permitted()?;

    let capture_started = Instant::now();
    let monitor = Monitor::from_point(cursor_x, cursor_y).map_err(|e| e.to_string())?;
    let captured = monitor.capture_image().map_err(|e| e.to_string())?;
    let rgb_image = image::DynamicImage::ImageRgba8(captured).into_rgb8();
    stages.native_capture_ms = capture_started.elapsed().as_millis() as u64;
    stages.source_width_px = rgb_image.width();
    stages.source_height_px = rgb_image.height();

    let resize_started = Instant::now();
    let rgb_image = downscale_for_model(rgb_image);
    stages.resize_ms = resize_started.elapsed().as_millis() as u64;
    let (jpeg_width_px, jpeg_height_px) = (rgb_image.width(), rgb_image.height());
    stages.jpeg_width_px = jpeg_width_px;
    stages.jpeg_height_px = jpeg_height_px;
    stages.resized = jpeg_width_px != stages.source_width_px;

    // monitor_* stay in PHYSICAL screen pixels while jpeg_* now describe the
    // resized image. That split is what keeps pointing correct: the mapping in
    // screenFrame.ts (screenPointFor) and the backend's ScreenFrame._scaled
    // both convert a model coordinate from jpeg space into monitor space by
    // ratio, so shrinking the image needs no change on either side.
    // xcap reports monitor bounds in the platform's own space: physical pixels
    // on Windows, but POINTS on macOS, where CGDisplayBounds is what it reads.
    // The field names and the note above promise physical pixels, and
    // screenFrame.ts's screenPointFor maps model coordinates through them, so
    // the macOS values are scaled up here rather than leaving pointing 2x out
    // on every Retina display.
    let scale_factor = monitor.scale_factor().map_err(|e| e.to_string())?;
    let to_px = if cfg!(target_os = "macos") { scale_factor } else { 1.0 };
    let geometry = ScreenFrameGeometry {
        monitor_left_px: (monitor.x().map_err(|e| e.to_string())? as f32 * to_px) as i32,
        monitor_top_px: (monitor.y().map_err(|e| e.to_string())? as f32 * to_px) as i32,
        monitor_width_px: (monitor.width().map_err(|e| e.to_string())? as f32 * to_px) as u32,
        monitor_height_px: (monitor.height().map_err(|e| e.to_string())? as f32 * to_px) as u32,
        scale_factor,
        jpeg_width_px,
        jpeg_height_px,
    };

    let encode_started = Instant::now();
    let mut jpeg_bytes: Vec<u8> = Vec::new();
    JpegEncoder::new_with_quality(&mut Cursor::new(&mut jpeg_bytes), MODEL_FRAME_JPEG_QUALITY)
        .encode_image(&rgb_image)
        .map_err(|e| e.to_string())?;
    stages.jpeg_encode_ms = encode_started.elapsed().as_millis() as u64;
    stages.jpeg_bytes_after = jpeg_bytes.len() as u64;

    let mut payload = Vec::with_capacity(GEOMETRY_HEADER_LEN + jpeg_bytes.len());
    geometry.write_le(&mut payload);
    payload.extend_from_slice(&jpeg_bytes);

    Ok(CapturedFrame {
        payload,
        jpeg_bytes,
        stages,
    })
}

/// Shrinks to `MODEL_FRAME_LONG_EDGE_PX` on the long edge, preserving aspect
/// ratio. Never upscales: a small window stays exactly as captured.
///
/// `Triangle` rather than `Lanczos3`: at these ratios Lanczos costs noticeably
/// more CPU on the response path for a difference that does not survive JPEG
/// quality 82, and this runs on every spoken turn.
///
/// `pub(crate)` so Guide shares this exact rule. Two capture paths that
/// disagreed on frame size once meant Guide shipped full-resolution frames the
/// backend then had to resize, and oversized ones it silently dropped.
pub(crate) fn downscale_for_model(image: image::RgbImage) -> image::RgbImage {
    let long_edge = image.width().max(image.height());
    if long_edge <= MODEL_FRAME_LONG_EDGE_PX || long_edge == 0 {
        return image;
    }
    let scale = f64::from(MODEL_FRAME_LONG_EDGE_PX) / f64::from(long_edge);
    let width = ((f64::from(image.width()) * scale).round() as u32).max(1);
    let height = ((f64::from(image.height()) * scale).round() as u32).max(1);
    image::imageops::resize(&image, width, height, FilterType::Triangle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_maintenance_removes_only_the_legacy_screenshot_directory() {
        let base = std::env::temp_dir().join(format!(
            "aura-screenshot-maintenance-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        let screenshots = base.join(LEGACY_SCREENSHOTS_DIR);
        let sibling = base.join("meeting-captures");
        std::fs::create_dir_all(&screenshots).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(screenshots.join("legacy.jpg"), b"jpeg").unwrap();
        std::fs::write(sibling.join("keep.enc"), b"encrypted").unwrap();

        assert!(remove_legacy_screenshots(&base).unwrap());
        assert!(!screenshots.exists());
        assert!(sibling.join("keep.enc").exists());
        assert!(!remove_legacy_screenshots(&base).unwrap());

        std::fs::remove_dir_all(base).unwrap();
    }
}
