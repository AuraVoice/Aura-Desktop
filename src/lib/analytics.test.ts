import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
}));
vi.mock("./firebase", () => ({ auth: { currentUser: null } }));
vi.mock("./log", () => ({ logError: vi.fn() }));

import { fetch } from "@tauri-apps/plugin-http";
import {
  aliasAnonymousToUser,
  setPersonProperties,
  setTelemetryEnabled,
} from "./analytics";

const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

function lastBody() {
  const calls = fetchMock.mock.calls;
  const call = calls[calls.length - 1];
  return JSON.parse((call[1] as { body: string }).body);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("analytics person properties", () => {
  beforeEach(() => setTelemetryEnabled(false));

  it("does nothing when telemetry is disabled", () => {
    setPersonProperties({ role: "founder" }, "anon-1");
    aliasAnonymousToUser("anon-1", "uid-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a $set under the given distinct_id when enabled", () => {
    setTelemetryEnabled(true);
    setPersonProperties({ where_heard: "youtube" }, "anon-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastBody();
    expect(body.event).toBe("$identify");
    expect(body.distinct_id).toBe("anon-1");
    expect(body.properties.$set).toEqual({ where_heard: "youtube" });
  });

  it("aliases the anonymous id to the uid", () => {
    setTelemetryEnabled(true);
    aliasAnonymousToUser("anon-1", "uid-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastBody();
    expect(body.event).toBe("$create_alias");
    expect(body.distinct_id).toBe("uid-1");
    expect(body.properties.alias).toBe("anon-1");
  });
});
