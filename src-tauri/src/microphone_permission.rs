use tauri::AppHandle;

#[tauri::command]
pub async fn reset_microphone_permission(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::reset(&app).await
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tauri::{AppHandle, Manager};
    use webview2_com::SetPermissionStateCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_13, ICoreWebView2Profile4, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
    };
    use windows::core::{HSTRING, Interface};

    pub async fn reset(app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main webview unavailable".to_string())?;
        let origin = window
            .url()
            .map_err(|error| format!("could not read webview URL: {error}"))?
            .origin()
            .ascii_serialization();
        if origin == "null" {
            return Err("webview origin is unavailable".to_string());
        }

        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let sender = Arc::new(Mutex::new(Some(tx)));
        let callback_sender = sender.clone();
        window
            .with_webview(move |webview| {
                let result = (|| unsafe {
                    let core = webview.controller().CoreWebView2()?;
                    let profile = core.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile4>()?;
                    let handler = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                        if let Some(tx) = callback_sender.lock().unwrap_or_else(|error| error.into_inner()).take() {
                            let _ = tx.send(result.map_err(|error| error.to_string()));
                        }
                        Ok(())
                    }));
                    profile.SetPermissionState(
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                        &HSTRING::from(origin),
                        COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                        &handler,
                    )?;
                    Ok::<(), windows::core::Error>(())
                })();
                if let Err(error) = result {
                    if let Some(tx) = sender.lock().unwrap_or_else(|poison| poison.into_inner()).take() {
                        let _ = tx.send(Err(error.to_string()));
                    }
                }
            })
            .map_err(|error| format!("could not access WebView2: {error}"))?;

        tokio::time::timeout(Duration::from_secs(3), rx)
            .await
            .map_err(|_| "microphone permission reset timed out".to_string())?
            .map_err(|_| "microphone permission reset was cancelled".to_string())?
    }
}
