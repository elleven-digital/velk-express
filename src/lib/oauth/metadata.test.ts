import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-url", () => ({ getAppUrl: async () => "https://agency.test/" }));

const {
  authorizationServerMetadata,
  metadataResponse,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} = await import("@/lib/oauth/metadata");

describe("OAuth metadata", () => {
  it("names the install's public address as issuer and every endpoint under it", async () => {
    expect(await authorizationServerMetadata()).toMatchObject({
      issuer: "https://agency.test",
      authorization_endpoint: "https://agency.test/oauth/authorize",
      token_endpoint: "https://agency.test/oauth/token",
      registration_endpoint: "https://agency.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["velk"],
      client_id_metadata_document_supported: true,
    });
  });

  it("describes /mcp as the protected resource, authorized by the issuer", async () => {
    expect(await protectedResourceMetadata()).toEqual({
      resource: "https://agency.test/mcp",
      authorization_servers: ["https://agency.test"],
      scopes_supported: ["velk"],
      bearer_methods_supported: ["header"],
      resource_name: "Velk Express",
    });
    expect(await protectedResourceMetadataUrl()).toBe("https://agency.test/.well-known/oauth-protected-resource/mcp");
  });

  it("answers JSON with CORS on GET, an empty preflight on OPTIONS, and 405 otherwise", async () => {
    const at = (method: string) => new Request("https://agency.test/.well-known/oauth-authorization-server", { method });
    const get = metadataResponse(at("GET"), { a: 1 });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe("*");
    expect(await get.json()).toEqual({ a: 1 });

    const options = metadataResponse(at("OPTIONS"), { a: 1 });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-methods")).toContain("GET");

    const head = metadataResponse(at("HEAD"), { a: 1 });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = metadataResponse(at("POST"), { a: 1 });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});
