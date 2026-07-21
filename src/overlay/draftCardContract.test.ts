import { describe, expect, it } from "vitest";
import { boundedDraftSlotHeight, MESSAGE_REFINE_CHIPS } from "./DraftCard";
import { parseCreatedDraft } from "./useDraftCard";

describe("draft card cross-repository contract", () => {
  it("accepts the backend's adaptive on_screen channel", () => {
    const draft = parseCreatedDraft({
      draft_id: "draft-1",
      revision: 1,
      channel: "on_screen",
      length: "medium",
      text: "A ready-to-paste answer.",
    });

    expect(draft).toMatchObject({
      draftId: "draft-1",
      channel: "on_screen",
      text: "A ready-to-paste answer.",
    });
  });

  it("grows with content while staying within display-safe bounds", () => {
    expect(boundedDraftSlotHeight(90, 900)).toBe(142);
    expect(boundedDraftSlotHeight(300, 900)).toBe(306);
    expect(boundedDraftSlotHeight(900, 500)).toBe(420);
  });

  it("keeps the message refinement row to four useful actions", () => {
    expect(MESSAGE_REFINE_CHIPS).toEqual(["shorter", "longer", "warmer", "regenerate"]);
  });
});
