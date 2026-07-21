// The four screen edges the notch can dock to. Mirrors the Rust `NotchEdge`
// enum (serde lowercase), which is the source of truth; the frontend receives
// the current edge in the overlay-changed snapshot and sends a target edge back
// via the set/commit notch-move commands.
export type NotchEdge = "top" | "bottom" | "left" | "right";

export const NOTCH_EDGES: readonly NotchEdge[] = ["top", "bottom", "left", "right"];

/** Left/Right dock the pill rotated to vertical. */
export function isVerticalEdge(edge: NotchEdge): boolean {
  return edge === "left" || edge === "right";
}

/**
 * The edge whose center is nearest the pointer, by which screen half the pointer
 * sits in and whether it is closer to a horizontal or vertical edge. `x`/`y` are
 * fractions (0..1) of the display's width/height.
 */
export function nearestEdge(xFraction: number, yFraction: number): NotchEdge {
  const distTop = yFraction;
  const distBottom = 1 - yFraction;
  const distLeft = xFraction;
  const distRight = 1 - xFraction;
  const min = Math.min(distTop, distBottom, distLeft, distRight);
  if (min === distTop) return "top";
  if (min === distBottom) return "bottom";
  if (min === distLeft) return "left";
  return "right";
}
