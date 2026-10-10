//! The Operator's `fetch_url` and `web_search`: reading the web the way a
//! coding agent does, as text, with no browser and none of the user's cookies.
//!
//! `fetch_url` is a plain GET from this machine. The guard asks once per
//! website per task (the leak gate: an injected page cannot make the task send
//! what it has read to a site the user never allowed), so a redirect to a
//! different host is NOT followed here; the model is told where it points and
//! has to fetch that, which raises the card for the new host. `web_search`
//! goes through juno-backend (`POST /agent/desktop-search`), never to a
//! search engine from here.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

/// Readable text past this is cut, with a line saying so.
pub const MAX_PAGE_CHARS: usize = 12_000;
/// Bytes read from a response before giving up on the rest.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

/// The lower-cased host of an http(s) URL, or the reason it is not one.
pub fn host_of(raw: &str) -> Result<String, &'static str> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "bad_url")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("bad_url");
    }
    let host = url.host_str().ok_or("bad_url")?.to_ascii_lowercase();
    if is_private_host(&host) {
        return Err("private_address");
    }
    Ok(host)
}

/// This machine, the local network and link-local addresses: a page must not
/// be able to point the task at the user's router or a local service.
fn is_private_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let single_label = !host.contains('.') && !host.contains(':');
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || single_label {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified(),
        Ok(std::net::IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

fn fetch_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AuraDesktop/1.0")
            // Same host only: a hop to another site needs its own approval.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let same_host = attempt
                    .previous()
                    .first()
                    .map(|first| first.host_str() == attempt.url().host_str())
                    .unwrap_or(false);
                if same_host && attempt.previous().len() < 10 {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .expect("operator fetch client")
    })
}

/// Fetches a page and returns its readable text, headed by the final URL.
pub async fn fetch(raw_url: &str) -> Result<String, String> {
    let mut response = fetch_client()
        .get(raw_url.trim())
        .send()
        .await
        .map_err(|error| if error.is_timeout() { "timeout".to_string() } else { "unreachable".to_string() })?;
    let status = response.status();
    if status.is_redirection() {
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let next = response.url().join(location).map(|url| url.to_string()).unwrap_or_default();
        return Ok(format!("REDIRECT: this page moves to another site: {next}\nFetch that URL to follow it."));
    }
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let textual = content_type.is_empty()
        || content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml");
    if !textual {
        return Ok(format!("URL: {final_url}\nSTATUS: {}\n(not a text page: {content_type})", status.as_u16()));
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "read_failed".to_string())? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= MAX_BODY_BYTES {
            break;
        }
    }
    let body = String::from_utf8_lossy(&bytes);
    let text = if content_type.contains("html") || body.trim_start().starts_with('<') {
        readable_text(&body)
    } else {
        body.into_owned()
    };
    let total = text.chars().count();
    let mut text: String = text.chars().take(MAX_PAGE_CHARS).collect();
    if total > MAX_PAGE_CHARS {
        text.push_str(&format!("\n(clipped: {total} characters in all)"));
    }
    Ok(format!("URL: {final_url}\nSTATUS: {}\n\n{text}", status.as_u16()))
}

fn pattern(cell: &'static OnceLock<Regex>, source: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(source).expect("operator html pattern"))
}

/// HTML to plain text: scripts, styles and page chrome dropped, block ends kept
/// as line breaks, tags stripped, common entities decoded, blank runs folded.
fn readable_text(html: &str) -> String {
    static TITLE: OnceLock<Regex> = OnceLock::new();
    static DROPPED: [OnceLock<Regex>; 8] = [const { OnceLock::new() }; 8];
    static BREAKS: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static NUMERIC: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    static BLANKS: OnceLock<Regex> = OnceLock::new();

    let title = pattern(&TITLE, r"(?is)<title[^>]*>(.*?)</title>")
        .captures(html)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_default();
    let mut text = html.to_string();
    // The regex crate has no backreferences, so one pattern per element.
    for (cell, tag) in DROPPED.iter().zip(["script", "style", "noscript", "svg", "nav", "footer", "header", "head"]) {
        text = pattern(cell, &format!(r"(?is)<{tag}\b.*?</{tag}\s*>")).replace_all(&text, " ").into_owned();
    }
    text = pattern(&BREAKS, r"(?i)<br\s*/?>|</(p|div|li|tr|h[1-6]|section|article|pre|table|ul|ol|dt|dd|blockquote)\s*>")
        .replace_all(&text, "\n")
        .into_owned();
    text = pattern(&TAGS, r"(?s)<[^>]*>").replace_all(&text, " ").into_owned();
    text = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    text = pattern(&NUMERIC, r"&#(x?[0-9a-fA-F]+);")
        .replace_all(&text, |caps: &regex::Captures| {
            let raw = &caps[1];
            let code = match raw.strip_prefix('x').or_else(|| raw.strip_prefix('X')) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => raw.parse().ok(),
            };
            code.and_then(char::from_u32).map(String::from).unwrap_or_default()
        })
        .into_owned();
    text = pattern(&SPACES, r"[ \t\r\f\v]+").replace_all(&text, " ").into_owned();
    text = pattern(&BLANKS, r"\n( ?\n)+").replace_all(&text, "\n\n").into_owned();
    let body = text.lines().map(str::trim).collect::<Vec<_>>().join("\n").trim().to_string();
    if title.is_empty() {
        body
    } else {
        format!("TITLE: {title}\n\n{body}")
    }
}

/// One search through juno-backend: titles, URLs and the provider's excerpt.
pub async fn search(token: String, task_id: &str, query: &str) -> Result<String, String> {
    let response = reqwest::Client::builder()
        .timeout(SEARCH_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?
        .post(format!("{}/agent/desktop-search", super::API_BASE_URL))
        .bearer_auth(token)
        .json(&json!({ "task_id": task_id, "query": query }))
        .send()
        .await
        .map_err(|error| if error.is_timeout() { "timeout".to_string() } else { "unreachable".to_string() })?;
    let status = response.status().as_u16();
    let parsed: Value = response.json().await.unwrap_or(Value::Null);
    if status != 200 {
        let code = parsed.get("error").and_then(Value::as_str).unwrap_or("search_failed");
        return Err(code.to_string());
    }
    let mut lines: Vec<String> = parsed
        .get("results")
        .and_then(Value::as_array)
        .map(|results| {
            results
                .iter()
                .enumerate()
                .map(|(index, result)| {
                    format!(
                        "{}. {}\n   {}",
                        index + 1,
                        result.get("title").and_then(Value::as_str).unwrap_or(""),
                        result.get("url").and_then(Value::as_str).unwrap_or("")
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if lines.is_empty() {
        lines.push("(no results)".to_string());
    }
    let excerpt = parsed.get("text").and_then(Value::as_str).unwrap_or("");
    Ok(if excerpt.is_empty() { lines.join("\n") } else { format!("{}\n\n{excerpt}", lines.join("\n")) })
}
