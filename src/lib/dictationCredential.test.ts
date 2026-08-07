import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = {
  invoked: [] as { command: string; args?: Record<string, unknown> }[],
  response: null as
    | { status: number; body: unknown; ok?: boolean }
    | Error
    | null,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    fake.invoked.push({ command, args });
  }),
}));

// Hoisted alongside the vi.mock calls, which run before any module-level
// declaration in this file would.
const { FakeAuthRequiredError } = vi.hoisted(() => ({
  FakeAuthRequiredError: class extends Error {},
}));

vi.mock("./api", () => ({
  AuthRequiredError: FakeAuthRequiredError,
  authFetch: vi.fn(async () => {
    if (fake.response instanceof Error) throw fake.response;
    const response = fake.response!;
    return {
      status: response.status,
      ok: response.ok ?? response.status < 400,
      json: async () => response.body,
    };
  }),
}));

vi.mock("./log", () => ({ logError: vi.fn() }));

import {
  DictationUnavailableError,
  mintDictationCredential,
  parseDictationCredential,
  refreshDelayMs,
  runCredentialCycle,
} from "./dictationCredential";

beforeEach(() => {
  fake.invoked = [];
  fake.response = null;
});

describe("parseDictationCredential", () => {
  it("accepts the backend's response shape", () => {
    expect(
      parseDictationCredential({ accessToken: "jwt-value", expiresInSeconds: 300 }),
    ).toEqual({ accessToken: "jwt-value", ttlSeconds: 300 });
  });

  it("rejects a response with no token", () => {
    expect(() => parseDictationCredential({ expiresInSeconds: 300 })).toThrow();
    expect(() =>
      parseDictationCredential({ accessToken: "   ", expiresInSeconds: 300 }),
    ).toThrow();
  });

  it("rejects a response with no usable expiry", () => {
    expect(() => parseDictationCredential({ accessToken: "jwt" })).toThrow();
    expect(() =>
      parseDictationCredential({ accessToken: "jwt", expiresInSeconds: "soon" }),
    ).toThrow();
  });

  it("rejects a token too short-lived to survive a handshake", () => {
    // Deepgram's default TTL is 30s; anything near zero would expire between
    // the chord press and the socket opening and surface as a confusing auth
    // failure rather than a clean re-mint.
    expect(() =>
      parseDictationCredential({ accessToken: "jwt", expiresInSeconds: 5 }),
    ).toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => parseDictationCredential(null)).toThrow();
    expect(() => parseDictationCredential("jwt")).toThrow();
  });
});

describe("refreshDelayMs", () => {
  it("refreshes well before expiry", () => {
    // 70% of 300s. Leaves room for a slow mint and one retry before the
    // current token dies.
    expect(refreshDelayMs(300)).toBe(210_000);
    expect(refreshDelayMs(300)).toBeLessThan(300_000);
  });

  it("never schedules a busy loop", () => {
    expect(refreshDelayMs(0)).toBeGreaterThanOrEqual(1_000);
  });
});

describe("mintDictationCredential", () => {
  it("returns the credential on success", async () => {
    fake.response = {
      status: 200,
      body: { accessToken: "jwt-value", expiresInSeconds: 300 },
    };
    await expect(mintDictationCredential()).resolves.toEqual({
      accessToken: "jwt-value",
      ttlSeconds: 300,
    });
  });

  it("maps the backend kill switch to a distinct error", async () => {
    fake.response = { status: 503, body: { error: "Dictation is unavailable." } };
    await expect(mintDictationCredential()).rejects.toBeInstanceOf(
      DictationUnavailableError,
    );
  });

  it("fails on any other non-2xx", async () => {
    fake.response = { status: 500, body: {} };
    await expect(mintDictationCredential()).rejects.toBeTruthy();
  });
});

describe("runCredentialCycle", () => {
  it("hands a fresh credential to Rust and schedules the next refresh", async () => {
    fake.response = {
      status: 200,
      body: { accessToken: "jwt-value", expiresInSeconds: 300 },
    };

    const outcome = await runCredentialCycle();

    expect(outcome).toEqual({ ok: true, nextDelayMs: 210_000 });
    expect(fake.invoked).toEqual([
      {
        command: "dictation_set_credential",
        args: { accessToken: "jwt-value", ttlSeconds: 300 },
      },
    ]);
  });

  it("clears the credential and stops when there is no session", async () => {
    fake.response = new FakeAuthRequiredError("No signed-in user");

    const outcome = await runCredentialCycle();

    // Stopping rather than retrying matters: a signed-out pump on a timer
    // would 401 forever, and signing back in remounts the hook anyway.
    expect(outcome.nextDelayMs).toBeNull();
    expect(fake.invoked.map((call) => call.command)).toEqual([
      "dictation_clear_credential",
    ]);
  });

  it("backs off without clearing a still-valid credential when the backend is down", async () => {
    fake.response = new Error("network down");

    const outcome = await runCredentialCycle();

    expect(outcome.ok).toBe(false);
    expect(outcome.nextDelayMs).toBeGreaterThan(0);
    // Deliberately does NOT clear: dictation should keep working on the token
    // it already has while the backend is having a moment.
    expect(fake.invoked).toEqual([]);
  });

  it("backs off rather than stopping when transcription is switched off", async () => {
    fake.response = { status: 503, body: {} };

    const outcome = await runCredentialCycle();

    expect(outcome.ok).toBe(false);
    expect(outcome.nextDelayMs).toBeGreaterThan(0);
    expect(fake.invoked).toEqual([]);
  });

  it("never throws, whatever the backend returns", async () => {
    fake.response = { status: 200, body: { nonsense: true } };
    await expect(runCredentialCycle()).resolves.toEqual({
      ok: false,
      nextDelayMs: 30_000,
    });
  });
});
