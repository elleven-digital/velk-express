import { describe, expect, it } from "vitest";
import { detectAppUrl, normalizeAppUrl } from "./app-url";

describe("normalizeAppUrl", () => {
  it("strips the trailing slash, path and query", () => {
    expect(normalizeAppUrl("https://a.com/")).toBe("https://a.com");
    expect(normalizeAppUrl("https://a.com/x?y")).toBe("https://a.com");
    expect(normalizeAppUrl("  http://localhost:3000/  ")).toBe("http://localhost:3000");
  });

  it("rejects non-http(s) and garbage", () => {
    expect(normalizeAppUrl("javascript:x")).toBeNull();
    expect(normalizeAppUrl("ftp://a.com")).toBeNull();
    expect(normalizeAppUrl("not a url")).toBeNull();
    expect(normalizeAppUrl("")).toBeNull();
  });
});

describe("detectAppUrl", () => {
  it("uses the forwarded proto and host", () => {
    const h = new Headers({ "x-forwarded-proto": "https", "x-forwarded-host": "painel.a.com", host: "internal:3000" });
    expect(detectAppUrl(h)).toBe("https://painel.a.com");
  });

  it("uses only the first value of comma-separated forwarded headers", () => {
    const h = new Headers({ "x-forwarded-proto": "https, http", "x-forwarded-host": "painel.a.com, proxy.local" });
    expect(detectAppUrl(h)).toBe("https://painel.a.com");
  });

  it("falls back to host with http", () => {
    expect(detectAppUrl(new Headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });

  it("returns null without a host", () => {
    expect(detectAppUrl(new Headers())).toBeNull();
  });

  it("ignores other headers", () => {
    expect(detectAppUrl(new Headers({ origin: "https://evil.com", referer: "https://evil.com/x" }))).toBeNull();
  });
});
