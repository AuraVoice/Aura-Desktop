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

  it("renders an on_screen draft that ships no ladder length (empty or absent)", () => {
    // The adaptive on_screen/snippet channels legitimately carry no ladder
    // length. Rejecting the draft over that left the card stuck on its skeleton
    // (forced-release-order enum drift). It must render, defaulting the length.
    const emptyLength = parseCreatedDraft({
      draft_id: "draft-2",
      revision: 1,
      channel: "on_screen",
      length: "",
      text: "Ready to paste.",
    });
    expect(emptyLength).toMatchObject({ draftId: "draft-2", channel: "on_screen", length: "medium" });

    const noLength = parseCreatedDraft({
      draft_id: "draft-3",
      revision: 1,
      channel: "on_screen",
      text: "Ready to paste.",
    });
    expect(noLength).toMatchObject({ draftId: "draft-3", length: "medium" });
  });

  it("still rejects a draft missing a load-bearing field", () => {
    expect(parseCreatedDraft({ draft_id: "d", channel: "on_screen", length: "medium" })).toBeNull();
    expect(parseCreatedDraft({ channel: "on_screen", length: "medium", text: "hi" })).toBeNull();
    expect(parseCreatedDraft({ draft_id: "d", length: "medium", text: "hi" })).toBeNull();
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
