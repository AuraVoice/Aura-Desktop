import { describe, expect, it } from "vitest";

import { notifications as copy } from "./notificationCopy";

describe("stampTime", () => {
  // Fixed local reference: Sun Jul 19 2026, 3:00 PM.
  const now = new Date(2026, 6, 19, 15, 0, 0).getTime();

  it("labels the same calendar day as Today with a time", () => {
    const stamp = copy.stampTime(new Date(2026, 6, 19, 2, 41).getTime(), now);
    expect(stamp).toMatch(/^Today at /);
    expect(stamp).toContain("2:41");
  });

  it("labels the previous calendar day as Yesterday", () => {
    const stamp = copy.stampTime(new Date(2026, 6, 18, 9, 3).getTime(), now);
    expect(stamp).toMatch(/^Yesterday at /);
    expect(stamp).toContain("9:03");
  });

  it("shows month and day within the same year", () => {
    const stamp = copy.stampTime(new Date(2026, 6, 12, 16, 15).getTime(), now);
    expect(stamp).toContain("Jul");
    expect(stamp).toContain("12");
    expect(stamp).toContain(" at ");
    expect(stamp).not.toContain("2026");
  });

  it("adds the year for older rows", () => {
    const stamp = copy.stampTime(new Date(2025, 6, 12, 16, 15).getTime(), now);
    expect(stamp).toContain("2025");
    expect(stamp).toContain(" at ");
  });

  it("crosses a month boundary correctly for Yesterday", () => {
    const firstOfMonth = new Date(2026, 6, 1, 8, 0).getTime();
    const lastOfJune = new Date(2026, 5, 30, 8, 0).getTime();
    expect(copy.stampTime(lastOfJune, firstOfMonth)).toMatch(/^Yesterday at /);
  });
});
