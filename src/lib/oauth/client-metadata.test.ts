import { describe, expect, it, vi } from "vitest";
import {
  cacheTtlMs,
  clientNameOf,
  fetchClientMetadata,
  isMetadataDocumentClientId,
  isPrivateAddress,
  redirectUriShapeOk,
  type MetadataDeps,
} from "@/lib/oauth/client-metadata";

const URL_ID = "https://app.example/oauth/client.json";

function deps(response: Response, addresses = [{ address: "93.184.216.34", family: 4 }]): MetadataDeps {
  return {
    lookup: vi.fn(async () => addresses),
    fetch: vi.fn(async () => response),
  };
}

const goodDocument = {
  client_id: URL_ID,
  client_name: "Example AI",
  redirect_uris: ["https://app.example/callback"],
};

describe("client id metadata documents", () => {
  it("only https URLs with a path qualify", () => {
    expect(isMetadataDocumentClientId(URL_ID)).toBe(true);
    expect(isMetadataDocumentClientId("http://app.example/client.json")).toBe(false);
    expect(isMetadataDocumentClientId("https://app.example/")).toBe(false);
    expect(isMetadataDocumentClientId("https://user:pw@app.example/x")).toBe(false);
  });

  it("reads a valid document and honours max-age up to 24 hours", async () => {
    const result = await fetchClientMetadata(
      URL_ID,
      deps(Response.json(goodDocument, { headers: { "Cache-Control": "max-age=600" } }))
    );
    expect(result).toEqual({
      ok: true,
      name: "Example AI",
      redirectUris: ["https://app.example/callback"],
      ttlMs: 600_000,
    });
  });

  it("refuses a host that resolves to a private address, without fetching", async () => {
    const d = deps(Response.json(goodDocument), [{ address: "10.0.0.5", family: 4 }]);
    expect(await fetchClientMetadata(URL_ID, d)).toEqual({ ok: false, reason: "private_address" });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("refuses redirects, oversized bodies and a client_id that isn't its own URL", async () => {
    expect(
      await fetchClientMetadata(URL_ID, deps(new Response(null, { status: 302, headers: { Location: "https://x" } })))
    ).toEqual({ ok: false, reason: "redirected" });
    expect(
      await fetchClientMetadata(URL_ID, deps(new Response("x".repeat(70 * 1024), { status: 200 })))
    ).toEqual({ ok: false, reason: "too_large" });
    expect(
      await fetchClientMetadata(URL_ID, deps(Response.json({ ...goodDocument, client_id: "https://other/x" })))
    ).toEqual({ ok: false, reason: "client_id_mismatch" });
  });
});

describe("addresses", () => {
  it("treats loopback, private, link-local, mapped and NAT64 forms as internal", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "::",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "64:ff9b::a00:1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("lets public addresses through", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("what the app says about itself", () => {
  it("accepts https and loopback http redirect URIs only", () => {
    expect(redirectUriShapeOk("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriShapeOk("http://localhost:4000/cb")).toBe(true);
    expect(redirectUriShapeOk("http://app.example/cb")).toBe(false);
    expect(redirectUriShapeOk("https://app.example/cb#frag")).toBe(false);
  });

  it("keeps the name on one line, without control or bidi characters", () => {
    expect(clientNameOf("Claude\n‮evil")).toBe("Claude evil");
    expect(clientNameOf("x".repeat(101))).toBeNull();
    expect(clientNameOf(42)).toBeNull();
  });

  it("caches by Cache-Control", () => {
    expect(cacheTtlMs(null)).toBe(24 * 60 * 60 * 1000);
    expect(cacheTtlMs("no-store")).toBe(0);
    expect(cacheTtlMs("max-age=999999")).toBe(24 * 60 * 60 * 1000);
  });
});
