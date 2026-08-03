//! Export to a NeMo-trainable dataset.
//!
//! Written to `Downloads/Aura Dictation Traces/<timestamp>/`, the same place and
//! shape `meeting::export_local_recording` uses, so there is one answer to
//! "where did my export go".
//!
//! ```text
//! audio/<trace_id>.wav      16 kHz mono PCM16
//! manifest.jsonl            NeMo ASR manifest: audio_filepath, duration, text
//! corrections.jsonl         edits that ARE evidence about the recognizer
//! style_edits.jsonl         edits that are NOT, kept separate on purpose
//! traces.jsonl              every record, including the ones no manifest line
//!                           was written for, so nothing is silently dropped
//! README.txt                what each file is
//! ```
//!
//! The separation between `corrections.jsonl` and `style_edits.jsonl` is the
//! whole point of the export, not a convenience. Training on a style edit
//! teaches the model to transcribe words that were never spoken, so the two
//! must not arrive in one undifferentiated pile and leave the reader to guess.

#![cfg(windows)]

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::record::EditClass;
use super::store;

/// What the settings page reports after an export.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub directory: String,
    /// Lines written to `manifest.jsonl`: traces that are actually trainable.
    pub manifest_lines: usize,
    pub audio_files: usize,
    pub correction_edits: usize,
    pub style_edits: usize,
    /// Records that were exported to `traces.jsonl` but produced no manifest
    /// line, and why that is not a bug. Counted so the number is never a
    /// surprise.
    pub skipped: usize,
}

/// One NeMo manifest line.
///
/// `audio_filepath`, `duration` and `text` are the three fields NeMo's dataset
/// guide requires; the rest are extra fields, which NeMo tolerates and which
/// make the corpus auditable after the fact. `text` is the ground truth, never
/// the raw decode and never the user's final text: see `diff.rs`.
#[derive(Serialize)]
struct ManifestLine<'a> {
    audio_filepath: String,
    duration: f64,
    text: &'a str,
    trace_id: &'a str,
    /// What the recognizer actually emitted, so word-error-rate against the
    /// label can be computed straight from the manifest.
    asr_text: &'a str,
    /// What was typed into the field, before the user touched it.
    inserted_text: &'a str,
    app: &'a str,
    model_id: &'a str,
    recorded_at_ms: i64,
    /// True when the user's edits were actually observed. A false here means
    /// "nobody checked", not "the transcript was correct".
    verified: bool,
}

#[derive(Serialize)]
struct EditLine<'a> {
    trace_id: &'a str,
    class: EditClass,
    from: &'a str,
    to: &'a str,
    word_index: usize,
    asr_text: &'a str,
    inserted_text: &'a str,
    final_text: &'a str,
    app: &'a str,
}

/// Writes the whole dataset.
///
/// `only_verified` keeps the manifest to traces whose field was actually
/// re-read. Defaulted on by the caller, because an unverified trace is a
/// transcript nobody confirmed: fine as a record, risky as a label.
pub fn export(
    app: &AppHandle,
    include_audio: bool,
    only_verified: bool,
) -> Result<ExportResult, String> {
    let records = store::list(app, usize::MAX)?;
    if records.is_empty() {
        return Err("There are no dictation traces to export yet.".to_string());
    }

    let stamp = chrono_stamp();
    let root = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?
        .join("Aura Dictation Traces")
        .join(&stamp);
    let audio_root = root.join("audio");
    std::fs::create_dir_all(&audio_root).map_err(|e| e.to_string())?;

    let mut manifest = String::new();
    let mut corrections = String::new();
    let mut styles = String::new();
    let mut traces = String::new();
    let mut result = ExportResult {
        directory: root.to_string_lossy().to_string(),
        manifest_lines: 0,
        audio_files: 0,
        correction_edits: 0,
        style_edits: 0,
        skipped: 0,
    };

    for record in &records {
        push_line(&mut traces, record)?;

        for edit in &record.edits {
            let line = EditLine {
                trace_id: &record.trace_id,
                class: edit.class,
                from: &edit.from,
                to: &edit.to,
                word_index: edit.word_index,
                asr_text: &record.raw_transcript,
                inserted_text: &record.inserted_text,
                final_text: record.final_text.as_deref().unwrap_or_default(),
                app: &record.app,
            };
            if edit.class.is_ground_truth() {
                push_line(&mut corrections, &line)?;
                result.correction_edits += 1;
            } else {
                push_line(&mut styles, &line)?;
                result.style_edits += 1;
            }
        }

        // A manifest line needs audio on disk and a settled state. Anything
        // else stays in traces.jsonl only: it is still a record of what
        // happened, it just is not a training pair.
        let trainable = record.has_audio
            && record.state.is_settled()
            && (!only_verified || record.is_verified());
        if !trainable || !include_audio {
            result.skipped += 1;
            continue;
        }
        let Ok(wav_bytes) = store::read_audio(app, &record.trace_id) else {
            result.skipped += 1;
            continue;
        };
        let file_name = format!("{}.wav", record.trace_id);
        std::fs::write(audio_root.join(&file_name), &wav_bytes).map_err(|e| e.to_string())?;
        result.audio_files += 1;

        push_line(
            &mut manifest,
            &ManifestLine {
                // Relative, so the folder can be moved or copied to a training
                // machine without every path breaking. NeMo resolves these
                // against the manifest's own location.
                audio_filepath: format!("audio/{file_name}"),
                duration: record.duration_seconds(),
                text: record.training_text(),
                trace_id: &record.trace_id,
                asr_text: &record.raw_transcript,
                inserted_text: &record.inserted_text,
                app: &record.app,
                model_id: &record.model_id,
                recorded_at_ms: record.recorded_at_ms,
                verified: record.is_verified(),
            },
        )?;
        result.manifest_lines += 1;
    }

    std::fs::write(root.join("manifest.jsonl"), manifest).map_err(|e| e.to_string())?;
    std::fs::write(root.join("corrections.jsonl"), corrections).map_err(|e| e.to_string())?;
    std::fs::write(root.join("style_edits.jsonl"), styles).map_err(|e| e.to_string())?;
    std::fs::write(root.join("traces.jsonl"), traces).map_err(|e| e.to_string())?;
    std::fs::write(root.join("README.txt"), readme(&result)).map_err(|e| e.to_string())?;

    Ok(result)
}

fn push_line<T: Serialize>(out: &mut String, value: &T) -> Result<(), String> {
    out.push_str(&serde_json::to_string(value).map_err(|e| e.to_string())?);
    out.push('\n');
    Ok(())
}

/// `YYYY-MM-DD_HHMMSS` from the wall clock, without pulling in a date crate for
/// one filename. Days since the epoch converted through the civil-date algorithm
/// (Howard Hinnant's `civil_from_days`), which is exact for every date this will
/// ever see.
fn chrono_stamp() -> String {
    let seconds = store::now_ms() / 1000;
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}_{:02}{:02}{:02}",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn readme(result: &ExportResult) -> String {
    format!(
        "Aura on-device dictation traces\n\
         ================================\n\n\
         Everything in this folder was recorded on this PC, from this PC's\n\
         microphone, and has never been uploaded anywhere. You exported it\n\
         yourself; deleting this folder deletes this copy of it.\n\n\
         manifest.jsonl ({} lines)\n\
         \x20 NeMo ASR manifest. Each line has audio_filepath (relative to this\n\
         \x20 folder), duration in seconds, and text.\n\
         \x20 `text` is the corrected transcript: what was typed, with the user's\n\
         \x20 recognition fixes applied and their stylistic rewrites NOT applied.\n\
         \x20 `asr_text` is the raw model output, so word error rate against\n\
         \x20 `text` can be computed directly.\n\n\
         corrections.jsonl ({} edits)\n\
         \x20 Edits that are evidence the recognizer got the audio wrong:\n\
         \x20 verbatim word errors, casing, and punctuation. These ARE folded\n\
         \x20 into manifest `text`.\n\n\
         style_edits.jsonl ({} edits)\n\
         \x20 Edits where the user changed what they wanted to say, plus removed\n\
         \x20 disfluencies. These are NOT folded into manifest `text`, because\n\
         \x20 the audio does not contain the rewritten words. Do not train an\n\
         \x20 acoustic model on these as if they were transcripts.\n\n\
         traces.jsonl\n\
         \x20 Every record, including the {} that produced no manifest line\n\
         \x20 (no audio kept, or the text field could not be re-read to confirm\n\
         \x20 what the user settled on).\n\n\
         audio/ ({} files)\n\
         \x20 16 kHz mono 16-bit PCM WAV, one per utterance.\n",
        result.manifest_lines,
        result.correction_edits,
        result.style_edits,
        result.skipped,
        result.audio_files,
    )
}

/// Where the export would go, for the settings page to show before anyone
/// commits to writing it.
pub fn export_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .download_dir()
        .ok()
        .map(|dir| dir.join("Aura Dictation Traces"))
}
