//! Rust-side log redaction - runs before any log line crosses the IPC
//! boundary into JavaScript (see logging::read_recent_log_lines). The
//! frontend keeps its own smaller regex pass in feedback.ts as a second
//! layer, but this one is authoritative: JS must never be the only thing
//! standing between a token in the log file and a support email.
//!
//! The rules are deliberately structured (one pattern, one replacement, one
//! test vector each) rather than a single mega-regex, so adding a rule or
//! auditing one is a local change. Over-redacting a log line is harmless;
//! under-redacting a real credential is not - but plain diagnostic context
//! (timestamps, module paths, error kinds, versions, window geometry) must
//! survive, or the feedback flow stops being useful to support.

use std::sync::OnceLock;

use regex::Regex;

struct Rule {
    pattern: &'static str,
    replacement: &'static str,
}

/// Applied in order. Order matters: the JWT/authorization rules must consume
/// their whole match before the generic key=value rule sees the line.
const RULES: &[Rule] = &[
    // JWT-shaped triples (Firebase ID/refresh tokens, LiveKit tokens) - same
    // shape feedback.ts matches, kept deliberately broad.
    Rule {
        pattern: r"[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        replacement: "[redacted:jwt]",
    },
    // Home directories. OS error strings routinely carry the full path of the
    // file they failed on, and on every platform that path begins with the
    // user's own name. Keeps the rest of the path, which is the diagnostic
    // part, and drops only the identity.
    Rule {
        pattern: r"(?i)([A-Za-z]:\\Users\\)[^\\/\s]+",
        replacement: "${1}[redacted:user]",
    },
    Rule {
        pattern: r"(/(?:home|Users)/)[^/\s]+",
        replacement: "${1}[redacted:user]",
    },
    // "Authorization: Bearer <x>" / "authorization=<x>" - consumes up to two
    // tokens so the scheme word can't strand the credential behind it.
    Rule {
        pattern: r#"(?i)(authorization["']?\s*[:=]\s*)\S+(?:[ \t]+\S+)?"#,
        replacement: "${1}[redacted:auth]",
    },
    // Bare "Bearer <x>" outside an Authorization header.
    Rule {
        pattern: r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+",
        replacement: "bearer [redacted:auth]",
    },
    // key=value / key: value credential shapes. Bare `code` is deliberately
    // absent: this app logs diagnostic error codes as `code=agent_silent`
    // and losing those would gut the feedback flow; the *_code variants
    // cover the credential-bearing ones (session/pairing/device/oauth/auth).
    // Quoted values are separate from unquoted values so whitespace inside
    // a password or token cannot terminate the match and leak the suffix.
    Rule {
        pattern: r#"(?i)(["']?\b(?:refresh_?|id_?|access_?|custom_?)?token["']?\s*[:=]\s*|["']?\b(?:api[_-]?key|secret|password|passwd|pwd|(?:set-)?cookie|session[_-]?(?:id|code)|device[_-]?(?:link[_-]?)?code|oauth[_-]?code|pairing[_-]?code|auth[_-]?code)["']?\s*[:=]\s*)"(?:\\.|[^"\\])*""#,
        replacement: "${1}\"[redacted]\"",
    },
    Rule {
        pattern: r#"(?i)(["']?\b(?:refresh_?|id_?|access_?|custom_?)?token["']?\s*[:=]\s*|["']?\b(?:api[_-]?key|secret|password|passwd|pwd|(?:set-)?cookie|session[_-]?(?:id|code)|device[_-]?(?:link[_-]?)?code|oauth[_-]?code|pairing[_-]?code|auth[_-]?code)["']?\s*[:=]\s*)'(?:\\.|[^'\\])*'"#,
        replacement: "${1}'[redacted]'",
    },
    Rule {
        pattern: r#"(?i)(["']?\b(?:refresh_?|id_?|access_?|custom_?)?token["']?\s*[:=]\s*|["']?\b(?:api[_-]?key|secret|password|passwd|pwd|(?:set-)?cookie|session[_-]?(?:id|code)|device[_-]?(?:link[_-]?)?code|oauth[_-]?code|pairing[_-]?code|auth[_-]?code)["']?\s*[:=]\s*)[^\s"',;}&?]+"#,
        replacement: "${1}[redacted]",
    },
    // Sensitive URL query parameters - keeps origin+path readable.
    Rule {
        pattern: r#"(?i)([?&][a-z0-9_]*(?:token|key|code|secret|sig|signature|auth|session)[a-z0-9_]*=)[^&\s"']+"#,
        replacement: "${1}[redacted]",
    },
    // Email addresses (the signed-in account, meeting participants).
    Rule {
        pattern: r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
        replacement: "[redacted:email]",
    },
    // UUIDs and long bare hex runs - covers backend-minted meeting ids
    // ("meeting: capture started for {meeting_id}") and Firebase uids.
    Rule {
        pattern: r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
        replacement: "[redacted:id]",
    },
    Rule {
        pattern: r"\b[0-9a-fA-F]{32,}\b",
        replacement: "[redacted:id]",
    },
    // Long standalone base64-ish blobs (session codes, key material) that
    // none of the shapes above caught.
    Rule {
        pattern: r"\b[A-Za-z0-9+/_-]{48,}={0,2}\b",
        replacement: "[redacted:blob]",
    },
    // The account-name segment of home-directory paths (C:\Users\<name>\...,
    // /Users/<name>, /home/<name>) - the username is user context, while the
    // rest of the path keeps its diagnostic value.
    Rule {
        pattern: r#"(?i)([\\/](?:Users|home)[\\/])[^\\/\s"']+"#,
        replacement: "${1}[redacted:user]",
    },
];

fn compiled() -> &'static Vec<(Regex, &'static str)> {
    static COMPILED: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        RULES
            .iter()
            .map(|rule| {
                // Patterns are compile-time constants; a typo in one is a
                // programming error, caught by the tests below.
                (
                    Regex::new(rule.pattern).expect("redact: invalid pattern"),
                    rule.replacement,
                )
            })
            .collect()
    })
}

pub fn redact_line(line: &str) -> String {
    let mut out = line.to_string();
    for (regex, replacement) in compiled() {
        if regex.is_match(&out) {
            out = regex.replace_all(&out, *replacement).into_owned();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::redact_line;

    #[test]
    fn jwts_are_redacted() {
        let line = "token refresh failed for eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJhYmNkZWYifQ.SflKxwRJSMeKKF2QT4fwpM";
        let out = redact_line(line);
        assert!(out.contains("[redacted:jwt]"), "{out}");
        assert!(!out.contains("eyJhbGciOiJSUzI1NiIs"), "{out}");
    }

    #[test]
    fn authorization_headers_are_redacted() {
        let out = redact_line("request headers: Authorization: Bearer abc123def456");
        assert!(!out.contains("abc123def456"), "{out}");
        assert!(out.to_lowercase().contains("authorization"), "{out}");

        let out = redact_line("sending bearer xyz.token-material");
        assert!(!out.contains("xyz.token-material"), "{out}");
    }

    #[test]
    fn key_value_secrets_are_redacted_keys_kept() {
        for line in [
            r#"refreshToken: "AMf-vBwUvR0d""#,
            "idToken=abcd1234",
            "access_token = 'shhh-secret'",
            "custom_token: opaque.value",
            "api_key=AIzaSyDrA4TpUu",
            "password: hunter42",
            "Set-Cookie: session=deadbeef",
            "pairing_code=ABC12345",
            "device_link_code: XK4-99",
            "session_code=SC-123456",
        ] {
            let out = redact_line(line);
            assert!(out.contains("[redacted"), "{line} -> {out}");
        }
        // The key survives so support can still see WHAT failed.
        assert!(redact_line("idToken=abcd1234").contains("idToken"));
    }

    #[test]
    fn quoted_secrets_with_spaces_are_fully_redacted() {
        for (line, secrets) in [
            (
                r#"password="correct horse battery staple" status=denied"#,
                &["correct", "horse", "battery", "staple"][..],
            ),
            (
                "secret: 'alpha beta gamma' retry=false",
                &["alpha", "beta", "gamma"][..],
            ),
        ] {
            let out = redact_line(line);
            assert!(out.contains("[redacted]"), "{line} -> {out}");
            for secret in secrets {
                assert!(!out.contains(secret), "{line} -> {out}");
            }
        }
        assert_eq!(
            redact_line(r#"password="correct horse battery staple" status=denied"#),
            r#"password="[redacted]" status=denied"#,
        );
        assert_eq!(
            redact_line("secret: 'alpha beta gamma' retry=false"),
            "secret: '[redacted]' retry=false",
        );
    }

    #[test]
    fn unquoted_secrets_stop_at_diagnostic_whitespace() {
        assert_eq!(
            redact_line("password=hunter42 status=denied"),
            "password=[redacted] status=denied",
        );
    }

    #[test]
    fn diagnostic_error_codes_survive() {
        for line in [
            "useVoiceBar: enterErrorState code=agent_silent room=unknown",
            "overlay::apply: presentation=Panel variant=Bar applied in 3ms",
            "hotkeys: failed to register summon (already taken)",
            "lk.agent.state=speaking",
            "meeting: pruned 2 expired capture(s) from the upload queue",
            "app version 0.2.1 on windows 10.0.26200",
            r"path D:\Projects\aura-desktop\target\debug\build",
        ] {
            assert_eq!(redact_line(line), line, "must survive verbatim");
        }
    }

    #[test]
    fn home_directory_usernames_are_redacted_rest_of_path_kept() {
        let out = redact_line(r"failed to open C:\Users\someone\AppData\Local\aura-desktop\logs");
        assert_eq!(
            out,
            r"failed to open C:\Users\[redacted:user]\AppData\Local\aura-desktop\logs"
        );

        let out = redact_line("store at /Users/jane.doe/Library/Logs/aura");
        assert_eq!(out, "store at /Users/[redacted:user]/Library/Logs/aura");

        let out = redact_line("config in /home/varun/.config/aura");
        assert_eq!(out, "config in /home/[redacted:user]/.config/aura");
    }

    #[test]
    fn sensitive_url_query_params_are_redacted_path_kept() {
        let out = redact_line("GET https://example.com/auth/start?apiKey=AIzaSy123&x=1&session=abc");
        assert!(out.contains("https://example.com/auth/start"), "{out}");
        assert!(!out.contains("AIzaSy123"), "{out}");
        assert!(!out.contains("session=abc"), "{out}");
        assert!(out.contains("x=1"), "{out}");
    }

    #[test]
    fn emails_are_redacted() {
        let out = redact_line("signed in as varuntej07.wa@gmail.com just now");
        assert_eq!(out, "signed in as [redacted:email] just now");
    }

    #[test]
    fn meeting_ids_and_uuids_are_redacted() {
        let out = redact_line(
            "meeting: capture started for 3f2a9c1b7d4e4f209a1b2c3d4e5f6a7b (event evt-1)",
        );
        assert!(out.contains("[redacted:id]"), "{out}");
        assert!(!out.contains("3f2a9c1b"), "{out}");

        let out = redact_line("doc id 550e8400-e29b-41d4-a716-446655440000 expired");
        assert_eq!(out, "doc id [redacted:id] expired");
    }

    #[test]
    fn long_base64_blobs_are_redacted() {
        let blob = "A".repeat(20) + "b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6";
        let out = redact_line(&format!("payload {blob} rejected"));
        assert!(out.contains("[redacted"), "{out}");
    }
}
