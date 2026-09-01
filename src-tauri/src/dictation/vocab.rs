//! Personalization storage, contextual biasing, and the post-decode
//! correction pass.
//!
//! Tier 0 (contextual biasing) is real again. The on-device Nemotron decoder
//! this replaced could not accept hotwords at all, so the vocabulary was
//! post-decode only. The cloud recognizer supports key term prompting, so
//! `keyterms_for` now sends the same user-owned phrases INTO recognition,
//! where they can fix a word rather than patch it up afterwards.
//!
//! Tier 1 (post-decode corrections): phrase-anchored replacements that only
//! apply once the same correction has been confirmed at least
//! `MIN_CORRECTION_COUNT` times, plus double-metaphone aliases against the
//! vocabulary. A bare common word is never substituted: promoting "to" to
//! "two" once would wreck every later sentence.
//!
//! At rest both files are AES-256-GCM encrypted under a key wrapped by Windows
//! DPAPI in current-user scope. The mechanism lives in crate::crypto, but this
//! module mints its OWN key in its OWN directory on purpose: meeting's key.bin
//! lives under the captures directory, so sharing it would mean "delete my
//! recordings" silently bricks the dictation vocabulary.


use std::collections::HashMap;
use std::path::PathBuf;

use rphonetic::{DoubleMetaphone, Encoder};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Own directory, own key. See the module header for why this is not shared
/// with the meeting module's captures directory.
const DICTATION_DIR: &str = "dictation";
const KEY_FILE: &str = "key.bin";
const VOCAB_FILE: &str = "vocab.enc";
const CORRECTIONS_FILE: &str = "corrections.enc";

/// A correction has to be confirmed this many times before it is ever applied.
/// One mis-heard word is noise; three identical fixes is a pattern.
const MIN_CORRECTION_COUNT: u32 = 3;
/// Ceiling on stored phrases per bucket, so a runaway writer cannot grow the
/// biasing list until stream creation gets slow.
const MAX_PHRASES_PER_BUCKET: usize = 256;
const MAX_CORRECTIONS: usize = 512;

/// Words that must never be produced BY a correction or alias substitution.
/// Short function words carry the sentence, and a single bad promotion here
/// corrupts every later utterance rather than one word of one utterance.
const COMMON_WORDS: &[&str] = &[
    "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "back",
    "be", "because", "been", "before", "but", "by", "call", "can", "come", "could", "day", "did",
    "do", "does", "down", "each", "even", "find", "first", "for", "from", "get", "give", "go",
    "good", "had", "has", "have", "he", "her", "here", "him", "his", "how", "i", "if", "in",
    "into", "is", "it", "its", "just", "know", "like", "look", "make", "man", "many", "me", "more",
    "most", "my", "new", "no", "not", "now", "of", "on", "one", "only", "or", "other", "our",
    "out", "over", "people", "say", "see", "she", "so", "some", "take", "than", "that", "the",
    "their", "them", "then", "there", "these", "they", "thing", "think", "this", "those", "time",
    "to", "two", "up", "us", "use", "very", "want", "was", "way", "we", "well", "were", "what",
    "when", "which", "who", "why", "will", "with", "work", "would", "year", "you", "your",
];

fn is_common_word(word: &str) -> bool {
    COMMON_WORDS.contains(&word.to_ascii_lowercase().as_str())
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct VocabStore {
    /// Phrases biased in every application.
    #[serde(default)]
    pub global: Vec<String>,
    /// Phrases biased only when the named exe stem owns the foreground window.
    #[serde(default)]
    pub apps: HashMap<String, Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CorrectionEntry {
    /// What the decoder produced.
    pub heard: String,
    /// What it should have been.
    pub replacement: String,
    /// How many times this exact pair has been confirmed.
    #[serde(default)]
    pub count: u32,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct CorrectionStore {
    #[serde(default)]
    pub entries: Vec<CorrectionEntry>,
}

pub(super) fn dictation_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(DICTATION_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Loads the dictation key, minting and DPAPI-wrapping a fresh one on first
/// use. A wrapped blob that no longer unwraps fails closed rather than being
/// replaced, so a machine/profile change surfaces as an error instead of
/// silently discarding a vocabulary the user spent weeks building.
pub(super) fn load_or_create_key(app: &AppHandle) -> Result<[u8; 32], String> {
    crate::crypto::load_or_create_key_at(&dictation_dir(app)?.join(KEY_FILE), "dictation")
}

pub(super) use crate::crypto::encrypt;

pub(super) fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    // Pre-check so the short-input error keeps naming the dictation store
    // rather than the shared module's generic wording.
    if data.len() <= crate::crypto::NONCE_LEN {
        return Err("dictation store too short to decrypt".to_string());
    }
    crate::crypto::decrypt(key, data)
}

fn read_store<T: Default + for<'de> Deserialize<'de>>(
    app: &AppHandle,
    file: &str,
) -> Result<T, String> {
    let path = dictation_dir(app)?.join(file);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(T::default());
    };
    let key = load_or_create_key(app)?;
    let plain = decrypt(&key, &bytes)?;
    serde_json::from_slice(&plain).map_err(|e| e.to_string())
}

fn write_store<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> Result<(), String> {
    let dir = dictation_dir(app)?;
    let key = load_or_create_key(app)?;
    let plain = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let sealed = encrypt(&key, &plain)?;
    let path = dir.join(file);
    crate::fsx::write_atomic(&path, &sealed, crate::fsx::Durability::Fsync)
}

pub fn load_vocab(app: &AppHandle) -> Result<VocabStore, String> {
    read_store::<VocabStore>(app, VOCAB_FILE)
}

pub fn load_corrections(app: &AppHandle) -> Result<CorrectionStore, String> {
    read_store::<CorrectionStore>(app, CORRECTIONS_FILE)
}

/// Adds phrases to the global list (`app_key` = None) or to one app's list.
/// Returns how many phrases were newly stored.
pub fn add_phrases(
    app: &AppHandle,
    app_key: Option<&str>,
    phrases: &[String],
) -> Result<usize, String> {
    let mut store = load_vocab(app)?;
    let bucket = match app_key {
        Some(key) => store.apps.entry(key.to_ascii_lowercase()).or_default(),
        None => &mut store.global,
    };
    let mut added = 0usize;
    for phrase in phrases {
        let trimmed = phrase.trim();
        if trimmed.is_empty() || bucket.len() >= MAX_PHRASES_PER_BUCKET {
            continue;
        }
        if bucket.iter().any(|existing| existing.eq_ignore_ascii_case(trimmed)) {
            continue;
        }
        bucket.push(trimmed.to_string());
        added += 1;
    }
    if added > 0 {
        write_store(app, VOCAB_FILE, &store)?;
    }
    Ok(added)
}

/// Records one confirmed correction, incrementing its count when the same pair
/// has been seen before. Returns the pair's count after the update.
pub fn record_correction(
    app: &AppHandle,
    heard: &str,
    replacement: &str,
) -> Result<u32, String> {
    let heard = heard.trim();
    let replacement = replacement.trim();
    if heard.is_empty() || replacement.is_empty() {
        return Err("a correction needs both a heard phrase and a replacement".to_string());
    }
    if heard.eq_ignore_ascii_case(replacement) {
        return Err("a correction must actually change the text".to_string());
    }
    let mut store = load_corrections(app)?;
    if let Some(entry) = store
        .entries
        .iter_mut()
        .find(|entry| entry.heard.eq_ignore_ascii_case(heard) && entry.replacement == replacement)
    {
        entry.count = entry.count.saturating_add(1);
        let count = entry.count;
        write_store(app, CORRECTIONS_FILE, &store)?;
        return Ok(count);
    }
    if store.entries.len() >= MAX_CORRECTIONS {
        store.entries.remove(0);
    }
    store.entries.push(CorrectionEntry {
        heard: heard.to_string(),
        replacement: replacement.to_string(),
        count: 1,
    });
    write_store(app, CORRECTIONS_FILE, &store)?;
    Ok(1)
}

/// The biasing terms for one utterance, in priority order, capped at `limit`.
///
/// Three sources, deliberately in this order:
///   1. the phrases the user saved for the app they are typing into,
///   2. their global phrases,
///   3. the REPLACEMENT side of corrections they have confirmed often enough
///      to be applied post-decode.
///
/// (3) is the interesting one. A correction the user has made three times is
/// direct evidence of a word the recognizer keeps getting wrong, which is
/// exactly what a biasing hint is for. Feeding it forward means the next
/// utterance has a chance of being right the first time instead of being
/// fixed after the fact. The `heard` side is never sent - that is the wrong
/// word, and biasing toward it would entrench the mistake.
///
/// Common words are excluded throughout. Biasing toward "the" is at best
/// wasted budget and at worst actively harmful.
pub fn keyterms_for(
    vocab: &VocabStore,
    corrections: &CorrectionStore,
    app_key: Option<&str>,
    limit: usize,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let push = |phrase: &str, out: &mut Vec<String>, seen: &mut Vec<String>| {
        let trimmed = phrase.trim();
        if trimmed.is_empty() || is_common_word(trimmed) {
            return;
        }
        let folded = trimmed.to_ascii_lowercase();
        if seen.contains(&folded) {
            return;
        }
        seen.push(folded);
        out.push(trimmed.to_string());
    };

    if let Some(key) = app_key {
        if let Some(app_phrases) = vocab.apps.get(&key.to_ascii_lowercase()) {
            for phrase in app_phrases {
                push(phrase, &mut out, &mut seen);
            }
        }
    }
    for phrase in &vocab.global {
        push(phrase, &mut out, &mut seen);
    }
    for entry in &corrections.entries {
        if entry.count >= MIN_CORRECTION_COUNT {
            push(&entry.replacement, &mut out, &mut seen);
        }
    }
    out.truncate(limit);
    out
}

/// The tier 1 pass, run on the final text only. Deliberately cheap (well under
/// 5ms for realistic store sizes) because it sits between the decoder flush and
/// the keystrokes the user is waiting on.
pub fn apply_corrections(
    text: &str,
    corrections: &CorrectionStore,
    vocab: &VocabStore,
    app_key: Option<&str>,
) -> String {
    let mut out = text.to_string();

    // Pass 1: explicit, phrase-anchored replacements. Only confirmed pairs
    // apply, and a single-word heard side that is a common word is skipped
    // outright no matter how many times it was confirmed.
    for entry in &corrections.entries {
        if entry.count < MIN_CORRECTION_COUNT {
            continue;
        }
        if !entry.heard.contains(' ') && is_common_word(&entry.heard) {
            continue;
        }
        out = replace_phrase(&out, &entry.heard, &entry.replacement);
    }

    // Pass 2: phonetic aliases against the biasing vocabulary. This only ever
    // promotes a decoded word INTO a vocabulary term, never the other way, and
    // never touches a word that is itself a common word.
    let terms = single_word_terms(vocab, app_key);
    if terms.is_empty() {
        return out;
    }
    let encoder = DoubleMetaphone::default();
    let coded: Vec<(String, String)> = terms
        .iter()
        .map(|term| (encoder.encode(term), term.clone()))
        .filter(|(code, _)| !code.is_empty())
        .collect();

    let mut rebuilt = String::with_capacity(out.len());
    for token in split_keeping_separators(&out) {
        let core = token.trim_matches(|c: char| !c.is_alphanumeric());
        if core.is_empty() || is_common_word(core) || core.chars().count() < 3 {
            rebuilt.push_str(token);
            continue;
        }
        let code = encoder.encode(core);
        let alias = coded.iter().find(|(term_code, term)| {
            !code.is_empty() && *term_code == code && !term.eq_ignore_ascii_case(core)
        });
        match alias {
            Some((_, term)) => rebuilt.push_str(&token.replacen(core, term, 1)),
            None => rebuilt.push_str(token),
        }
    }
    rebuilt
}

fn single_word_terms(vocab: &VocabStore, app_key: Option<&str>) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut push = |phrase: &String| {
        let trimmed = phrase.trim();
        if !trimmed.is_empty() && !trimmed.contains(' ') && !is_common_word(trimmed) {
            terms.push(trimmed.to_string());
        }
    };
    for phrase in &vocab.global {
        push(phrase);
    }
    if let Some(key) = app_key {
        if let Some(app_phrases) = vocab.apps.get(&key.to_ascii_lowercase()) {
            for phrase in app_phrases {
                push(phrase);
            }
        }
    }
    terms
}

/// Case-insensitive comparison of two characters. Compares the full lowercase
/// EXPANSIONS rather than a single mapped char, because some characters lower
/// to more than one (Turkish dotted capital I is the classic case).
fn chars_eq_ignore_case(left: char, right: char) -> bool {
    left == right || left.to_lowercase().eq(right.to_lowercase())
}

/// Case-insensitive whole-phrase replacement. Anchored on both ends so
/// "count" never rewrites the inside of "accountant".
///
/// Every byte offset used here comes from the ORIGINAL string. An earlier
/// version searched a `to_lowercase()` copy and applied those offsets back to
/// the original, which panics the moment a case conversion changes byte length:
/// Turkish dotted capital I is two bytes and lowers to three. That panic would
/// have killed the worker mid-transcript and handed the payload to the panic
/// hook, so this comparison is a correctness AND a privacy fix.
fn replace_phrase(haystack: &str, needle: &str, replacement: &str) -> String {
    let needle_chars: Vec<char> = needle.chars().collect();
    if needle_chars.is_empty() {
        return haystack.to_string();
    }
    let hay: Vec<(usize, char)> = haystack.char_indices().collect();
    let mut out = String::with_capacity(haystack.len());
    let mut index = 0usize;
    let mut copied = 0usize;
    while index < hay.len() {
        let matches = hay.len() - index >= needle_chars.len()
            && (0..needle_chars.len())
                .all(|offset| chars_eq_ignore_case(hay[index + offset].1, needle_chars[offset]));
        if matches {
            let after = index + needle_chars.len();
            let before_ok = index == 0 || !hay[index - 1].1.is_alphanumeric();
            let after_ok = after >= hay.len() || !hay[after].1.is_alphanumeric();
            if before_ok && after_ok {
                let start = hay[index].0;
                let end = hay.get(after).map_or(haystack.len(), |(byte, _)| *byte);
                out.push_str(&haystack[copied..start]);
                out.push_str(replacement);
                copied = end;
                index = after;
                continue;
            }
        }
        index += 1;
    }
    out.push_str(&haystack[copied..]);
    out
}

/// Splits on whitespace while keeping the whitespace runs as their own tokens,
/// so rebuilding the string preserves the decoder's exact spacing.
fn split_keeping_separators(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut in_space = None::<bool>;
    for (index, ch) in text.char_indices() {
        let is_space = ch.is_whitespace();
        match in_space {
            None => in_space = Some(is_space),
            Some(previous) if previous != is_space => {
                parts.push(&text[start..index]);
                start = index;
                in_space = Some(is_space);
            }
            _ => {}
        }
    }
    if start < text.len() {
        parts.push(&text[start..]);
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab(global: &[&str], app: &[(&str, &[&str])]) -> VocabStore {
        VocabStore {
            global: global.iter().map(|s| s.to_string()).collect(),
            apps: app
                .iter()
                .map(|(key, phrases)| {
                    (
                        key.to_string(),
                        phrases.iter().map(|s| s.to_string()).collect(),
                    )
                })
                .collect(),
        }
    }

    fn corrections(entries: &[(&str, &str, u32)]) -> CorrectionStore {
        CorrectionStore {
            entries: entries
                .iter()
                .map(|(heard, replacement, count)| CorrectionEntry {
                    heard: heard.to_string(),
                    replacement: replacement.to_string(),
                    count: *count,
                })
                .collect(),
        }
    }

    #[test]
    fn the_focused_apps_phrases_come_before_the_global_ones() {
        let store = vocab(&["Aura"], &[("slack", &["Buddy"])]);
        let terms = keyterms_for(&store, &CorrectionStore::default(), Some("slack"), 50);
        assert_eq!(terms, vec!["Buddy".to_string(), "Aura".to_string()]);
    }

    #[test]
    fn another_apps_phrases_are_not_sent() {
        let store = vocab(&["Aura"], &[("slack", &["Buddy"])]);
        let terms = keyterms_for(&store, &CorrectionStore::default(), Some("notepad"), 50);
        assert_eq!(terms, vec!["Aura".to_string()]);
    }

    #[test]
    fn a_confirmed_correction_biases_toward_the_replacement_never_the_misheard_word() {
        let store = vocab(&[], &[]);
        let terms = keyterms_for(
            &store,
            &corrections(&[("or a", "Aura", MIN_CORRECTION_COUNT)]),
            None,
            50,
        );
        assert_eq!(terms, vec!["Aura".to_string()]);
        assert!(
            !terms.iter().any(|term| term == "or a"),
            "biasing toward the misheard form would entrench the mistake"
        );
    }

    #[test]
    fn corrections_below_the_confirmation_threshold_are_not_biased() {
        let store = vocab(&[], &[]);
        let terms = keyterms_for(
            &store,
            &corrections(&[("or a", "Aura", MIN_CORRECTION_COUNT - 1)]),
            None,
            50,
        );
        assert!(terms.is_empty());
    }

    #[test]
    fn duplicates_are_collapsed_case_insensitively() {
        let store = vocab(&["Aura", "aura", "AURA"], &[("slack", &["aura"])]);
        let terms = keyterms_for(
            &store,
            &corrections(&[("or a", "Aura", MIN_CORRECTION_COUNT)]),
            Some("slack"),
            50,
        );
        assert_eq!(terms.len(), 1);
    }

    #[test]
    fn common_words_are_never_biased() {
        let store = vocab(&["the", "Aura", "and"], &[]);
        let terms = keyterms_for(&store, &CorrectionStore::default(), None, 50);
        assert_eq!(terms, vec!["Aura".to_string()]);
    }

    #[test]
    fn the_list_is_capped_and_keeps_the_highest_priority_terms() {
        let global: Vec<String> = (0..80).map(|i| format!("term{i}")).collect();
        let store = VocabStore {
            global,
            apps: Default::default(),
        };
        let terms = keyterms_for(&store, &CorrectionStore::default(), None, 50);
        assert_eq!(terms.len(), 50);
        assert_eq!(terms[0], "term0");
    }

    #[test]
    fn blank_and_whitespace_phrases_are_dropped() {
        let store = vocab(&["  ", "", "Aura"], &[]);
        let terms = keyterms_for(&store, &CorrectionStore::default(), None, 50);
        assert_eq!(terms, vec!["Aura".to_string()]);
    }
}
