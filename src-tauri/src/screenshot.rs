use std::io::Cursor;

use image::ImageFormat;
use tauri::{ipc::Response, AppHandle, Manager};
use xcap::Monitor;

/// Geometry of one captured frame - carried as a fixed-width binary header in
/// front of the JPEG bytes (see `write_le`) so an `element.point` response
/// naming a JPEG-space coordinate can be mapped back onto the real screen.
/// Direct port of `ScreenFrameGeometry` (desktop_screen_capture_service.dart).
struct ScreenFrameGeometry {
    monitor_left_px: i32,
    monitor_top_px: i32,
    monitor_width_px: u32,
    monitor_height_px: u32,
    scale_factor: f32,
    jpeg_width_px: u32,
    jpeg_height_px: u32,
}

/// Byte length of the header `write_le` produces - 7 little-endian 4-byte
/// fields. `useScreenSight.ts`'s `DataView` reads must match this layout.
const GEOMETRY_HEADER_LEN: usize = 4 * 7;

impl ScreenFrameGeometry {
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
pub async fn capture_cursor_display_with_geometry(app: AppHandle) -> Result<Response, String> {
    // Native authorization, not the frontend's armed boolean: capture needs a
    // signed-in session, a live voice call, and screen sight armed - all
    // tracked in security.rs, all cleared on sign-out/disconnect/restart.
    let ticket =
        crate::security::authorize(&app, crate::security::Operation::CaptureScreen)?;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let cursor_x = cursor.x as i32;
    let cursor_y = cursor.y as i32;

    let result = tauri::async_runtime::spawn_blocking(move || capture_frame(cursor_x, cursor_y))
        .await
        .map_err(|e| e.to_string())?;

    // A disarm/sign-out that landed during the capture+encode window drops
    // the frame instead of returning it (the JS side already applied the same
    // rule to its own armed flag; this makes it authoritative).
    crate::security::recheck(&app, crate::security::Operation::CaptureScreen, &ticket)?;
    crate::security::note_capture(&app);
    result
}

/// Returns a raw IPC response: the `GEOMETRY_HEADER_LEN`-byte geometry header
/// followed directly by the JPEG bytes, so the frontend reads it as an
/// `ArrayBuffer` with no base64 encode/decode round trip.
fn capture_frame(cursor_x: i32, cursor_y: i32) -> Result<Response, String> {
    let monitor = Monitor::from_point(cursor_x, cursor_y).map_err(|e| e.to_string())?;
    let captured = monitor.capture_image().map_err(|e| e.to_string())?;
    let rgb_image = image::DynamicImage::ImageRgba8(captured).into_rgb8();
    let (jpeg_width_px, jpeg_height_px) = (rgb_image.width(), rgb_image.height());

    let geometry = ScreenFrameGeometry {
        monitor_left_px: monitor.x().map_err(|e| e.to_string())?,
        monitor_top_px: monitor.y().map_err(|e| e.to_string())?,
        monitor_width_px: monitor.width().map_err(|e| e.to_string())?,
        monitor_height_px: monitor.height().map_err(|e| e.to_string())?,
        scale_factor: monitor.scale_factor().map_err(|e| e.to_string())?,
        jpeg_width_px,
        jpeg_height_px,
    };

    let mut jpeg_bytes: Vec<u8> = Vec::new();
    rgb_image
        .write_to(&mut Cursor::new(&mut jpeg_bytes), ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;

    let mut payload = Vec::with_capacity(GEOMETRY_HEADER_LEN + jpeg_bytes.len());
    geometry.write_le(&mut payload);
    payload.extend_from_slice(&jpeg_bytes);

    Ok(Response::new(payload))
}
