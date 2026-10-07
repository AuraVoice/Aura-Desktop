//! Picks what a manager should be reminded of for one brief: idf-weighted token
//! overlap over key and text, times the decayed confidence, times a small
//! recency boost. A manager's corpus is a few hundred rows at most, so this is
//! sub-millisecond and fully inspectable; no embeddings until a corpus proves
//! them necessary.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::store::{effective_confidence, format_iso_ms, LiveRow, RowType};

/// Hard cap on the serialized envelope, in characters.
const MAX_ENVELOPE_CHARS: usize = 2048;
const MAX_FACTS: usize = 8;
const MAX_OUTCOMES: usize = 6;
const MAX_PREFERENCES: usize = 10;
const MAX_REPORTED: usize = 60;
const MAX_THREADS: usize = 5;
/// Below this many matched rows the newest rows fill in, so a fresh brief is not blind.
const MIN_MATCHED: usize = 3;
const WEEK_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

const STOP_WORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "what", "when", "where", "which", "have",
    "has", "had", "are", "was", "were", "been", "will", "would", "could", "should", "can", "you",
    "your", "our", "its", "into", "about", "then", "than", "them", "they", "there", "their",
    "please", "also", "just", "any", "all", "but", "not", "out", "new", "get", "give", "tell",
    "find", "look", "make", "check", "update", "report", "latest",
];

#[derive(Debug, Clone, Serialize)]
pub struct EnvelopeRow {
    pub key: String,
    pub text: String,
    pub confidence: i64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvelopeThread {
    pub key: String,
    pub text: String,
}

/// The wire shape sent to the backend verbatim (snake_case on purpose).
#[derive(Debug, Clone, Serialize)]
pub struct Envelope {
    pub v: u8,
    pub manager_id: String,
    pub generated_at: String,
    pub facts: Vec<EnvelopeRow>,
    pub outcomes: Vec<EnvelopeRow>,
    pub preferences: Vec<EnvelopeRow>,
    pub reported_ids: Vec<String>,
    pub threads: Vec<EnvelopeThread>,
}

pub fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 3 && !STOP_WORDS.contains(t))
        .map(str::to_string)
        .collect()
}

fn source_word(stored: &str) -> String {
    if stored == "user" { "user_stated".to_string() } else { "observed".to_string() }
}

fn serialized_len(envelope: &Envelope) -> usize {
    serde_json::to_string(envelope).map(|s| s.chars().count()).unwrap_or(usize::MAX)
}

/// Scores the live rows of one manager against a brief and assembles the envelope.
/// `None` when the manager has nothing to say.
pub fn build(manager_id: &str, brief: &str, rows: &[LiveRow], now: i64) -> Option<Envelope> {
    if rows.is_empty() {
        return None;
    }
    let brief_terms: HashSet<String> = tokens(brief).into_iter().collect();
    // Document frequency per term over this manager's corpus.
    let mut df: HashMap<String, usize> = HashMap::new();
    let row_terms: Vec<HashSet<String>> = rows
        .iter()
        .map(|r| tokens(&format!("{} {}", r.key, r.text)).into_iter().collect::<HashSet<_>>())
        .collect();
    for terms in &row_terms {
        for t in terms {
            *df.entry(t.clone()).or_insert(0) += 1;
        }
    }
    let n = rows.len() as f64;
    let idf = |term: &str| ((n + 1.0) / (*df.get(term).unwrap_or(&0) as f64 + 0.5)).ln().max(0.0);

    let mut scored: Vec<(usize, f64, bool)> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let overlap: f64 = brief_terms.iter().filter(|t| row_terms[i].contains(*t)).map(|t| idf(t)).sum();
            let conf = effective_confidence(r.row_type, r.confidence, r.updated_at_ms, now);
            let age = (now - r.updated_at_ms).max(0) as f64;
            let recency = 1.0 + 0.5 * 0.5f64.powf(age / WEEK_MS);
            (i, overlap * conf * recency, overlap > 0.0)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(b.0.cmp(&a.0)));

    // Matched rows first; if fewer than MIN_MATCHED, the newest rows fill in (rows arrive newest first).
    let mut order: Vec<usize> = scored.iter().filter(|s| s.2).map(|s| s.0).collect();
    if order.len() < MIN_MATCHED {
        for (i, _) in rows.iter().enumerate() {
            if !order.contains(&i) {
                order.push(i);
            }
        }
    }

    let mut envelope = Envelope {
        v: 1,
        manager_id: manager_id.to_string(),
        generated_at: format_iso_ms(now),
        facts: Vec::new(),
        outcomes: Vec::new(),
        preferences: Vec::new(),
        reported_ids: Vec::new(),
        threads: Vec::new(),
    };
    let as_row = |r: &LiveRow| EnvelopeRow {
        key: r.key.clone(),
        text: r.text.clone(),
        confidence: effective_confidence(r.row_type, r.confidence, r.updated_at_ms, now).round().max(1.0) as i64,
        source: source_word(&r.source),
    };
    // Preferences and threads are binding and small: every live one, newest first, up to the cap.
    for r in rows.iter().filter(|r| r.row_type == RowType::Preference).take(MAX_PREFERENCES) {
        envelope.preferences.push(as_row(r));
    }
    for r in rows.iter().filter(|r| r.row_type == RowType::Thread).take(MAX_THREADS) {
        envelope.threads.push(EnvelopeThread { key: r.key.clone(), text: r.text.clone() });
    }
    for r in rows.iter().filter(|r| r.row_type == RowType::Reported).take(MAX_REPORTED) {
        envelope.reported_ids.push(r.key.clone());
    }
    for &i in &order {
        let r = &rows[i];
        match r.row_type {
            RowType::Outcome if envelope.outcomes.len() < MAX_OUTCOMES => envelope.outcomes.push(as_row(r)),
            RowType::Fact if envelope.facts.len() < MAX_FACTS => envelope.facts.push(as_row(r)),
            _ => {}
        }
    }
    // Under the cap: trim facts first, then outcomes, then the oldest reported ids.
    while serialized_len(&envelope) > MAX_ENVELOPE_CHARS {
        if envelope.facts.pop().is_some() {
            continue;
        }
        if envelope.outcomes.pop().is_some() {
            continue;
        }
        if envelope.reported_ids.pop().is_some() {
            continue;
        }
        if envelope.threads.pop().is_some() {
            continue;
        }
        if envelope.preferences.pop().is_none() {
            break;
        }
    }
    Some(envelope)
}
