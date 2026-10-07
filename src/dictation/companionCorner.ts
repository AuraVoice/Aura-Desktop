// Mirrors CompanionCorner in src-tauri/src/dictation/hud.rs. Rust owns the
// value (it is window geometry, persisted beside the notch edge); this is the
// wire spelling the HUD payload and the two corner commands use.
export type CompanionCorner = "bottomLeft" | "bottomRight" | "topLeft" | "topRight";

export const COMPANION_CORNERS: Array<{ value: CompanionCorner; label: string }> = [
  { value: "bottomLeft", label: "Bottom left" },
  { value: "bottomRight", label: "Bottom right" },
  { value: "topLeft", label: "Top left" },
  { value: "topRight", label: "Top right" },
];

export function isRightCorner(corner: CompanionCorner): boolean {
  return corner === "bottomRight" || corner === "topRight";
}
