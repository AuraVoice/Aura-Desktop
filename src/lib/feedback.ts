import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { platform, version as osVersion } from "@tauri-apps/plugin-os";
import { openUrl } from "@tauri-apps/plugin-opener";
import { logError } from "./log";

const FEEDBACK_EMAIL = "support@auravoiceapp.com";
const LOG_LINE_COUNT = 40;

// Matches Firebase ID/refresh tokens and LiveKit JWTs (both are long
// dot-separated base64url segments), plus common key=value shapes that might
// carry one, before any log content leaves the machine. Deliberately broad
// (would also redact a plain long base64 string that isn't actually a token)
// - over-redacting a log line is harmless, under-redacting a real token isn't.
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const KEY_VALUE_TOKEN_PATTERN = /((?:token|refreshToken|idToken|access_token)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;

export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, "[redacted]").replace(KEY_VALUE_TOKEN_PATTERN, "$1[redacted]");
}

interface FeedbackContext {
  appVersion: string;
  os: string;
  overlayState: string;
}

async function gatherContext(overlayState: string): Promise<FeedbackContext> {
  const appVersion = await getVersion().catch(() => "unknown");
  const os = `${platform()} ${osVersion()}`;
  return { appVersion, os, overlayState };
}

/** Opens the user's default mail client with version/OS/state and a redacted
 * log tail prefilled - no in-app compose UI needed, since the mail client's
 * own body is editable before sending (that's where "optional free text"
 * lives, rather than a separate input this app would have to build). */
export async function sendFeedback(overlayState: string): Promise<void> {
  const [context, rawLines] = await Promise.all([
    gatherContext(overlayState),
    invoke<string[]>("read_recent_log_lines", { count: LOG_LINE_COUNT }).catch((err) => {
      logError("feedback: read_recent_log_lines", err);
      return [] as string[];
    }),
  ]);

  const logTail = redactSecrets(rawLines.join("\n"));
  const body = [
    `App version: ${context.appVersion}`,
    `OS: ${context.os}`,
    `Overlay state: ${context.overlayState}`,
    "",
    "Describe what happened:",
    "",
    "",
    "--- recent log lines ---",
    logTail || "(no log lines available)",
  ].join("\n");

  const mailtoUrl = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
    "Aura Desktop feedback",
  )}&body=${encodeURIComponent(body)}`;

  await openUrl(mailtoUrl);
}
