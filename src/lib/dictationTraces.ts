import { invoke } from "@tauri-apps/api/core";

/**
 * Typed client for opt-in, on-device dictation training traces.
 *
 * Every call here is local: the Rust side reads and writes encrypted files
 * under the app's own data directory and makes no network call at any point.
 * There is no backend endpoint for any of this, deliberately.
 */

/** How far a trace has got through its life. Mirrors Rust's `TraceState`. */
export type TraceState =
  | "watching"
  | "unanchored"
  | "finalized"
  | "discarded"
  | "anchorLost";

/**
 * How one difference between what Aura typed and what the user kept should be
 * read. The first three are evidence about the recognizer and are folded into
 * the exported transcript; the last two are the user rewriting their own words
 * and never are.
 */
export type EditClass =
  | "verbatim"
  | "casing"
  | "punctuation"
  | "disfluency"
  | "style";

export const GROUND_TRUTH_CLASSES: readonly EditClass[] = [
  "verbatim",
  "casing",
  "punctuation",
];

export function isGroundTruthClass(value: EditClass): boolean {
  return GROUND_TRUTH_CLASSES.includes(value);
}

export interface EditOp {
  class: EditClass;
  from: string;
  to: string;
  wordIndex: number;
}

export interface TokenTiming {
  token: string;
  atSeconds: number;
}

export interface TraceRecord {
  traceId: string;
  recordedAtMs: number;
  modelId: string;
  app: string;
  fieldId: string;
  role: string;
  audioMs: number;
  hasAudio: boolean;
  /** Exactly what the recognizer emitted, before local corrections. */
  rawTranscript: string;
  /** What was actually typed into the field. */
  insertedText: string;
  locallyCorrected: boolean;
  tokens: TokenTiming[];
  state: TraceState;
  observations: number;
  lastObservedAtMs: number;
  /** What the watched span held once the trace settled. */
  finalText: string | null;
  edits: EditOp[];
  /** `insertedText` with only the recognition fixes applied. */
  groundTruth: string | null;
  /** Short machine token explaining why no anchor was made, when none was. */
  anchorNote: string | null;
  shareState: ShareState;
  sharedAtMs: number | null;
}

export interface TraceSummary {
  total: number;
  verified: number;
  watching: number;
  withEdits: number;
  audioBytes: number;
  oldestRecordedAtMs: number | null;
  /** Reached Aura's servers. */
  shared: number;
  /** Queued to be shared, or waiting out a backoff. */
  pendingShare: number;
  /** Deletes still owed to the server. Shown rather than hidden: a non-zero
   * value means this PC has promised something it has not yet delivered. */
  pendingDeletions: number;
}

/** Where one trace stands with the server. Mirrors Rust's `ShareState`. */
export type ShareState = "ineligible" | "pending" | "uploaded" | "failed";

export interface TraceSettings {
  enabled: boolean;
  captureAudio: boolean;
  retentionDays: number;
  excludedApps: string[];
  maxTraces: number;
  maxAudioBytes: number;
  exportDirectory: string | null;
  /** Upload settled traces to Aura. A separate decision from `enabled`:
   * consenting to be recorded locally is not consenting to transmit. */
  sharingEnabled: boolean;
  /** Which consent text the user accepted. */
  consentVersion: number;
  /** Which one is current. When these differ, the UI must re-ask rather than
   * carry an old consent forward into new terms. */
  currentConsentVersion: number;
}

export interface TraceExportResult {
  directory: string;
  manifestLines: number;
  audioFiles: number;
  correctionEdits: number;
  styleEdits: number;
  skipped: number;
}

export const RETENTION_CHOICES = [7, 30, 90] as const;

export function loadTraceSettings(): Promise<TraceSettings> {
  return invoke<TraceSettings>("dictation_trace_settings");
}

export function saveTraceSettings(settings: {
  enabled: boolean;
  captureAudio: boolean;
  retentionDays: number;
  excludedApps: string[];
  sharingEnabled: boolean;
}): Promise<TraceSettings> {
  return invoke<TraceSettings>("dictation_set_trace_settings", settings);
}

export function loadTraceSummary(): Promise<TraceSummary> {
  return invoke<TraceSummary>("dictation_trace_summary");
}

export function loadTraces(limit = 100): Promise<TraceRecord[]> {
  return invoke<TraceRecord[]>("dictation_trace_list", { limit });
}

export function deleteTrace(traceId: string): Promise<boolean> {
  return invoke<boolean>("dictation_delete_trace", { traceId });
}

export function deleteAllTraces(): Promise<number> {
  return invoke<number>("dictation_delete_all_traces");
}

export function exportTraces(
  includeAudio: boolean,
  onlyVerified: boolean,
): Promise<TraceExportResult> {
  return invoke<TraceExportResult>("dictation_export_traces", {
    includeAudio,
    onlyVerified,
  });
}

/**
 * One trace's audio as a playable object URL.
 *
 * Comes back as raw WAV bytes rather than base64, the same way
 * `savedImageCache` reads cached screenshots: the webview turns the
 * `ArrayBuffer` straight into a Blob with no encode/decode round trip. The
 * caller owns the URL and must revoke it.
 */
export async function traceAudioUrl(traceId: string): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("dictation_trace_audio", { traceId });
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

/** Human-readable size for the storage line. */
export function formatTraceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a trace's state means, in the user's terms rather than the enum's. */
export function traceStateLabel(state: TraceState): string {
  switch (state) {
    case "watching":
      return "Watching for edits";
    case "unanchored":
      return "Not tracked";
    case "finalized":
      return "Confirmed";
    case "discarded":
      return "You deleted it";
    case "anchorLost":
      return "Lost track of it";
  }
}
