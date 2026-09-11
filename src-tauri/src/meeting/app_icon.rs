//! The detected call app's real icon, for the "Record this meeting?" card.
//!
//! Read once per call, on the ambient scanner's "seen" transition, and handed to
//! React as a PNG data URL (the CSP allows `data:` images). Browser-hosted calls
//! never come here: the card shows the meeting site's favicon instead, because a
//! Meet tab should look like Meet, not like Chrome. Every failure is `None`, and
//! the card falls back to its drawn brand mark.

use base64::Engine;
use image::{imageops::FilterType, ImageFormat};

/// Edge length handed to the card: a 22px slot at up to 2x, plus headroom.
const ICON_PX: u32 = 64;

/// Where one running app's icon can be read from.
#[derive(Clone, Debug)]
pub(crate) enum IconSource {
    /// Full path of the process image.
    #[cfg(windows)]
    Exe(String),
    /// The app's process id.
    #[cfg(target_os = "macos")]
    Pid(i32),
}

pub(crate) fn png_data_url(source: &IconSource) -> Option<String> {
    let icon = backend::icon(source)?;
    let icon = if icon.width() > ICON_PX || icon.height() > ICON_PX {
        image::imageops::resize(&icon, ICON_PX, ICON_PX, FilterType::Triangle)
    } else {
        icon
    };
    let mut png = std::io::Cursor::new(Vec::new());
    icon.write_to(&mut png, ImageFormat::Png).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Some(format!("data:image/png;base64,{encoded}"))
}

/// Windows: the exe's own icon resource at exactly `ICON_PX`, read back from
/// the HICON's colour bitmap. Handles are released on every path.
#[cfg(windows)]
mod backend {
    use super::{IconSource, ICON_PX};
    use image::RgbaImage;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO,
    };

    pub(super) fn icon(source: &IconSource) -> Option<RgbaImage> {
        let IconSource::Exe(path) = source;
        let wide: Vec<u16> = path.encode_utf16().collect();
        if wide.len() >= 260 {
            return None;
        }
        let mut name = [0u16; 260];
        name[..wide.len()].copy_from_slice(&wide);
        let mut icons = [HICON(core::ptr::null_mut())];
        let size = ICON_PX as i32;
        let extracted =
            unsafe { PrivateExtractIconsW(&name, 0, size, size, Some(&mut icons), None, 0) };
        if extracted == 0 || extracted == u32::MAX || icons[0].is_invalid() {
            return None;
        }
        let pixels = icon_pixels(icons[0]);
        unsafe {
            let _ = DestroyIcon(icons[0]);
        }
        RgbaImage::from_raw(ICON_PX, ICON_PX, pixels?)
    }

    fn icon_pixels(icon: HICON) -> Option<Vec<u8>> {
        let mut info = ICONINFO::default();
        unsafe { GetIconInfo(icon, &mut info) }.ok()?;
        let pixels = color_bits(info.hbmColor);
        unsafe {
            if !info.hbmColor.is_invalid() {
                let _ = DeleteObject(info.hbmColor.into());
            }
            if !info.hbmMask.is_invalid() {
                let _ = DeleteObject(info.hbmMask.into());
            }
        }
        pixels
    }

    /// 32bpp top-down BGRA -> RGBA. A monochrome icon has no colour bitmap and
    /// yields None (the card's brand mark covers it). An icon with no alpha at
    /// all is a legacy one, drawn opaque.
    fn color_bits(bitmap: HBITMAP) -> Option<Vec<u8>> {
        if bitmap.is_invalid() {
            return None;
        }
        let size = ICON_PX as i32;
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: core::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (ICON_PX * ICON_PX * 4) as usize];
        let lines = unsafe {
            let dc = GetDC(None);
            if dc.is_invalid() {
                return None;
            }
            let lines = GetDIBits(
                dc,
                bitmap,
                0,
                ICON_PX,
                Some(pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            );
            ReleaseDC(None, dc);
            lines
        };
        if lines != size {
            return None;
        }
        let has_alpha = pixels.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0);
        for pixel in pixels.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
            if !has_alpha {
                pixel[3] = u8::MAX;
            }
        }
        Some(pixels)
    }
}

/// macOS: `NSRunningApplication.icon`, which needs no TCC grant. Its TIFF
/// carries every size up to 1024px, so the caller downscales it.
#[cfg(target_os = "macos")]
mod backend {
    use super::IconSource;
    use image::{ImageFormat, RgbaImage};
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSRunningApplication,
    };
    use objc2_foundation::NSDictionary;

    pub(super) fn icon(source: &IconSource) -> Option<RgbaImage> {
        let IconSource::Pid(pid) = source;
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(*pid)?;
        let tiff = app.icon()?.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
        let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }?;
        Some(
            image::load_from_memory_with_format(&png.to_vec(), ImageFormat::Png)
                .ok()?
                .to_rgba8(),
        )
    }
}
