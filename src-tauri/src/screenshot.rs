use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageFormat;
use tauri::{AppHandle, Manager};
use xcap::Monitor;

/// Captures the monitor the main window currently sits on (not just the
/// primary monitor) as a base64-encoded JPEG, for a single explicit user
/// gesture (the capture button) — never called on a timer or in the background.
#[tauri::command]
pub fn capture_screenshot(app: AppHandle) -> Result<String, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;

    let monitor =
        Monitor::from_point(position.x, position.y).map_err(|e| e.to_string())?;
    let captured = monitor.capture_image().map_err(|e| e.to_string())?;
    let rgb_image = image::DynamicImage::ImageRgba8(captured).into_rgb8();

    let mut bytes: Vec<u8> = Vec::new();
    rgb_image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;

    Ok(STANDARD.encode(&bytes))
}
