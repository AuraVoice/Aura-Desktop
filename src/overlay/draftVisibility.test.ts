import { describe, expect, it } from "vitest";
import { pendingDraftRestoreAction } from "./draftVisibility";

describe("pendingDraftRestoreAction", () => {
  it("does not reopen an existing draft after an intentional hide", () => {
    expect(pendingDraftRestoreAction(false, "shown", "hidden")).toBe("none");
  });

  it("waits for pointer mode and restores a draft only if it returns hidden", () => {
    expect(pendingDraftRestoreAction(true, "shown", "pointing")).toBe("wait");
    expect(pendingDraftRestoreAction(true, "shown", "hidden")).toBe("restore");
  });

  it("clears a pending restore when pointer mode returns to the companion", () => {
    expect(pendingDraftRestoreAction(true, "shown", "companion")).toBe("clear");
  });
});
