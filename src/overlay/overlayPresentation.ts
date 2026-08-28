// The canonical TS mirror of src-tauri/src/overlay.rs's OverlayPresentation
// enum (serde rename_all = "lowercase"). Keep the two in lockstep: a
// presentation added to the Rust state machine must be added here, and the
// compiler then walks every consuming hook and render branch.
export type OverlayPresentation =
  | "hidden"
  | "panel"
  | "bar"
  | "companion"
  | "pointing"
  | "movingnotch";

// Move-mode is a transient fullscreen takeover that starts and ends on the
// bar, so surfaces that predate it treat it as "bar".
export function presentationTreatingMoveAsBar(
  presentation: OverlayPresentation,
): Exclude<OverlayPresentation, "movingnotch"> {
  return presentation === "movingnotch" ? "bar" : presentation;
}
