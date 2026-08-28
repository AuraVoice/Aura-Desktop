//! The last gate before an utterance is written down.
//!
//! `uia::anchor` already refuses to read password fields, credential-shaped
//! controls and password-manager windows. That covers the field being LABELLED
//! as sensitive. This module covers the other half: text that is sensitive
//! whatever the field claims to be, because people dictate and type card
//! numbers into ordinary message boxes all the time.
//!
//! The direction of failure is the opposite of `uia::focus`, and deliberately
//! so. That module fails open because refusing to type breaks dictation in
//! whatever app was misjudged. This one fails CLOSED: a false positive costs a
//! single training sample, a false negative writes a secret to disk and then
//! into an export folder.
//!
//! A hit drops the WHOLE trace, audio included, rather than redacting it. A
//! redacted transcript paired with unredacted audio is not a smaller leak, it
//! is the same leak with a misleading label on it.

#![cfg(windows)]

/// Why a trace was refused. A short machine token for the log; never the text
/// that triggered it.
pub type Refusal = &'static str;

/// Prefixes that are unambiguously credential material wherever they appear.
const SECRET_MARKERS: &[&str] = &[
    "-----begin",
    "sk-",
    "sk_live_",
    "sk_test_",
    "pk_live_",
    "rk_live_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "xapp-",
    "akia",
    "asia",
    "aiza",
    "ya29.",
    "eyj",
    "bearer ",
    "basic ",
    "ssh-rsa",
    "ssh-ed25519",
    "npm_",
    "hf_",
];

/// Words that, next to a number, mean the number is not a phone number.
const SECRET_CONTEXT: &[&str] = &[
    "password", "passcode", "passphrase", "pin", "cvv", "cvc", "otp",
    "social security", "ssn", "routing number", "account number", "sort code",
    "api key", "secret key", "private key", "seed phrase", "recovery code",
];

/// Refuses an utterance whose text should never be stored.
///
/// Checked against everything that would be persisted for the trace, so a
/// secret dictated into one utterance and a secret sitting in the surrounding
/// span both count.
pub fn refuse(texts: &[&str]) -> Option<Refusal> {
    for text in texts {
        if let Some(refusal) = refuse_one(text) {
            return Some(refusal);
        }
    }
    None
}

fn refuse_one(text: &str) -> Option<Refusal> {
    if text.trim().is_empty() {
        return None;
    }
    let lowered = text.to_lowercase();

    if SECRET_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return Some("secret_marker");
    }
    if SECRET_CONTEXT.iter().any(|hint| lowered.contains(hint))
        && text.chars().any(|character| character.is_ascii_digit())
    {
        return Some("secret_context");
    }

    for run in digit_runs(text) {
        // A 13 to 19 digit run that passes Luhn is a payment card, and nothing
        // else realistically is. Length alone would catch phone numbers and
        // order references, so the checksum is what makes this usable.
        if (13..=19).contains(&run.len()) && luhn_valid(&run) {
            return Some("card_number");
        }
        // Nine digits next to a US social security label is caught above by
        // SECRET_CONTEXT; a bare run this long with no context is left alone
        // deliberately, because it is far more often an order or account
        // reference the user meant to dictate.
        if run.len() > 24 {
            return Some("long_digit_run");
        }
    }

    if has_high_entropy_run(text) {
        return Some("high_entropy_run");
    }
    None
}

/// Digit runs with separators removed, so "4111 1111 1111 1111" and
/// "4111-1111-1111-1111" both read as one 16-digit number.
fn digit_runs(text: &str) -> Vec<String> {
    let mut runs = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_ascii_digit() {
            current.push(character);
        } else if character == ' ' || character == '-' || character == '.' {
            // A single separator does not end a run; two in a row does.
            if current.is_empty() {
                continue;
            }
            if current.ends_with(' ') {
                runs.push(std::mem::take(&mut current));
            } else {
                current.push(' ');
            }
        } else if !current.is_empty() {
            runs.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs.into_iter()
        .map(|run| run.chars().filter(char::is_ascii_digit).collect())
        .collect()
}

fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    for (index, character) in digits.chars().rev().enumerate() {
        let Some(mut digit) = character.to_digit(10) else {
            return false;
        };
        if index % 2 == 1 {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
    }
    sum.is_multiple_of(10)
}

/// A long unbroken token that mixes cases and digits is a key, a hash or a
/// token: not something a human dictated, and not something worth keeping.
///
/// The length floor is what keeps this from firing on ordinary words. 24
/// characters with no separator, both cases present and at least one digit is a
/// shape English prose does not produce.
fn has_high_entropy_run(text: &str) -> bool {
    text.split(|character: char| character.is_whitespace())
        .any(|token| {
            let body: Vec<char> = token
                .chars()
                .filter(|character| character.is_alphanumeric() || *character == '_' || *character == '-')
                .collect();
            if body.len() < 24 {
                return false;
            }
            let has_upper = body.iter().any(|character| character.is_ascii_uppercase());
            let has_lower = body.iter().any(|character| character.is_ascii_lowercase());
            let has_digit = body.iter().any(|character| character.is_ascii_digit());
            has_upper && has_lower && has_digit
        })
}
