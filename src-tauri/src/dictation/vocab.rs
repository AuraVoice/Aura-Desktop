//! Personalization storage and the post-decode correction pass.
//!
//! Contextual biasing is unavailable for the selected Nemotron greedy decoder.
//! Vocabulary terms remain local and feed the post-decode correction pass.
//!
//! Tier 1 (post-decode corrections): phrase-anchored replacements that only
//! apply once the same correction has been confirmed at least
//! `MIN_CORRECTION_COUNT` times, plus double-metaphone aliases against the
//! vocabulary. A bare common word is never substituted: promoting "to" to
//! "two" once would wreck every later sentence.
//!
//! At rest both files are AES-256-GCM encrypted under a key wrapped by Windows
//! DPAPI in current-user scope. This mirrors meeting/crypto.rs but mints its
//! OWN key in its OWN directory on purpose: meeting's key.bin lives under the
//! captures directory, so sharing it would mean "delete my recordings" silently
//! bricks the dictation vocabulary.

#![cfg(windows)]

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use rphonetic::{DoubleMetaphone, Encoder};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Own directory, own key. See the module header for why this is not shared
/// with the meeting module's captures directory.
const DICTATION_DIR: &str = "dictation";
const KEY_FILE: &str = "key.bin";
const VOCAB_FILE: &str = "vocab.enc";
const CORRECTIONS_FILE: &str = "corrections.enc";
const NONCE_LEN: usize = 12;

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
    let path = dictation_dir(app)?.join(KEY_FILE);
    if let Ok(wrapped) = std::fs::read(&path) {
        let key_bytes = dpapi_unprotect(&wrapped)
            .map_err(|e| format!("stored dictation key could not be unwrapped: {e}"))?;
        if key_bytes.len() != 32 {
            return Err("stored dictation key has an invalid length".to_string());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_bytes);
        return Ok(key);
    }

    let key = Aes256Gcm::generate_key(OsRng);
    let wrapped = dpapi_protect(key.as_slice())?;
    let tmp = path.with_extension(format!("bin.{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    file.write_all(&wrapped).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    let mut out = [0u8; 32];
    out.copy_from_slice(key.as_slice());
    Ok(out)
}

pub(super) fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("encrypt failed: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub(super) fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() <= NONCE_LEN {
        return Err("dictation store too short to decrypt".to_string());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&data[..NONCE_LEN]);
    cipher
        .decrypt(nonce, &data[NONCE_LEN..])
        .map_err(|e| format!("decrypt failed: {e}"))
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
    let tmp = path.with_extension(format!("enc.{}.tmp", std::process::id()));
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    handle.write_all(&sealed).map_err(|e| e.to_string())?;
    handle.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
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

fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("CryptProtectData failed: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(bytes)
    }
}

fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("CryptUnprotectData failed: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(bytes)
    }
}
