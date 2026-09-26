//! A minimal Chrome DevTools Protocol client over the crate's existing
//! `tokio-tungstenite`. Plain `ws://127.0.0.1`, no TLS, no CDP crate: the
//! twelve-odd methods the worker needs do not justify a second WebSocket or
//! crypto stack next to the one dictation already pins (see Cargo.toml).
//!
//! Shape: one tokio task owns the socket and a map of in-flight call ids; the
//! blocking worker thread talks to it over channels, exactly how
//! `dictation/asr/deepgram.rs` pairs its socket task with the dictation
//! worker. `call` blocks the worker for at most `CALL_TIMEOUT`, which is the
//! per-step deadline the plan sets, so a hung renderer ends the step rather
//! than the whole task.
//!
//! Flatten mode: the client attaches to the one page target with
//! `flatten: true` and stamps `sessionId` on page commands, so the whole run
//! rides a single socket to the browser endpoint. Events the worker cares
//! about (loads, new targets, dialogs) are forwarded on an unbounded channel
//! and drained by the worker between steps; everything else is dropped here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use serde_json::{json, Value};
use tokio::sync::mpsc as tokio_mpsc;
use tokio_tungstenite::tungstenite::Message;

/// One CDP round trip. The renderer answering an accessibility-tree request
/// on a heavy page is the slow case; a click or a navigate answers in
/// milliseconds. Same number as the plan's per-step deadline.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

enum Outbound {
    Call {
        id: u64,
        method: &'static str,
        params: Value,
        session_id: Option<String>,
        reply: mpsc::Sender<Result<Value, String>>,
    },
    Close,
}

/// A protocol event (a message with `method` and no `id`), forwarded as-is.
pub struct Event {
    pub method: String,
    pub params: Value,
}

pub struct CdpClient {
    outbound: tokio_mpsc::UnboundedSender<Outbound>,
    events: mpsc::Receiver<Event>,
    next_id: AtomicU64,
}

impl CdpClient {
    /// Connects to the browser endpoint (`ws://127.0.0.1:{port}{path}`, the
    /// second line of `DevToolsActivePort`) and starts the socket task on
    /// tauri's runtime. Blocks the caller for the handshake only.
    pub fn connect(port: u16, browser_path: &str) -> Result<Self, String> {
        let url = format!("ws://127.0.0.1:{port}{browser_path}");
        let (outbound_tx, outbound_rx) = tokio_mpsc::unbounded_channel();
        let (events_tx, events_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        tauri::async_runtime::spawn(async move {
            run_socket(url, outbound_rx, events_tx, ready_tx).await;
        });
        match ready_rx.recv_timeout(CONNECT_TIMEOUT + Duration::from_secs(1)) {
            Ok(Ok(())) => Ok(Self {
                outbound: outbound_tx,
                events: events_rx,
                next_id: AtomicU64::new(1),
            }),
            Ok(Err(reason)) => Err(reason),
            Err(_) => Err("cdp connect timed out".to_string()),
        }
    }

    /// One method call, on the browser session (`None`) or a page session.
    /// Returns the `result` object, or the protocol's error message.
    pub fn call(
        &self,
        session_id: Option<&str>,
        method: &'static str,
        params: Value,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = mpsc::channel();
        self.outbound
            .send(Outbound::Call {
                id,
                method,
                params,
                session_id: session_id.map(str::to_string),
                reply: reply_tx,
            })
            .map_err(|_| "cdp socket closed".to_string())?;
        match reply_rx.recv_timeout(CALL_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(format!("cdp {method} timed out")),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("cdp socket closed".to_string()),
        }
    }

    /// Events received since the last drain, oldest first. Never blocks.
    pub fn drain_events(&self) -> Vec<Event> {
        let mut out = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            out.push(event);
        }
        out
    }

    /// Waits up to `timeout` for the next event. `None` on timeout or when the
    /// socket is gone; the caller distinguishes those by trying a call.
    pub fn next_event(&self, timeout: Duration) -> Option<Event> {
        self.events.recv_timeout(timeout).ok()
    }

    pub fn close(&self) {
        let _ = self.outbound.send(Outbound::Close);
    }
}

impl Drop for CdpClient {
    fn drop(&mut self) {
        let _ = self.outbound.send(Outbound::Close);
    }
}

async fn run_socket(
    url: String,
    mut outbound: tokio_mpsc::UnboundedReceiver<Outbound>,
    events: mpsc::Sender<Event>,
    ready: mpsc::Sender<Result<(), String>>,
) {
    let connected = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(&url)).await;
    let socket = match connected {
        Ok(Ok((socket, _response))) => socket,
        Ok(Err(error)) => {
            // The URL carries only a loopback port and a browser GUID, so the
            // error can be logged whole.
            let _ = ready.send(Err(format!("cdp connect failed: {error}")));
            return;
        }
        Err(_) => {
            let _ = ready.send(Err("cdp connect timed out".to_string()));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    info!("agent_browser.cdp: state=connected");

    let (mut sink, mut stream) = socket.split();
    let mut pending: HashMap<u64, mpsc::Sender<Result<Value, String>>> = HashMap::new();
    loop {
        tokio::select! {
            command = outbound.recv() => {
                match command {
                    Some(Outbound::Call { id, method, params, session_id, reply }) => {
                        let mut frame = json!({ "id": id, "method": method, "params": params });
                        if let Some(session) = session_id {
                            frame["sessionId"] = Value::String(session);
                        }
                        if sink.send(Message::Text(frame.to_string().into())).await.is_err() {
                            let _ = reply.send(Err("cdp send failed".to_string()));
                            break;
                        }
                        pending.insert(id, reply);
                    }
                    Some(Outbound::Close) | None => break,
                }
            }
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                    if let Some(reply) = pending.remove(&id) {
                        let outcome = match frame.get("error") {
                            Some(error) => Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("cdp error")
                                .to_string()),
                            None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = reply.send(outcome);
                    }
                } else if let Some(method) = frame.get("method").and_then(Value::as_str) {
                    if events
                        .send(Event {
                            method: method.to_string(),
                            params: frame.get("params").cloned().unwrap_or(Value::Null),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    }
    let _ = sink.send(Message::Close(None)).await;
    for (_, reply) in pending.drain() {
        let _ = reply.send(Err("cdp socket closed".to_string()));
    }
    info!("agent_browser.cdp: state=closed");
}

/// The page session the worker drives: one attached target.
pub struct Page {
    pub target_id: String,
    pub session_id: String,
}

/// Enables discovery, attaches to the single page target (creating one when
/// the browser came up with none), and switches on the domains every step
/// uses. Downloads are denied on the page from the first moment it can
/// navigate, per the guard rules.
pub fn attach_page(cdp: &CdpClient) -> Result<Page, String> {
    cdp.call(None, "Target.setDiscoverTargets", json!({ "discover": true }))?;
    let targets = cdp.call(None, "Target.getTargets", json!({}))?;
    let mut target_id = targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .and_then(|infos| {
            infos.iter().find_map(|info| {
                (info.get("type").and_then(Value::as_str) == Some("page"))
                    .then(|| info.get("targetId").and_then(Value::as_str).map(str::to_string))
                    .flatten()
            })
        });
    if target_id.is_none() {
        let created = cdp.call(None, "Target.createTarget", json!({ "url": "about:blank" }))?;
        target_id = created.get("targetId").and_then(Value::as_str).map(str::to_string);
    }
    let target_id = target_id.ok_or_else(|| "no page target".to_string())?;
    let attached = cdp.call(
        None,
        "Target.attachToTarget",
        json!({ "targetId": target_id, "flatten": true }),
    )?;
    let session_id = attached
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "attach returned no session".to_string())?
        .to_string();
    let session = Some(session_id.as_str());
    cdp.call(session, "Page.enable", json!({}))?;
    cdp.call(session, "Runtime.enable", json!({}))?;
    cdp.call(session, "DOM.enable", json!({}))?;
    cdp.call(session, "Accessibility.enable", json!({}))?;
    cdp.call(session, "Page.setDownloadBehavior", json!({ "behavior": "deny" }))?;
    Ok(Page { target_id, session_id })
}

/// `location`, `document.title` and the scroll geometry in one evaluate, so a
/// snapshot header costs one round trip.
pub struct PageInfo {
    pub url: String,
    pub title: String,
    pub scroll_y: i64,
    pub scroll_height: i64,
    pub viewport_height: i64,
}

pub fn page_info(cdp: &CdpClient, page: &Page) -> Result<PageInfo, String> {
    let value = evaluate(
        cdp,
        page,
        "JSON.stringify({u: location.href, t: document.title, y: Math.round(scrollY), h: Math.round(document.documentElement.scrollHeight), v: Math.round(innerHeight)})",
    )?;
    let text = value.as_str().unwrap_or("{}");
    let parsed: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    Ok(PageInfo {
        url: parsed.get("u").and_then(Value::as_str).unwrap_or("").to_string(),
        title: parsed.get("t").and_then(Value::as_str).unwrap_or("").to_string(),
        scroll_y: parsed.get("y").and_then(Value::as_i64).unwrap_or(0),
        scroll_height: parsed.get("h").and_then(Value::as_i64).unwrap_or(0),
        viewport_height: parsed.get("v").and_then(Value::as_i64).unwrap_or(0),
    })
}

/// `Runtime.evaluate` returning the result's value. Exceptions become `Err`.
pub fn evaluate(cdp: &CdpClient, page: &Page, expression: &str) -> Result<Value, String> {
    let result = cdp.call(
        Some(&page.session_id),
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true }),
    )?;
    if let Some(details) = result.get("exceptionDetails") {
        return Err(details
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("evaluate threw")
            .to_string());
    }
    Ok(result
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(Value::Null))
}

/// The page's readable text for the `read_page` action: the title, then the
/// visible text under `main`/`article` (or the body), with navigation, asides,
/// footers, forms and scripts left out and block boundaries kept as line
/// breaks. Walks the live DOM so display:none subtrees are skipped the way a
/// reader would skip them; nothing on the page is mutated.
pub fn readable_text(cdp: &CdpClient, page: &Page) -> Result<String, String> {
    const EXTRACT: &str = r#"(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','NAV','ASIDE','FOOTER','FORM','IFRAME','SVG','TEMPLATE','BUTTON','SELECT','INPUT','TEXTAREA']);
  const BLOCK = new Set(['P','DIV','SECTION','ARTICLE','LI','TR','H1','H2','H3','H4','H5','H6','BR','PRE','BLOCKQUOTE','TD','TH','DT','DD','UL','OL','TABLE','HR','HEADER','MAIN']);
  const root = document.querySelector('main, article, [role="main"]') || document.body;
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { const t = node.nodeValue.replace(/\s+/g, ' '); if (t.trim()) out.push(t); return; }
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return;
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const block = BLOCK.has(node.tagName);
    if (block) out.push('
');
    for (const child of node.childNodes) walk(child);
    if (block) out.push('
');
  };
  if (root) walk(root);
  const text = out.join('').replace(/[ 	]+
/g, '
').replace(/
{3,}/g, '

').trim();
  return (document.title || '') + '

' + text;
})()"#;
    match evaluate(cdp, page, EXTRACT)? {
        Value::String(text) => Ok(text),
        _ => Err("readable_text: no string returned".to_string()),
    }
}

pub fn full_ax_tree(cdp: &CdpClient, page: &Page) -> Result<Vec<Value>, String> {
    let result = cdp.call(Some(&page.session_id), "Accessibility.getFullAXTree", json!({}))?;
    Ok(result
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// Scrolls the node into view and clicks the centre of its content box with
/// a real mouse event sequence. Falls back to `element.click()` when the
/// node has no box (an anchor with `display: contents`, an SVG child).
pub fn click(cdp: &CdpClient, page: &Page, backend_node_id: i64) -> Result<(), String> {
    let session = Some(page.session_id.as_str());
    let _ = cdp.call(
        session,
        "DOM.scrollIntoViewIfNeeded",
        json!({ "backendNodeId": backend_node_id }),
    );
    let centre = cdp
        .call(session, "DOM.getBoxModel", json!({ "backendNodeId": backend_node_id }))
        .ok()
        .and_then(|model| {
            let quad = model.get("model")?.get("content")?.as_array()?.clone();
            let xs: Vec<f64> = quad.iter().step_by(2).filter_map(Value::as_f64).collect();
            let ys: Vec<f64> = quad.iter().skip(1).step_by(2).filter_map(Value::as_f64).collect();
            if xs.len() < 4 || ys.len() < 4 {
                return None;
            }
            let x = xs.iter().sum::<f64>() / xs.len() as f64;
            let y = ys.iter().sum::<f64>() / ys.len() as f64;
            (x > 0.0 && y > 0.0).then_some((x, y))
        });
    match centre {
        Some((x, y)) => {
            for (kind, extra) in [
                ("mouseMoved", json!({})),
                ("mousePressed", json!({ "button": "left", "clickCount": 1 })),
                ("mouseReleased", json!({ "button": "left", "clickCount": 1 })),
            ] {
                let mut params = json!({ "type": kind, "x": x, "y": y });
                if let (Some(target), Some(source)) = (params.as_object_mut(), extra.as_object()) {
                    for (key, value) in source {
                        target.insert(key.clone(), value.clone());
                    }
                }
                cdp.call(session, "Input.dispatchMouseEvent", params)?;
            }
            Ok(())
        }
        None => call_on_node(cdp, page, backend_node_id, "function() { this.click(); }").map(|_| ()),
    }
}

/// Focuses the node, selects whatever it holds, and inserts the text the way
/// an IME would, which is what makes React-controlled inputs see it. Enter is
/// a real key pair so a search form submits.
pub fn type_text(
    cdp: &CdpClient,
    page: &Page,
    backend_node_id: i64,
    text: &str,
    submit: bool,
) -> Result<(), String> {
    let session = Some(page.session_id.as_str());
    let _ = cdp.call(
        session,
        "DOM.scrollIntoViewIfNeeded",
        json!({ "backendNodeId": backend_node_id }),
    );
    call_on_node(
        cdp,
        page,
        backend_node_id,
        "function() { this.focus(); if (typeof this.select === 'function') { this.select(); } else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }",
    )?;
    cdp.call(session, "Input.insertText", json!({ "text": text }))?;
    if submit {
        for kind in ["keyDown", "keyUp"] {
            cdp.call(
                session,
                "Input.dispatchKeyEvent",
                json!({
                    "type": kind,
                    "key": "Enter",
                    "code": "Enter",
                    "windowsVirtualKeyCode": 13,
                    "nativeVirtualKeyCode": 13,
                    "text": if kind == "keyDown" { "\r" } else { "" },
                }),
            )?;
        }
    }
    Ok(())
}

fn call_on_node(
    cdp: &CdpClient,
    page: &Page,
    backend_node_id: i64,
    function: &str,
) -> Result<Value, String> {
    let session = Some(page.session_id.as_str());
    let resolved = cdp.call(
        session,
        "DOM.resolveNode",
        json!({ "backendNodeId": backend_node_id }),
    )?;
    let object_id = resolved
        .get("object")
        .and_then(|o| o.get("objectId"))
        .and_then(Value::as_str)
        .ok_or_else(|| "node has no object".to_string())?;
    cdp.call(
        session,
        "Runtime.callFunctionOn",
        json!({ "objectId": object_id, "functionDeclaration": function }),
    )
}

pub fn scroll(cdp: &CdpClient, page: &Page, down: bool, backend_node_id: Option<i64>) -> Result<(), String> {
    if let Some(id) = backend_node_id {
        cdp.call(
            Some(&page.session_id),
            "DOM.scrollIntoViewIfNeeded",
            json!({ "backendNodeId": id }),
        )?;
        return Ok(());
    }
    let sign = if down { "" } else { "-" };
    evaluate(
        cdp,
        page,
        &format!("window.scrollBy(0, {sign}Math.round(innerHeight * 0.8)); true"),
    )
    .map(|_| ())
}

pub fn navigate(cdp: &CdpClient, page: &Page, url: &str) -> Result<(), String> {
    let result = cdp.call(Some(&page.session_id), "Page.navigate", json!({ "url": url }))?;
    if let Some(error) = result.get("errorText").and_then(Value::as_str) {
        if !error.is_empty() {
            return Err(format!("navigation failed: {error}"));
        }
    }
    Ok(())
}

pub fn back(cdp: &CdpClient, page: &Page) -> Result<(), String> {
    let session = Some(page.session_id.as_str());
    let history = cdp.call(session, "Page.getNavigationHistory", json!({}))?;
    let current = history.get("currentIndex").and_then(Value::as_i64).unwrap_or(0);
    if current <= 0 {
        return Err("no page to go back to".to_string());
    }
    let entry_id = history
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|entries| entries.get((current - 1) as usize))
        .and_then(|entry| entry.get("id"))
        .and_then(Value::as_i64)
        .ok_or_else(|| "history entry missing".to_string())?;
    cdp.call(session, "Page.navigateToHistoryEntry", json!({ "entryId": entry_id }))?;
    Ok(())
}

/// Waits for the load event (or 8 s), then for the document to settle.
pub fn wait_load(cdp: &CdpClient, page: &Page, dialogs: &mut Vec<Event>) {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match cdp.next_event(remaining.min(Duration::from_millis(500))) {
            Some(event) if event.method == "Page.loadEventFired" => break,
            Some(event) => dialogs.push(event),
            None => {
                // Either the timeout slice passed or the socket is gone; a
                // cheap call tells the two apart on the next line of the loop.
                if evaluate(cdp, page, "document.readyState").map(|v| v == "complete").unwrap_or(true) {
                    break;
                }
            }
        }
    }
    settle(cdp, page);
}

/// `readyState === "complete"`, then the body text stops changing. Bounded so
/// an infinite-scroll page cannot hold a step open.
pub fn settle(cdp: &CdpClient, page: &Page) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if evaluate(cdp, page, "document.readyState").map(|v| v == "complete").unwrap_or(true) {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    std::thread::sleep(Duration::from_millis(400));
    let length = |cdp: &CdpClient| {
        evaluate(cdp, page, "document.body ? document.body.innerText.length : 0")
            .ok()
            .and_then(|v| v.as_i64())
            .unwrap_or(-1)
    };
    let stable_deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut last = length(cdp);
    while std::time::Instant::now() < stable_deadline {
        std::thread::sleep(Duration::from_millis(250));
        let now = length(cdp);
        if now == last {
            break;
        }
        last = now;
    }
}

/// Handles what the event drain found: a JavaScript dialog is dismissed (the
/// agent never answers one), a popup the page opened is closed, and the
/// page's own target vanishing is reported. Returns the result suffix for
/// the trace and whether the page is gone.
pub struct EventOutcome {
    pub popup_blocked: bool,
    pub page_closed: bool,
}

pub fn handle_events(cdp: &CdpClient, page: &Page, events: Vec<Event>) -> EventOutcome {
    let mut outcome = EventOutcome { popup_blocked: false, page_closed: false };
    for event in events {
        match event.method.as_str() {
            "Page.javascriptDialogOpening" => {
                let _ = cdp.call(
                    Some(&page.session_id),
                    "Page.handleJavaScriptDialog",
                    json!({ "accept": false }),
                );
            }
            "Target.targetCreated" => {
                let info = event.params.get("targetInfo").cloned().unwrap_or(Value::Null);
                let is_page = info.get("type").and_then(Value::as_str) == Some("page");
                let id = info.get("targetId").and_then(Value::as_str).unwrap_or("");
                if is_page && !id.is_empty() && id != page.target_id {
                    let _ = cdp.call(None, "Target.closeTarget", json!({ "targetId": id }));
                    outcome.popup_blocked = true;
                }
            }
            "Target.targetDestroyed"
                if event.params.get("targetId").and_then(Value::as_str) == Some(page.target_id.as_str()) =>
            {
                outcome.page_closed = true;
            }
            _ => {}
        }
    }
    outcome
}

/// Shows or hides the browser window through the protocol. The Windows side
/// additionally hides the HWND (launch.rs), because a minimized Chrome still
/// owns a taskbar button.
pub fn set_window_visible(cdp: &CdpClient, page: &Page, visible: bool) {
    let Ok(window) = cdp.call(None, "Browser.getWindowForTarget", json!({ "targetId": page.target_id })) else {
        return;
    };
    let Some(window_id) = window.get("windowId").and_then(Value::as_i64) else {
        return;
    };
    let bounds = if visible {
        json!({ "left": 120, "top": 80, "width": 1280, "height": 900, "windowState": "normal" })
    } else {
        json!({ "windowState": "minimized" })
    };
    if let Err(error) = cdp.call(None, "Browser.setWindowBounds", json!({ "windowId": window_id, "bounds": bounds })) {
        warn!("agent_browser.cdp: setWindowBounds failed: {error}");
    }
}
