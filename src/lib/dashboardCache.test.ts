import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => new Map<string, unknown>());
const store = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => values.get(key)),
  set: vi.fn(async (key: string, value: unknown) => values.set(key, value)),
  delete: vi.fn(async (key: string) => values.delete(key)),
  keys: vi.fn(async () => [...values.keys()]),
  save: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => store) }));
vi.mock("./log", () => ({ logError: vi.fn() }));

import { readCache, writeCache } from "./dashboardCache";

describe("dashboardCache", () => {
  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
  });

  it("round-trips data under a versioned envelope", async () => {
    await writeCache("k-roundtrip", { a: 1 }, 1000);
    const entry = await readCache<{ a: number }>("k-roundtrip");
    expect(entry).toEqual({ data: { a: 1 }, cachedAt: 1000 });
  });

  it("advances disk freshness when the payload is unchanged", async () => {
    await writeCache("k-dedupe", { a: 1 }, 1000);
    expect(store.save).toHaveBeenCalledTimes(1);
    await writeCache("k-dedupe", { a: 1 }, 2000);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(await readCache("k-dedupe")).toEqual({ data: { a: 1 }, cachedAt: 2000 });
    // A genuine change writes again.
    await writeCache("k-dedupe", { a: 2 }, 3000);
    expect(store.save).toHaveBeenCalledTimes(3);
  });

  it("treats a version mismatch as a miss", async () => {
    values.set("k-oldschema", { v: 0, data: { a: 1 }, cachedAt: 1, hash: "x" });
    expect(await readCache("k-oldschema")).toBeNull();
  });
});
