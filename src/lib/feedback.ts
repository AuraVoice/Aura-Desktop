import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { platform, version as osVersion } from "@tauri-apps/plugin-os";
import { openUrl } from "@tauri-apps/plugin-opener";
import { logError } from "./log";
import { trackEvent } from "./analytics";

const FEEDBACK_EMAIL = "support@auravoiceapp.com";
const LOG_LINE_COUNT = 40;

import { redactSecrets } from "./redact";

export { redactSecrets };

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
  trackEvent("feedback_submitted", { kind: "general", has_log_tail: logTail.length > 0 });
}
