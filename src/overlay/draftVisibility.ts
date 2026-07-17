export type DraftPresentation = "hidden" | "panel" | "bar" | "companion" | "pointing";
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
