/**
 * The single source of truth for which desktop-control verbs this client can
 * execute. Two consumers read it:
 *   - useSystemControl.ts dispatches an inbound `desktop.run` agent message by
 *     looking the verb up here and running its `validate` before invoking the
 *     one native command.
 *   - voice.ts advertises `advertiseManifest()` to the backend at session
 *     start, so the Buddy agent's single `run_desktop_capability` tool is
 *     scoped to exactly what THIS client build supports. A mobile client
 *     advertises nothing, so the agent never gets a desktop tool there - that
 *     is the hard mobile isolation, enforced by omission rather than a flag.
 *
 * Adding a capability is meant to touch only this file (a new entry) plus its
 * native executor in system_control.rs. The message contract (agentData.ts),
 * the dispatcher (useSystemControl.ts), and the native gate
 * (security.rs Operation::DesktopControl) never change as verbs are added -
 * the verb travels inside `desktop.run`'s `id`, not as its own message type or
 * tool schema. See the plan in ~/.claude/plans/linked-leaping-biscuit.md.
 *
 * `validate` here is client-side defense-in-depth only: Rust re-validates every
 * argument against its own allowlist before anything reaches an OS resource,
 * because the webview is not a trust boundary (see security.rs).
 */

export interface DesktopCapability {
  /** Stable verb id shared with the backend catalog and system_control.rs. */
  readonly id: string;
  /** One terse line; goes verbatim into the advertised manifest/catalog. */
  readonly description: string;
  /** Argument keys the agent should send; advertised so it knows the shape. */
  readonly argKeys: readonly string[];
  /**
   * Fail-closed sanity check + normalization. Returns the cleaned args to
   * forward to the native command, or null to drop the message entirely.
   */
  validate(args: Record<string, unknown>): Record<string, unknown> | null;
}

// Generous vs. any real URL, tight enough that a hostile publisher can't stuff
// the native command with megabytes (agentData.ts already caps the whole
// message at 64 KiB; this is the per-field guard).
const URL_MAX_LENGTH = 2_048;

/** open_url: only well-formed http/https URLs survive. Everything else
 * (file:, javascript:, mailto:, bare words, over-length) is dropped here and
 * would be dropped again in Rust. */
function validateOpenUrl(args: Record<string, unknown>): Record<string, unknown> | null {
  const url = args.url;
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return { url: parsed.toString() };
}

// The canonical media/volume verbs. Rust maps each to a Win32 virtual key; a
// value outside this set is dropped here and would be dropped there too.
const MEDIA_ACTIONS: ReadonlySet<string> = new Set([
  "play_pause",
  "next",
  "previous",
  "stop",
  "volume_up",
  "volume_down",
  "mute",
]);

function validateMediaControl(args: Record<string, unknown>): Record<string, unknown> | null {
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  if (!MEDIA_ACTIONS.has(action)) return null;
  return { action };
}

// App-key length guard only; the authoritative allowlist of which keys map to
// which process lives in Rust (system_control.rs), never in the webview.
const APP_KEY_MAX_LENGTH = 64;

function validateAppKey(args: Record<string, unknown>): Record<string, unknown> | null {
  const app = typeof args.app === "string" ? args.app.trim().toLowerCase() : "";
  if (app.length === 0 || app.length > APP_KEY_MAX_LENGTH) return null;
  return { app };
}

const CAPABILITIES: readonly DesktopCapability[] = [
  {
    id: "open_url",
    description: "Open a web URL in the user's default browser",
    argKeys: ["url"],
    validate: validateOpenUrl,
  },
  {
    id: "media_control",
    description:
      "Send a media/volume key. action: play_pause | next | previous | stop | volume_up | volume_down | mute",
    argKeys: ["action"],
    validate: validateMediaControl,
  },
  {
    id: "focus_window",
    description:
      "Bring an already-running app to the foreground. app: chrome | edge | firefox | spotify | slack | discord | notion | vscode | explorer",
    argKeys: ["app"],
    validate: validateAppKey,
  },
  {
    id: "launch_app",
    description:
      "Launch an app. app: chrome | edge | firefox | spotify | explorer | notepad | calculator. To also start playback etc., follow with a separate media_control call.",
    argKeys: ["app"],
    validate: validateAppKey,
  },
];

export const DESKTOP_CAPABILITIES: ReadonlyMap<string, DesktopCapability> = new Map(
  CAPABILITIES.map((capability) => [capability.id, capability]),
);

/** Bumped when the manifest shape (not its contents) changes, so the backend
 * can reason about compatibility. */
export const MANIFEST_VERSION = 1;

export interface CapabilityManifest {
  manifest_version: number;
  capabilities: { id: string; description: string; arg_keys: string[] }[];
}

/** The snake_case payload the backend stores on the room's agent dispatch to
 * build its single-tool catalog. Snake_case matches the rest of the
 * backend contract (dashboardApi.ts, voice.ts). */
export function advertiseManifest(): CapabilityManifest {
  return {
    manifest_version: MANIFEST_VERSION,
    capabilities: CAPABILITIES.map((capability) => ({
      id: capability.id,
      description: capability.description,
      arg_keys: [...capability.argKeys],
    })),
  };
}
