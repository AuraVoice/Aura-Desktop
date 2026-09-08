import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  alias: vi.fn(),
  setPersonProperties: vi.fn(),
  get_distinct_id: vi.fn(() => "anon-1"),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("posthog-js/dist/module.full.no-external", () => ({ default: posthogMock }));
vi.mock("./firebase", () => ({ auth: { currentUser: null } }));
vi.mock("./log", () => ({ logError: vi.fn() }));
vi.mock("./sentry", () => ({ setSentryUser: vi.fn() }));

import {
  aliasAnonymousToUser,
  initAnalyticsSdk,
  setPersonProperties,
  setTelemetryEnabled,
} from "./analytics";

afterEach(() => {
  vi.clearAllMocks();
});

describe("analytics person properties", () => {
  beforeEach(() => {
    initAnalyticsSdk({ label: "main", installId: "anon-1" });
    setTelemetryEnabled(false);
  });

  it("does nothing when telemetry is disabled", () => {
    setPersonProperties({ role: "founder" }, "anon-1");
    aliasAnonymousToUser("anon-1", "uid-1");
    expect(posthogMock.setPersonProperties).not.toHaveBeenCalled();
    expect(posthogMock.identify).not.toHaveBeenCalled();
    expect(posthogMock.alias).not.toHaveBeenCalled();
  });

  it("posts a $set under the given distinct_id when enabled", () => {
    setTelemetryEnabled(true);
    setPersonProperties({ where_heard: "youtube" }, "anon-1");
    expect(posthogMock.setPersonProperties).toHaveBeenCalledTimes(1);
    expect(posthogMock.setPersonProperties).toHaveBeenCalledWith({ where_heard: "youtube" });
  });

  it("aliases the anonymous id to the uid", () => {
    setTelemetryEnabled(true);
    aliasAnonymousToUser("anon-1", "uid-1");
    // Still on the anonymous id, so the SDK's own identify carries the merge.
    expect(posthogMock.identify).toHaveBeenCalledTimes(1);
    expect(posthogMock.identify).toHaveBeenCalledWith("uid-1");
  });
});
