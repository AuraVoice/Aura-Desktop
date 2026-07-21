import { describe, expect, it } from "vitest";
import { DESKTOP_CAPABILITIES, advertiseManifest } from "./desktopCapabilities";

function validate(id: string, args: Record<string, unknown>) {
  const capability = DESKTOP_CAPABILITIES.get(id);
  if (!capability) throw new Error(`no capability ${id}`);
  return capability.validate(args);
}

describe("open_url", () => {
  it("accepts and normalizes http/https URLs", () => {
    expect(validate("open_url", { url: "https://mail.google.com" })).toEqual({
      url: "https://mail.google.com/",
    });
    expect(validate("open_url", { url: "  http://example.com  " })).toEqual({
      url: "http://example.com/",
    });
  });

  it("rejects non-http schemes and junk", () => {
    expect(validate("open_url", { url: "file:///c:/secrets.txt" })).toBeNull();
    expect(validate("open_url", { url: "javascript:alert(1)" })).toBeNull();
    expect(validate("open_url", { url: "not a url" })).toBeNull();
    expect(validate("open_url", { url: "" })).toBeNull();
    expect(validate("open_url", {})).toBeNull();
  });

  it("rejects over-length URLs", () => {
    expect(validate("open_url", { url: `https://x.com/${"a".repeat(3000)}` })).toBeNull();
  });
});

describe("media_control", () => {
  it("accepts the canonical actions, case-insensitively", () => {
    expect(validate("media_control", { action: "play_pause" })).toEqual({ action: "play_pause" });
    expect(validate("media_control", { action: "  VOLUME_UP " })).toEqual({ action: "volume_up" });
  });

  it("rejects unknown actions", () => {
    expect(validate("media_control", { action: "self_destruct" })).toBeNull();
    expect(validate("media_control", {})).toBeNull();
  });
});

describe("focus_window / launch_app app keys", () => {
  it.each(["focus_window", "launch_app"])("%s accepts a normalized app key", (id) => {
    expect(validate(id, { app: "  Spotify " })).toEqual({ app: "spotify" });
  });

  it.each(["focus_window", "launch_app"])("%s rejects empty or over-length keys", (id) => {
    expect(validate(id, { app: "" })).toBeNull();
    expect(validate(id, { app: "a".repeat(100) })).toBeNull();
    expect(validate(id, {})).toBeNull();
  });
});

describe("advertiseManifest", () => {
  it("lists every registered capability with its arg keys", () => {
    const manifest = advertiseManifest();
    expect(manifest.manifest_version).toBe(1);
    const ids = manifest.capabilities.map((c) => c.id);
    expect(ids).toEqual(["open_url", "media_control", "focus_window", "launch_app"]);
    for (const capability of manifest.capabilities) {
      expect(capability.description.length).toBeGreaterThan(0);
      expect(capability.arg_keys.length).toBeGreaterThan(0);
    }
  });
});
