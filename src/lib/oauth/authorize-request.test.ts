import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth/store", () => ({ resolveClient: vi.fn() }));

// getConfig() is read once per test file: a database URL it never connects to
// (APP_URL wins over the saved address) and the public address.
process.env.DATABASE_URL ??= "postgres://unused@localhost:1/unused";
process.env.APP_URL = "https://velk.example";

const { resolveClient } = await import("@/lib/oauth/store");
const { checkAuthorizeRequest, authorizeRedirect, authorizeQueryString } = await import(
  "@/lib/oauth/authorize-request"
);
const { pkceChallengeOf } = await import("@/lib/oauth/rules");

const CLIENT = {
  id: "row",
  clientId: "11111111-1111-4111-8111-111111111111",
  name: "Claude",
  redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  kind: "registered" as const,
};
const CHALLENGE = pkceChallengeOf("v".repeat(50));

function query(extra: Record<string, string | string[]> = {}) {
  return {
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: CLIENT.redirectUris[0],
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st",
    ...extra,
  };
}

function redirectedTo(check: unknown): URL {
  return new URL((check as { redirectTo: string }).redirectTo);
}

beforeEach(() => {
  vi.mocked(resolveClient).mockReset();
  vi.mocked(resolveClient).mockResolvedValue(CLIENT);
});

describe("checkAuthorizeRequest", () => {
  it("accepts a complete PKCE request and pins the resource to /mcp", async () => {
    const check = await checkAuthorizeRequest(query());
    expect(check).toMatchObject({
      ok: true,
      redirectUri: CLIENT.redirectUris[0],
      codeChallenge: CHALLENGE,
      state: "st",
      resource: "https://velk.example/mcp",
    });
    expect(await checkAuthorizeRequest(query({ resource: "https://velk.example/mcp/" }))).toMatchObject({ ok: true });
  });

  it("keeps errors on the page until the app and its redirect URI are known (no open redirect)", async () => {
    expect(await checkAuthorizeRequest({ client_id: CLIENT.clientId })).toEqual({ ok: false, show: "incomplete" });
    expect(await checkAuthorizeRequest(query({ client_id: ["a", "b"] }))).toEqual({ ok: false, show: "incomplete" });
    vi.mocked(resolveClient).mockResolvedValueOnce(null);
    expect(await checkAuthorizeRequest(query())).toEqual({ ok: false, show: "unknownClient" });
    expect(await checkAuthorizeRequest(query({ redirect_uri: "https://evil.example/cb" }))).toEqual({
      ok: false,
      show: "badRedirect",
    });
  });

  it("sends later errors back to the app with state and iss", async () => {
    const plain = await checkAuthorizeRequest(query({ code_challenge_method: "plain" }));
    expect(plain.ok).toBe(false);
    const url = redirectedTo(plain);
    expect(url.origin + url.pathname).toBe(CLIENT.redirectUris[0]);
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("iss")).toBe("https://velk.example");

    const other = await checkAuthorizeRequest(query({ resource: "https://other.example/mcp" }));
    expect(redirectedTo(other).searchParams.get("error")).toBe("invalid_target");

    const repeated = await checkAuthorizeRequest(query({ state: ["a", "b"] }));
    expect(redirectedTo(repeated).searchParams.get("error")).toBe("invalid_request");

    const token = await checkAuthorizeRequest(query({ response_type: "token" }));
    expect(redirectedTo(token).searchParams.get("error")).toBe("unsupported_response_type");

    const noChallenge = await checkAuthorizeRequest(query({ code_challenge: "short" }));
    expect(redirectedTo(noChallenge).searchParams.get("error")).toBe("invalid_request");
  });
});

describe("helpers", () => {
  it("builds the return URL with the code, keeping the app's own query", async () => {
    const url = new URL(await authorizeRedirect("https://claude.ai/cb?x=1", { code: "vac_x" }, null));
    expect(url.searchParams.get("code")).toBe("vac_x");
    expect(url.searchParams.get("x")).toBe("1");
    expect(url.searchParams.get("iss")).toBe("https://velk.example");
    expect(url.searchParams.has("state")).toBe(false);
  });

  it("passes only the known fields along, in order", () => {
    expect(authorizeQueryString({ state: "s", client_id: "c", junk: "j" })).toBe("client_id=c&state=s");
    expect(authorizeQueryString({ state: ["a", "b"] })).toBe("state=a&state=b");
  });
});
