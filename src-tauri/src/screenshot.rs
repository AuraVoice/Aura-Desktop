use std::io::Cursor;
use std::path::Path;

use image::ImageFormat;
use log::{info, warn};
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

const LEGACY_SCREENSHOTS_DIR: &str = "screenshots";

struct CapturedFrame {
    payload: Vec<u8>,
}

impl CapturedFrame {
    fn into_response(self) -> Response {
        Response::new(self.payload)
    }
}

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
    let ticket = crate::security::authorize(&app, crate::security::Operation::CaptureScreen)?;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let cursor_x = cursor.x as i32;
    let cursor_y = cursor.y as i32;

    let frame = tauri::async_runtime::spawn_blocking(move || capture_frame(cursor_x, cursor_y))
        .await
        .map_err(|e| e.to_string())??;

    // A disarm/sign-out that landed during the capture+encode window drops
    // the frame instead of returning it (the JS side already applied the same
    // rule to its own armed flag; this makes it authoritative).
    crate::security::recheck(&app, crate::security::Operation::CaptureScreen, &ticket)?;
    crate::security::note_capture(&app);
    Ok(frame.into_response())
}

#[tauri::command]
pub async fn capture_turn_screen_with_geometry(app: AppHandle) -> Result<Response, String> {
    let ticket = crate::security::authorize(&app, crate::security::Operation::CaptureTurnScreen)?;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let cursor_x = cursor.x as i32;
    let cursor_y = cursor.y as i32;

    let frame = tauri::async_runtime::spawn_blocking(move || capture_frame(cursor_x, cursor_y))
        .await
        .map_err(|e| e.to_string())??;

    // The turn frame is intentionally memory-only. The frontend streams this
    // response directly to LiveKit and drops it after the write completes.
    crate::security::recheck(&app, crate::security::Operation::CaptureTurnScreen, &ticket)?;
    crate::security::note_capture(&app);
    Ok(frame.into_response())
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

/// Returns a raw IPC response: the `GEOMETRY_HEADER_LEN`-byte geometry header
/// followed directly by the JPEG bytes, so the frontend reads it as an
/// `ArrayBuffer` with no base64 encode/decode round trip.
fn capture_frame(cursor_x: i32, cursor_y: i32) -> Result<CapturedFrame, String> {
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

    Ok(CapturedFrame { payload })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_maintenance_removes_only_the_legacy_screenshot_directory() {
        let base = std::env::temp_dir().join(format!(
            "aura-screenshot-maintenance-{}-{}",
            std::process::id(),
            crate::meeting::now_ms()
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
