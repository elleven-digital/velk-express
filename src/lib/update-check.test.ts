import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLatestRelease, isNewer, resetUpdateCheckCache } from "./update-check";

describe("isNewer", () => {
  it("compares semver numerically and ignores a leading v", () => {
    expect(isNewer("v1.2.0", "1.1.9")).toBe(true);
    expect(isNewer("1.1.9", "1.1.9")).toBe(false);
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.1")).toBe(false);
  });

  it("is false for versions it cannot read", () => {
    expect(isNewer("nightly", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "")).toBe(false);
  });
});

describe("getLatestRelease", () => {
  beforeEach(() => {
    resetUpdateCheckCache();
    delete process.env.UPDATE_CHECK;
  });
  afterEach(() => {
    delete process.env.UPDATE_CHECK;
    vi.useRealTimers();
  });

  const release = (tag: string) =>
    vi.fn(async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://example.test/${tag}` })));

  it("reads the tag and the page of the latest release", async () => {
    const fetcher = release("v1.4.0");
    expect(await getLatestRelease(fetcher as unknown as typeof fetch)).toEqual({
      version: "1.4.0",
      url: "https://example.test/v1.4.0",
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/elleven-digital/velk-express/releases/latest");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("velk-express");
    expect(init.signal).toBeDefined();
  });

  it("ignores a release whose page is not an https address", async () => {
    for (const url of ["http://example.test/v2", "javascript:alert(1)", "//example.test/v2"]) {
      resetUpdateCheckCache();
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v2.0.0", html_url: url })));
      expect(await getLatestRelease(fetcher as unknown as typeof fetch)).toBeNull();
    }
  });

  it("returns null when the request throws, and when the answer is not OK", async () => {
    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await getLatestRelease(boom as unknown as typeof fetch)).toBeNull();
    resetUpdateCheckCache();
    const notFound = vi.fn(async () => new Response("{}", { status: 404 }));
    expect(await getLatestRelease(notFound as unknown as typeof fetch)).toBeNull();
  });

  it("does not call fetch at all when UPDATE_CHECK=false", async () => {
    process.env.UPDATE_CHECK = "false";
    const fetcher = release("v9.0.0");
    expect(await getLatestRelease(fetcher as unknown as typeof fetch)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shares one in-flight request between simultaneous calls", async () => {
    const fetcher = release("v1.5.0");
    const [a, b] = await Promise.all([
      getLatestRelease(fetcher as unknown as typeof fetch),
      getLatestRelease(fetcher as unknown as typeof fetch),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("caches the answer for 12 hours, a failure included", async () => {
    vi.useFakeTimers();
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await getLatestRelease(failing as unknown as typeof fetch)).toBeNull();
    expect(await getLatestRelease(failing as unknown as typeof fetch)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1000);
    const fetcher = release("v2.0.0");
    expect((await getLatestRelease(fetcher as unknown as typeof fetch))?.version).toBe("2.0.0");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
