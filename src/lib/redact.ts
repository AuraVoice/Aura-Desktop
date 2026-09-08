// Matches Firebase ID/refresh tokens and LiveKit JWTs (both are long
// dot-separated base64url segments), plus common key=value shapes that might
// carry one, before any log content leaves the machine. Deliberately broad
// (would also redact a plain long base64 string that isn't actually a token)
// - over-redacting a log line is harmless, under-redacting a real token isn't.
// Lives in its own module because both feedback.ts (mail body) and log.ts
// (the client_log analytics event) need it, and log.ts must not import
// feedback.ts, which imports log.ts.
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const KEY_VALUE_TOKEN_PATTERN = /((?:token|refreshToken|idToken|access_token)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;

export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, "[redacted]").replace(KEY_VALUE_TOKEN_PATTERN, "$1[redacted]");
}
