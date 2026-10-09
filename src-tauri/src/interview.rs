//! The interview preparation slots: the reviewed brief and the resume text,
//! held in process memory so every window reads the same ones.
//!
//! The live Interview Companion that used to run here (two ASR sockets over the
//! capture broker, the answer card, session history) moved to its own app,
//! SideKick, on 2026-10-08. What stays is what the Interview page and Interview
//! Mode still use: the dashboard writes the active brief here, and the Interview
//! Mode context card reads the resume.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::events::{
    INTERVIEW_BRIEF_UPDATED as BRIEF_EVENT, INTERVIEW_RESUME_UPDATED as RESUME_EVENT,
};
const MAX_BRIEF_BYTES: usize = 128_000;
// Generous next to the 20,000 characters the backend accepts, so a resume is
// rejected by the extractor's own limit rather than truncated silently here.
const MAX_RESUME_BYTES: usize = 64_000;

#[derive(Default)]
pub struct InterviewHandle(
    Mutex<Option<serde_json::Value>>,
    // Plain resume text, kept beside the brief because it is the same class of
    // preparation: user-supplied, cleared on sign-out, never persisted to disk.
    Mutex<Option<String>>,
);

#[tauri::command]
pub fn set_interview_hacker_brief(
    app: AppHandle,
    brief: serde_json::Value,
) -> Result<(), String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewHacker,
    )?;
    let object = brief
        .as_object()
        .ok_or_else(|| "Interview brief must be an object.".to_string())?;
    if object.get("contractVersion").and_then(serde_json::Value::as_u64) != Some(3)
        || object.get("briefId").and_then(serde_json::Value::as_str).is_none()
        || object.get("reviewedAtMs").and_then(serde_json::Value::as_u64).is_none()
    {
        return Err("Interview brief has not been reviewed.".to_string());
    }
    let encoded = serde_json::to_vec(&brief)
        .map_err(|_| "Interview brief could not be read.".to_string())?;
    if encoded.len() > MAX_BRIEF_BYTES {
        return Err("Interview brief is too large.".to_string());
    }
    let handle = app.state::<InterviewHandle>();
    *handle.0.lock().unwrap_or_else(|error| error.into_inner()) = Some(brief.clone());
    let _ = app.emit(BRIEF_EVENT, brief);
    Ok(())
}

#[tauri::command]
pub fn interview_hacker_brief(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewHacker,
    )?;
    let handle = app.state::<InterviewHandle>();
    let brief = handle
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    Ok(brief)
}

#[tauri::command]
pub fn clear_interview_hacker_brief(app: AppHandle) -> Result<(), String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewHacker,
    )?;
    clear_preparation(&app);
    Ok(())
}

#[tauri::command]
pub fn set_interview_resume(app: AppHandle, resume: String) -> Result<(), String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewHacker,
    )?;
    let resume = resume.trim().to_string();
    if resume.is_empty() {
        return Err("Resume text is empty.".to_string());
    }
    if resume.len() > MAX_RESUME_BYTES {
        return Err("Resume is too large.".to_string());
    }
    let handle = app.state::<InterviewHandle>();
    *handle.1.lock().unwrap_or_else(|error| error.into_inner()) = Some(resume.clone());
    let _ = app.emit(RESUME_EVENT, resume);
    Ok(())
}

#[tauri::command]
pub fn interview_resume(app: AppHandle) -> Result<Option<String>, String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewHacker,
    )?;
    let handle = app.state::<InterviewHandle>();
    let resume = handle
        .1
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    Ok(resume)
}

#[tauri::command]
pub fn clear_interview_resume(app: AppHandle) -> Result<(), String> {
    crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewHacker,
    )?;
    clear_stored_resume(&app);
    Ok(())
}

fn clear_stored_resume(app: &AppHandle) {
    let Some(handle) = app.try_state::<InterviewHandle>() else {
        return;
    };
    let removed = handle
        .1
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
        .is_some();
    if removed {
        let _ = app.emit(RESUME_EVENT, Option::<String>::None);
    }
}

pub fn clear_preparation(app: &AppHandle) {
    clear_stored_resume(app);
    let Some(handle) = app.try_state::<InterviewHandle>() else {
        return;
    };
    let removed = handle
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
        .is_some();
    if removed {
        let _ = app.emit(BRIEF_EVENT, Option::<serde_json::Value>::None);
    }
}

/// Fills the brief and resume slots from the on-disk preparation store at
/// sign-in, so whichever window mounts first sees the reviewed brief and the
/// resume. Same shape checks as `set_interview_hacker_brief`; a record that
/// fails them leaves the slots empty and the page's own restore path does what
/// it did. Fire-and-forget off the main thread: the session hook runs inside a
/// sync command and the store read decrypts a quarter megabyte at most.
pub fn hydrate_preparation(app: &AppHandle, uid: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let loaded = {
            let app = app.clone();
            let uid = uid.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::interview_prep_store::active_preparation(&app, &uid)
            })
            .await
        };
        let record = match loaded {
            Ok(Ok(Some(record))) => record,
            Ok(Ok(None)) => return,
            Ok(Err(error)) => {
                log::warn!("interview: preparation hydrate failed: {error}");
                return;
            }
            Err(error) => {
                log::warn!("interview: preparation hydrate join failed: {error}");
                return;
            }
        };
        let Some(handle) = app.try_state::<InterviewHandle>() else {
            return;
        };
        let brief = record.get("draftBrief").cloned().filter(|brief| {
            brief.as_object().is_some_and(|object| {
                object.get("contractVersion").and_then(serde_json::Value::as_u64) == Some(3)
                    && object.get("briefId").and_then(serde_json::Value::as_str).is_some()
                    && object.get("reviewedAtMs").and_then(serde_json::Value::as_u64).is_some()
                    && serde_json::to_vec(brief).map(|bytes| bytes.len() <= MAX_BRIEF_BYTES).unwrap_or(false)
            })
        });
        let resume = record
            .get("input")
            .and_then(|input| input.get("resume"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.len() <= MAX_RESUME_BYTES)
            .map(str::to_string);
        if let Some(brief) = brief {
            *handle.0.lock().unwrap_or_else(|error| error.into_inner()) = Some(brief.clone());
            let _ = app.emit(BRIEF_EVENT, brief);
        }
        if let Some(resume) = resume {
            *handle.1.lock().unwrap_or_else(|error| error.into_inner()) = Some(resume.clone());
            let _ = app.emit(RESUME_EVENT, resume);
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewPrepExport {
    path: String,
}

/// Saves a prep room as Markdown, named for the company so several interviews in
/// Downloads stay easy to tell apart.
#[tauri::command]
pub async fn save_interview_prep(
    app: AppHandle,
    markdown: String,
    company: String,
) -> Result<InterviewPrepExport, String> {
    let trimmed = markdown.trim();
    if trimmed.is_empty() || trimmed.len() > 64_000 {
        return Err("Interview prep is empty or too large.".to_string());
    }
    let ticket = crate::security::authorize(
        &app,
        crate::security::Operation::StartInterviewHacker,
    )?;
    let destination = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?
        .join("Aura Interview Prep")
        .join(format!("{}-prep-{}.md", file_slug(&company), crate::util::now_ms()));
    let content = format!("{}\n", trimmed);
    let output = destination.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let parent = output
            .parent()
            .ok_or("Interview prep path is invalid.".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| error.to_string())?;
        use std::io::Write as _;
        file.write_all(content.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::security::recheck(
        &app,
        crate::security::Operation::StartInterviewHacker,
        &ticket,
    )?;
    Ok(InterviewPrepExport {
        path: destination.to_string_lossy().to_string(),
    })
}

fn file_slug(value: &str) -> String {
    let mut slug = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "interview".to_string()
    } else {
        slug.to_string()
    }
}
