import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/core/install", () => ({ isInstalled: async () => true }));

// The docs name it unstable_doesProxyMatch, but 16.x still ships the function as unstable_doesMiddlewareMatch.
import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";
import nextConfig from "../next.config";
import { config, proxy } from "./proxy";

/** The area header the app will see, as the proxy forwards it to the request. */
async function areaSeen(path: string, forged?: string): Promise<string | null> {
  const res = await proxy(new NextRequest(`http://x${path}`, forged ? { headers: { "x-vx-area": forged } } : {}));
  return res.headers.get("x-middleware-request-x-vx-area");
}

describe("proxy area header", () => {
  it("overwrites a forged area header from the path", async () => {
    expect(await areaSeen("/admin/clients", "portal")).toBe("team");
    expect(await areaSeen("/", "team")).toBe("portal");
    expect(await areaSeen("/login", "team")).toBe("public");
  });

  it("sets the header when the client sent none", async () => {
    expect(await areaSeen("/admin/clients")).toBe("team");
  });
});

describe("proxy legacy cookie", () => {
  it("deletes the old vx_session cookie when a request brings it", async () => {
    const res = await proxy(new NextRequest("http://x/admin/clients", { headers: { cookie: "vx_session=old; vx_team=keep" } }));
    const cleared = res.cookies.get("vx_session");
    expect(cleared?.value).toBe("");
    expect(res.cookies.get("vx_team")).toBeUndefined();
  });

  it("sets no cookie when the request has none of it", async () => {
    const res = await proxy(new NextRequest("http://x/admin/clients"));
    expect(res.cookies.get("vx_session")).toBeUndefined();
  });
});

describe("proxy matcher", () => {
  const matches = (url: string) => doesProxyMatch({ config, nextConfig, url });

  it("the proxy never runs on /api/upload", () => {
    // Next buffers (and silently truncates at 10 MB) any body the proxy sees.
    expect(matches("/api/upload")).toBe(false);
    expect(matches("/api/upload/")).toBe(false);
  });

  it("the proxy never runs on the payment webhooks", () => {
    // The signature covers the raw body, and an uninstalled app must not redirect a provider's POST.
    expect(matches("/api/webhooks/stripe")).toBe(false);
    expect(matches("/api/webhooks/mercadopago")).toBe(false);
    expect(matches("/api/webhooks")).toBe(false);
  });

  it("still runs on the app and the other API routes", () => {
    expect(matches("/admin")).toBe(true);
    expect(matches("/")).toBe(true);
    expect(matches("/api/files/x")).toBe(true);
    // Only the exact path is excluded, not a route that merely starts with it.
    expect(matches("/api/uploads")).toBe(true);
    expect(matches("/api/upload-x/y")).toBe(true);
    expect(matches("/api/webhooksx")).toBe(true);
  });
});
