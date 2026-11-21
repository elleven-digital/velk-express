import { describe, expect, it } from "vitest";
import { parseRegistration, registrationResponse } from "@/lib/oauth/registration";

describe("dynamic client registration", () => {
  it("reads name and redirect URIs; the auth method is always none", () => {
    const parsed = parseRegistration({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { name: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] },
    });
    const response = registrationResponse(
      { clientId: "abc", name: "Claude", redirectUris: ["https://claude.ai/cb"] },
      new Date("2026-11-08T12:00:00Z")
    );
    expect(response.token_endpoint_auth_method).toBe("none");
    expect(response.client_id_issued_at).toBe(1794139200);
  });

  it("names a nameless app", () => {
    const parsed = parseRegistration({ redirect_uris: ["http://127.0.0.1:3000/cb"] });
    expect(parsed.ok && parsed.value.name).toBe("Unnamed app");
  });

  it("refuses bad redirect URIs, bad names and grants without authorization_code", () => {
    expect(parseRegistration({ redirect_uris: ["http://evil.example/cb"] })).toMatchObject({
      ok: false,
      refusal: { error: "invalid_redirect_uri" },
    });
    expect(
      parseRegistration({ redirect_uris: ["https://a.example/cb"], client_name: "x".repeat(200) })
    ).toMatchObject({ ok: false, refusal: { error: "invalid_client_metadata" } });
    expect(
      parseRegistration({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] })
    ).toMatchObject({ ok: false, refusal: { error: "invalid_client_metadata" } });
    expect(parseRegistration([])).toMatchObject({ ok: false });
  });
});
