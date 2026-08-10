import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  DashboardResourceScope,
  useDashboardResource,
  type ResourceHandle,
} from "./useDashboardResource";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const readCache = vi.hoisted(() => vi.fn(async () => null));
const writeCache = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/dashboardCache", () => ({
  dashboardCacheKey: (uid: string, key: string) => `uid:${uid}:${key}`,
  readCache,
  writeCache,
}));
vi.mock("../lib/api", () => ({ AuthRequiredError: class AuthRequiredError extends Error {} }));
vi.mock("../lib/log", () => ({ logError: vi.fn() }));

let renderer: ReactTestRenderer | null = null;

function ResourceProbe<T>({
  cacheKey,
  fetcher,
  toCache,
  onState,
}: {
  cacheKey: string;
  fetcher: (signal: AbortSignal) => Promise<T>;
  toCache?: (data: T) => T;
  onState: (state: ResourceHandle<T>) => void;
}) {
  onState(useDashboardResource(cacheKey, fetcher, toCache ? { toCache } : undefined));
  return null;
}

function Probe<T>(props: React.ComponentProps<typeof ResourceProbe<T>>) {
  return createElement(
    DashboardResourceScope,
    { uid: "test-user" },
    createElement(ResourceProbe<T>, props),
  );
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

describe("useDashboardResource", () => {
  it("cold-fetches, exposes data, and persists it", async () => {
    const fetcher = vi.fn(async () => [1, 2, 3]);
    let last: ResourceHandle<number[]> | null = null;
    await act(async () => {
      renderer = create(
        createElement(Probe<number[]>, { cacheKey: "k-cold", fetcher, onState: (s) => (last = s) }),
      );
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(last!.data).toEqual([1, 2, 3]);
    expect(last!.loading).toBe(false);
    expect(writeCache).toHaveBeenCalledWith(
      "uid:test-user:k-cold",
      [1, 2, 3],
      expect.any(Number),
    );
  });

  it("does not refetch within the freshness window on remount", async () => {
    const fetcher = vi.fn(async () => ["x"]);
    await act(async () => {
      renderer = create(
        createElement(Probe<string[]>, { cacheKey: "k-fresh", fetcher, onState: () => {} }),
      );
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    act(() => renderer?.unmount());
    renderer = null;

    // Remount the same key immediately: the in-memory tier is fresh -> no network.
    await act(async () => {
      renderer = create(
        createElement(Probe<string[]>, { cacheKey: "k-fresh", fetcher, onState: () => {} }),
      );
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("strips ephemeral fields via toCache before persisting", async () => {
    const fetcher = vi.fn(async () => [{ id: "a", image_url: "signed://x" }]);
    await act(async () => {
      renderer = create(
        createElement(Probe<{ id: string; image_url: string | null }[]>, {
          cacheKey: "k-strip",
          fetcher,
          toCache: (data) => data.map((d) => ({ ...d, image_url: null })),
          onState: () => {},
        }),
      );
    });
    await flush();
    expect(writeCache).toHaveBeenCalledWith(
      "uid:test-user:k-strip",
      [{ id: "a", image_url: null }],
      expect.any(Number),
    );
  });

  it("surfaces a cold failure as error with no cached data", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("boom");
    });
    let last: ResourceHandle<unknown> | null = null;
    await act(async () => {
      renderer = create(
        createElement(Probe<unknown>, { cacheKey: "k-fail", fetcher, onState: (s) => (last = s) }),
      );
    });
    await flush();
    expect(last!.error).toBe(true);
    expect(last!.loading).toBe(false);
    expect(last!.data).toBeNull();
  });
});
