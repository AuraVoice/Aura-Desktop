//! DXGI Desktop Duplication backend.
//!
//! Chosen over Windows.Graphics.Capture because it is plain Win32 (no WinRT
//! interop), it draws no capture border, and - the reason that matters here -
//! `AcquireNextFrame` answers "has the desktop been presented since you last
//! looked?" without transferring anything. That single fact is what makes an
//! unchanged Guide tick free.
//!
//! What is NOT optimised yet, stated plainly so nobody re-reads this file
//! expecting it: once a frame IS presented, `read_back` copies the whole
//! monitor into a staging texture and converts every pixel from BGRA to RGBA on
//! the CPU. `AcquireNextFrame` supplies `TotalMetadataBufferSize` alongside
//! `GetFrameDirtyRects`/`GetFrameMoveRects`, and none of it is consulted. For a
//! screen with any continuous animation on it, every 750 ms tick therefore
//! costs the same full readback `xcap` did; only genuinely static ticks are
//! free. Narrowing the readback to the dirty bounding box needs a retained
//! previous frame to merge against, which is a real memory trade (a 4K RGBA
//! frame is ~33MB) and deliberately out of scope here.
//!
//! Deliberate limits, each falling back to `xcap` rather than degrading:
//!
//! * **Rotated displays are refused.** The duplication surface is delivered in
//!   the un-rotated orientation, so a portrait monitor would fingerprint a
//!   sideways image. Rather than carry rotation maths that nothing else in the
//!   Guide pipeline expects, a rotated output simply is not duplicated.
//! * **Frames are per-output.** The session is created for the pinned monitor's
//!   desktop origin and is invalidated when that geometry changes.
//! * **`ACCESS_LOST` is normal, not exceptional.** Secure-desktop transitions
//!   (UAC, lock), mode changes and driver resets all produce it. The session
//!   layer handles recovery; this file only reports it.
//!
//! `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on the overlay (see
//! `overlay.rs`) applies to duplication too, so Aura still never captures
//! itself.

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED,
    DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};
use xcap::image::RgbaImage;

use super::{CaptureError, CaptureTick};

pub struct DdaBackend {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    staging: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
    /// Duplication requires the previous frame to be released before the next
    /// is acquired. Tracked explicitly because an early return between acquire
    /// and release would otherwise wedge the session permanently.
    holding_frame: bool,
}

impl DdaBackend {
    /// Creates a duplication session for the output whose desktop origin
    /// matches the pinned monitor.
    ///
    /// Matched by origin rather than by device name because `xcap` and DXGI do
    /// not agree on what a monitor is called, while both agree on where it sits
    /// in the virtual desktop.
    pub fn create(monitor_left: i32, monitor_top: i32) -> Result<Self, String> {
        unsafe {
            let factory: IDXGIFactory1 =
                CreateDXGIFactory1().map_err(|e| format!("dxgi factory: {e}"))?;
            let mut adapter_index = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(adapter_index) {
                adapter_index += 1;
                let mut output_index = 0u32;
                while let Ok(output) = adapter.EnumOutputs(output_index) {
                    output_index += 1;
                    let Ok(desc) = output.GetDesc() else {
                        continue;
                    };
                    if desc.DesktopCoordinates.left != monitor_left
                        || desc.DesktopCoordinates.top != monitor_top
                    {
                        continue;
                    }
                    if desc.Rotation != DXGI_MODE_ROTATION_IDENTITY
                        && desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED
                    {
                        return Err("rotated display, duplication not used".to_string());
                    }
                    let output1: IDXGIOutput1 =
                        output.cast().map_err(|e| format!("dxgi output1: {e}"))?;
                    // The device MUST come from the adapter that owns this
                    // output: on a hybrid-graphics laptop the default adapter
                    // is often not the one driving the panel.
                    let (device, context) = create_device(&adapter)?;
                    let duplication = output1
                        .DuplicateOutput(&device)
                        .map_err(|e| format!("duplicate output: {e}"))?;
                    return Ok(Self {
                        device,
                        context,
                        duplication,
                        staging: None,
                        width: (desc.DesktopCoordinates.right - desc.DesktopCoordinates.left)
                            .max(0) as u32,
                        height: (desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top)
                            .max(0) as u32,
                        holding_frame: false,
                    });
                }
            }
            Err("no DXGI output matches the pinned monitor".to_string())
        }
    }

    pub fn tick(&mut self) -> Result<CaptureTick, CaptureError> {
        unsafe {
            self.release_held_frame();

            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            // Timeout 0: this is a poll, not a wait. The 750ms scheduler is the
            // clock; blocking here would only add latency to the tick.
            if let Err(e) = self
                .duplication
                .AcquireNextFrame(0, &mut info, &mut resource)
            {
                return match e.code() {
                    DXGI_ERROR_WAIT_TIMEOUT => Ok(CaptureTick::Unchanged),
                    DXGI_ERROR_ACCESS_LOST => Err(CaptureError::Lost),
                    other => Err(CaptureError::Failed(format!("acquire: {}", other.0))),
                };
            }
            self.holding_frame = true;

            // A zero present time means the only thing that changed was the
            // mouse cursor position. The desktop image is identical, so the
            // caller's fingerprint still holds.
            if info.LastPresentTime == 0 {
                self.release_held_frame();
                return Ok(CaptureTick::Unchanged);
            }

            let Some(resource) = resource else {
                self.release_held_frame();
                return Ok(CaptureTick::Unchanged);
            };
            let frame: ID3D11Texture2D = resource
                .cast()
                .map_err(|e| CaptureError::Failed(format!("frame cast: {e}")))?;
            let image = self.read_back(&frame);
            self.release_held_frame();
            Ok(CaptureTick::Captured(image?))
        }
    }

    /// Copies the GPU frame into a CPU-readable staging texture and converts
    /// BGRA to the RGBA the fingerprint and JPEG encoder expect.
    unsafe fn read_back(&mut self, frame: &ID3D11Texture2D) -> Result<RgbaImage, CaptureError> {
        if self.staging.is_none() {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: self.width,
                Height: self.height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging: Option<ID3D11Texture2D> = None;
            self.device
                .CreateTexture2D(&desc, None, Some(&mut staging))
                .map_err(|e| CaptureError::Failed(format!("staging texture: {e}")))?;
            self.staging = staging;
        }
        let staging = self
            .staging
            .clone()
            .ok_or_else(|| CaptureError::Failed("staging texture missing".to_string()))?;

        self.context.CopyResource(&staging, frame);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        self.context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|e| CaptureError::Failed(format!("map: {e}")))?;

        let width = self.width as usize;
        let height = self.height as usize;
        let row_pitch = mapped.RowPitch as usize;
        let mut rgba = vec![0u8; width * height * 4];
        for y in 0..height {
            let src = std::slice::from_raw_parts(
                (mapped.pData as *const u8).add(y * row_pitch),
                width * 4,
            );
            let dst = &mut rgba[y * width * 4..(y + 1) * width * 4];
            for x in 0..width {
                let s = &src[x * 4..x * 4 + 4];
                let d = &mut dst[x * 4..x * 4 + 4];
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = 255;
            }
        }
        self.context.Unmap(&staging, 0);

        RgbaImage::from_raw(self.width, self.height, rgba)
            .ok_or_else(|| CaptureError::Failed("frame buffer size mismatch".to_string()))
    }

    unsafe fn release_held_frame(&mut self) {
        if self.holding_frame {
            let _ = self.duplication.ReleaseFrame();
            self.holding_frame = false;
        }
    }
}

impl Drop for DdaBackend {
    fn drop(&mut self) {
        unsafe { self.release_held_frame() };
    }
}

unsafe fn create_device(
    adapter: &IDXGIAdapter1,
) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    D3D11CreateDevice(
        adapter,
        // UNKNOWN is required when an adapter is supplied explicitly.
        D3D_DRIVER_TYPE_UNKNOWN,
        HMODULE::default(),
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        Some(&[D3D_FEATURE_LEVEL_11_0]),
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        Some(&mut context),
    )
    .map_err(|e| format!("d3d11 device: {e}"))?;
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context)),
        _ => Err("d3d11 device not returned".to_string()),
    }
}
