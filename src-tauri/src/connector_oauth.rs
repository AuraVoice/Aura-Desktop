use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

use crate::dashboard;

#[derive(Default)]
pub struct ConnectorOAuthState {
    pending_url: Mutex<Option<String>>,
}

pub fn ingest_urls(app: &AppHandle, urls: &[Url]) {
    for url in urls {
        if url.scheme() != "aura"
            || url.host_str() != Some("connectors")
            || url.path() != "/complete"
        {
            continue;
        }

        let raw = url.to_string();
        let state = app.state::<ConnectorOAuthState>();
        if let Ok(mut pending) = state.pending_url.lock() {
            *pending = Some(raw.clone());
        } else {
            log::error!("connector oauth: pending completion lock poisoned");
            return;
        }

        if let Err(error) = dashboard::open_dashboard_route(app, Some("/connectors")) {
            log::error!("connector oauth: failed to open connectors page: {error}");
        }
        if let Err(error) = app.emit("connector-oauth-complete", raw) {
            log::error!("connector oauth: failed to emit completion: {error}");
        }
    }
}

#[tauri::command]
pub fn take_connector_oauth_completion(
    state: State<'_, ConnectorOAuthState>,
) -> Option<String> {
    match state.pending_url.lock() {
        Ok(mut pending) => pending.take(),
        Err(_) => {
            log::error!("connector oauth: pending completion lock poisoned");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_connector_completion_urls_match() {
        let good = Url::parse(
            "aura://connectors/complete?attempt_id=abc&connector=gmail&outcome=success",
        )
        .unwrap();
        let wrong_host = Url::parse(
            "aura://settings/complete?attempt_id=abc&connector=gmail&outcome=success",
        )
        .unwrap();

        assert_eq!(good.scheme(), "aura");
        assert_eq!(good.host_str(), Some("connectors"));
        assert_eq!(good.path(), "/complete");
        assert_ne!(wrong_host.host_str(), Some("connectors"));
    }
}
