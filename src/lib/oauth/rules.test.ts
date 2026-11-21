import { describe, expect, it } from "vitest";
import {
  appUrl,
  hashSecret,
  isValidCodeChallenge,
  isValidCodeVerifier,
  mcpResourceUrl,
  newSecret,
  oauthIssuer,
  pkceChallengeOf,
  redirectUriAllowed,
  sameResource,
  verifyPkce,
} from "@/lib/oauth/rules";

// getConfig() is read once per test file: a database URL it never connects to
// (APP_URL wins over the saved address) and the public address with a trailing slash.
process.env.DATABASE_URL ??= "postgres://unused@localhost:1/unused";
process.env.APP_URL = "https://velk.example/";

const VERIFIER = "a".repeat(43);

describe("secrets", () => {
  it("carry their prefix and are random", () => {
    const one = newSecret("vat_");
    expect(one).toMatch(/^vat_[A-Za-z0-9_-]{43}$/);
    expect(newSecret("vat_")).not.toBe(one);
    expect(newSecret("vrt_")).toMatch(/^vrt_/);
    expect(newSecret("vac_")).toMatch(/^vac_/);
  });

  it("are stored as a sha256 hex hash, never as themselves", () => {
    const secret = newSecret("vrt_");
    expect(hashSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(secret)).not.toContain(secret);
    expect(hashSecret(secret)).toBe(hashSecret(secret));
  });
});

describe("PKCE S256", () => {
  it("accepts the verifier whose hash is the challenge", () => {
    const challenge = pkceChallengeOf(VERIFIER);
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(verifyPkce(VERIFIER, challenge)).toBe(true);
  });

  it("refuses another verifier, a short verifier and a malformed challenge", () => {
    const challenge = pkceChallengeOf(VERIFIER);
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(verifyPkce("a".repeat(42), pkceChallengeOf("a".repeat(42)))).toBe(false);
    expect(verifyPkce(VERIFIER, "not-a-challenge")).toBe(false);
  });

  it("bounds the verifier to 43-128 unreserved characters", () => {
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)} `)).toBe(false);
  });
});

describe("redirect URI matching", () => {
  it("is exact for https", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback"];
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(redirectUriAllowed(registered, "https://evil.example/api/mcp/auth_callback")).toBe(false);
  });

  it("lets the loopback port change (desktop apps), but nothing else", () => {
    const registered = ["http://127.0.0.1:33418/callback"];
    expect(redirectUriAllowed(registered, "http://127.0.0.1:51234/callback")).toBe(true);
    expect(redirectUriAllowed(registered, "http://127.0.0.1:51234/other")).toBe(false);
    expect(redirectUriAllowed(registered, "http://localhost:51234/callback")).toBe(false);
  });
});

describe("resource and issuer", () => {
  it("the issuer is the configured public address, without a trailing slash", async () => {
    expect(await oauthIssuer()).toBe("https://velk.example");
  });

  it("the resource is <issuer>/mcp, and appUrl joins a path to the issuer", async () => {
    expect(await mcpResourceUrl()).toBe("https://velk.example/mcp");
    expect(await appUrl("/oauth/token")).toBe("https://velk.example/oauth/token");
  });

  it("compare resources ignoring a trailing slash and the fragment", () => {
    expect(sameResource("https://velk.example/mcp/", "https://velk.example/mcp")).toBe(true);
    expect(sameResource("https://velk.example/mcp#x", "https://velk.example/mcp")).toBe(true);
    expect(sameResource("https://other.app/mcp", "https://velk.example/mcp")).toBe(false);
    expect(sameResource("", "https://velk.example/mcp")).toBe(false);
  });
});
