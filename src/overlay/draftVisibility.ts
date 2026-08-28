import type { OverlayPresentation } from "./overlayPresentation";

// The draft surface's view of the overlay: the canonical union minus the
// move-mode takeover, which useDraftCard normalizes to "bar" before this
// module ever sees it.
export type DraftPresentation = Exclude<OverlayPresentation, "movingnotch">;
export type DraftVisibilityPhase = "idle" | "generating" | "shown" | "refining" | "error";
export type PendingDraftRestoreAction = "none" | "wait" | "clear" | "restore";

/**
 * A draft that arrives during pointer mode must wait for the pointer flight to
 * finish before it can restore a hidden panel. Existing drafts never restore
 * the panel after an intentional user hide.
 */
export function pendingDraftRestoreAction(
  pending: boolean,
  phase: DraftVisibilityPhase,
  presentation: DraftPresentation,
): PendingDraftRestoreAction {
  if (!pending) return "none";
  if (presentation === "pointing") return "wait";
  if (phase !== "idle" && presentation === "hidden") return "restore";
  return "clear";
}
