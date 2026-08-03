//! Word-level diff, and the rule that decides whether a difference is evidence
//! about the recognizer or evidence about the writer.
//!
//! This is the judgement the whole feature turns on. A trace where the user
//! changed "there" to "their" says the model mis-heard a word, and belongs in a
//! training label. A trace where they changed "please send the file" to "could
//! you send the file over when you get a sec" says nothing about the audio at
//! all, and folding it into a label would teach the model to transcribe words
//! that were never spoken.
//!
//! The classifier is deliberately deterministic: a lookup, a phonetic code and
//! an edit-distance ratio, no model call. It runs on the trace worker, never on
//! the dictation path, but the bigger reason is that a training corpus built by
//! an opaque judgement is a training corpus nobody can audit.
//!
//! Everything here is pure. `rphonetic` is already a dependency for
//! `vocab::apply_corrections`'s alias pass, and is reused rather than
//! re-implemented.

#![cfg(windows)]

use rphonetic::{DoubleMetaphone, Encoder};

use super::record::{EditClass, EditOp};

/// Past this many words either side, the pair is treated as one whole-string
/// rewrite instead of being diffed. An utterance is a sentence or two; anything
/// this long means the span anchoring latched onto far more text than Aura
/// typed, and the honest answer is "this is not a word-level correction".
const MAX_TOKENS: usize = 400;

/// A replacement whose sides are at least this similar, after normalization, is
/// read as the recognizer missing a word rather than the user choosing a
/// different one. 0.6 keeps "sara"/"sarah" and "recieve"/"receive" while
/// rejecting "send"/"forward".
const SIMILARITY_FLOOR: f64 = 0.6;

/// Filler the speaker genuinely said. Removing one of these is a real edit, but
/// it is not a recognition error, so it gets its own class rather than being
/// mixed into either bucket.
const DISFLUENCIES: &[&str] = &[
    "um", "umm", "uh", "uhh", "er", "erm", "ah", "eh", "hmm", "mm", "mhm", "like", "basically",
    "actually", "literally", "sorta", "kinda", "y'know",
];

/// One token: a run of word characters, or a single punctuation mark, together
/// with the whitespace that preceded it. Keeping the whitespace attached is
/// what lets a rebuilt string preserve the original spacing exactly, the same
/// reason `vocab::split_keeping_separators` keeps its separators.
#[derive(Clone, Debug)]
struct Token {
    lead: String,
    text: String,
}

impl Token {
    fn is_word(&self) -> bool {
        self.text.chars().next().is_some_and(char::is_alphanumeric)
    }
}

/// One aligned region of the diff. Together the blocks cover both sides
/// completely and in order, so rebuilding from them cannot drop or duplicate
/// text.
#[derive(Clone, Debug)]
struct Block {
    a: std::ops::Range<usize>,
    b: std::ops::Range<usize>,
    /// `None` for an unchanged run.
    class: Option<EditClass>,
}

/// What the diff concluded about one utterance.
pub struct Comparison {
    pub edits: Vec<EditOp>,
    /// `inserted` with only the ground-truth classes applied. This is the text
    /// exported as the NeMo transcript.
    pub ground_truth: String,
}

/// Compares what Aura typed against what the user ended up with.
///
/// `inserted` is the text dictation actually sent to the field; `final_text` is
/// what the anchored span holds now. Both come from the same verified span, so
/// this never compares an utterance against unrelated text.
pub fn compare(inserted: &str, final_text: &str) -> Comparison {
    if inserted == final_text {
        return Comparison {
            edits: Vec::new(),
            ground_truth: inserted.to_string(),
        };
    }
    let a = tokenize(inserted);
    let b = tokenize(final_text);

    // Too long to align meaningfully. Reported as one style rewrite, which
    // keeps it out of every training label while still recording that the user
    // changed something.
    if a.len() > MAX_TOKENS || b.len() > MAX_TOKENS {
        return Comparison {
            edits: vec![EditOp {
                class: EditClass::Style,
                from: inserted.to_string(),
                to: final_text.to_string(),
                word_index: 0,
            }],
            ground_truth: inserted.to_string(),
        };
    }

    let blocks = align(&a, &b);
    let mut edits = Vec::new();
    let mut ground_truth = String::new();
    let mut word_index = 0usize;

    for block in &blocks {
        let from = join(&a[block.a.clone()]);
        let to = join(&b[block.b.clone()]);
        match block.class {
            None => {
                push_tokens(&mut ground_truth, &a[block.a.clone()]);
            }
            Some(class) => {
                edits.push(EditOp {
                    class,
                    from: from.trim().to_string(),
                    to: to.trim().to_string(),
                    word_index,
                });
                // The one place the split actually bites: a ground-truth class
                // takes the user's words, everything else keeps Aura's, because
                // only the former still describes the audio.
                if class.is_ground_truth() {
                    push_tokens(&mut ground_truth, &b[block.b.clone()]);
                } else {
                    push_tokens(&mut ground_truth, &a[block.a.clone()]);
                }
            }
        }
        word_index += a[block.a.clone()].iter().filter(|t| t.is_word()).count();
    }

    Comparison {
        edits,
        ground_truth: ground_truth.trim_start().to_string(),
    }
}

/// Splits text into word and punctuation tokens, each carrying the whitespace
/// that came before it.
fn tokenize(text: &str) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    let mut lead = String::new();
    let mut word = String::new();

    for character in text.chars() {
        if character.is_whitespace() {
            if !word.is_empty() {
                tokens.push(Token {
                    lead: std::mem::take(&mut lead),
                    text: std::mem::take(&mut word),
                });
            }
            lead.push(character);
            continue;
        }
        // An apostrophe inside a word keeps it whole ("don't" is one token),
        // which stops every contraction from reading as a punctuation edit.
        let joins_word = character.is_alphanumeric()
            || ((character == '\'' || character == '\u{2019}') && !word.is_empty());
        if joins_word {
            word.push(character);
            continue;
        }
        if !word.is_empty() {
            tokens.push(Token {
                lead: std::mem::take(&mut lead),
                text: std::mem::take(&mut word),
            });
        }
        tokens.push(Token {
            lead: std::mem::take(&mut lead),
            text: character.to_string(),
        });
    }
    if !word.is_empty() {
        tokens.push(Token {
            lead: std::mem::take(&mut lead),
            text: word,
        });
    }
    tokens
}

fn join(tokens: &[Token]) -> String {
    let mut out = String::new();
    push_tokens(&mut out, tokens);
    out
}

fn push_tokens(out: &mut String, tokens: &[Token]) {
    for token in tokens {
        out.push_str(&token.lead);
        out.push_str(&token.text);
    }
}

/// Longest-common-subsequence alignment, then every run of non-matching tokens
/// collapsed into one classified block. Bounded by `MAX_TOKENS` above, so the
/// quadratic table is at most 400x400.
fn align(a: &[Token], b: &[Token]) -> Vec<Block> {
    let rows = a.len() + 1;
    let columns = b.len() + 1;
    let mut table = vec![0u16; rows * columns];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            table[i * columns + j] = if a[i].text == b[j].text {
                table[(i + 1) * columns + j + 1] + 1
            } else {
                table[(i + 1) * columns + j].max(table[i * columns + j + 1])
            };
        }
    }

    let mut blocks: Vec<Block> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i].text == b[j].text {
            let (start_a, start_b) = (i, j);
            while i < a.len() && j < b.len() && a[i].text == b[j].text {
                i += 1;
                j += 1;
            }
            blocks.push(Block {
                a: start_a..i,
                b: start_b..j,
                class: None,
            });
            continue;
        }
        let (start_a, start_b) = (i, j);
        // Walk forward until the tables agree that matching resumes.
        while i < a.len() || j < b.len() {
            if i < a.len() && j < b.len() && a[i].text == b[j].text {
                break;
            }
            if j >= b.len() {
                i += 1;
            } else if i >= a.len() {
                j += 1;
            } else if table[(i + 1) * columns + j] >= table[i * columns + j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
        let block_a = start_a..i;
        let block_b = start_b..j;
        let class = classify(&a[block_a.clone()], &b[block_b.clone()]);
        blocks.push(Block {
            a: block_a,
            b: block_b,
            class: Some(class),
        });
    }
    blocks
}

/// The rule. Ordered from the cheapest and most certain test to the vaguest.
fn classify(from: &[Token], to: &[Token]) -> EditClass {
    let from_text = join(from);
    let to_text = join(to);
    let from_trimmed = from_text.trim();
    let to_trimmed = to_text.trim();

    // Same words, only the surface changed. Checked first because it is exact:
    // no similarity threshold can be wrong about it.
    if normalize(from_trimmed) == normalize(to_trimmed) {
        return if from_trimmed.to_lowercase() == to_trimmed.to_lowercase() {
            // Identical once case is ignored, so case is the only difference.
            EditClass::Casing
        } else {
            EditClass::Punctuation
        };
    }

    let from_words = words(from);
    let to_words = words(to);

    // Pure deletion of filler the speaker actually said.
    if to_words.is_empty()
        && !from_words.is_empty()
        && from_words
            .iter()
            .all(|word| DISFLUENCIES.contains(&word.to_lowercase().as_str()))
    {
        return EditClass::Disfluency;
    }

    // A one-sided block is the user adding or removing their own words. There
    // is no "what the model should have produced" here, so it is never a label.
    if from_words.is_empty() || to_words.is_empty() {
        return EditClass::Style;
    }

    if sounds_alike(&from_words, &to_words) || similarity(from_trimmed, to_trimmed) >= SIMILARITY_FLOOR
    {
        return EditClass::Verbatim;
    }
    EditClass::Style
}

fn words(tokens: &[Token]) -> Vec<String> {
    tokens
        .iter()
        .filter(|token| token.is_word())
        .map(|token| token.text.clone())
        .collect()
}

/// Lowercased, with everything that is not a letter or digit removed. Two
/// strings that normalize the same differ only in case, punctuation or spacing.
fn normalize(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Double-metaphone equality across the whole block. The same encoder
/// `vocab::apply_corrections` uses for its alias pass, so a phrase judged
/// homophonous here is judged homophonous there too.
fn sounds_alike(from: &[String], to: &[String]) -> bool {
    if from.len() != to.len() {
        return false;
    }
    let encoder = DoubleMetaphone::default();
    from.iter().zip(to.iter()).all(|(left, right)| {
        let (left_code, right_code) = (encoder.encode(left), encoder.encode(right));
        !left_code.is_empty() && left_code == right_code
    })
}

/// Levenshtein distance as a 0..1 similarity over the longer side, computed on
/// the normalized forms so punctuation and case never inflate the distance.
fn similarity(left: &str, right: &str) -> f64 {
    let left: Vec<char> = normalize(left).chars().collect();
    let right: Vec<char> = normalize(right).chars().collect();
    let longest = left.len().max(right.len());
    if longest == 0 {
        return 1.0;
    }
    // Two rows rather than a full table: the strings here are a handful of
    // words, but this runs once per block per trace and there is no reason to
    // allocate a rectangle for it.
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0usize; right.len() + 1];
    for (i, left_char) in left.iter().enumerate() {
        current[0] = i + 1;
        for (j, right_char) in right.iter().enumerate() {
            let substitution = previous[j] + usize::from(left_char != right_char);
            current[j + 1] = substitution.min(previous[j + 1] + 1).min(current[j] + 1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    1.0 - (previous[right.len()] as f64 / longest as f64)
}
