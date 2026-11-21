import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAppUrl } from "@/lib/app-url";

/**
 * Pure rules of the AI-app login (OAuth 2.1 with PKCE): lifetimes, secrets,
 * PKCE `S256`, redirect URI matching and the two URLs that identify this
 * install — the protected resource (`/mcp`) and the issuer.
 *
 * Tokens are opaque, not JWTs: 32 random bytes in base64url with a prefix
 * that says what each one is. The database only keeps their hash
 * (`hashSecret`); the raw value leaves once, in the response.
 */

/** The only scope: whatever the person can do in the panel. */
export const OAUTH_SCOPE = "velk";

/** Authorization code: 10 minutes, single use. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** Access token. */
export const ACCESS_TTL_MS = 60 * 60 * 1000;
/** Refresh token: 60 days since last use (each use replaces it). */
export const REFRESH_IDLE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
/** A connection's "last used" is written at most once per this interval. */
export const LAST_USED_EVERY_MS = 60 * 1000;
/** /mcp requests allowed per connection and window. */
export const MCP_RATE_LIMIT = 60;
export const MCP_RATE_WINDOW_MS = 60 * 1000;

/** `vat_` = access token; `vrt_` = refresh token; `vac_` = authorization code. */
export type SecretPrefix = "vat_" | "vrt_" | "vac_";

export function newSecret(prefix: SecretPrefix): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** How tokens and codes are stored. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// RFC 7636 §4.1: 43 to 128 unreserved characters.
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
// SHA-256 in base64url without padding: always 43 characters.
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeVerifier(verifier: string): boolean {
  return CODE_VERIFIER.test(verifier);
}

export function isValidCodeChallenge(challenge: string): boolean {
  return CODE_CHALLENGE.test(challenge);
}

/** The `S256` challenge of a verifier: its SHA-256 in base64url. */
export function pkceChallengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Does the verifier match the stored challenge? Constant time either way. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const computed = Buffer.from(pkceChallengeOf(verifier));
  const stored = Buffer.from(challenge);
  return computed.length === stored.length && timingSafeEqual(computed, stored);
}

/** A loopback `http` URI as written, without the port; `null` for anything else. */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?([/?].*)?$/;

function withoutLoopbackPort(uri: string): string | null {
  const parts = LOOPBACK.exec(uri);
  return parts ? `http://${parts[1]}${parts[2] ?? ""}` : null;
}

/**
 * The redirect URI is one the app declared, character for character —
 * nothing is normalised. Except the loopback port: desktop apps (Claude
 * Code) listen on a free port that changes on every login, and RFC 8252
 * §7.3 says any port must be accepted there. Host, path and query still
 * match exactly.
 */
export function redirectUriAllowed(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  const stripped = withoutLoopbackPort(given);
  if (stripped === null) return false;
  return registered.some((uri) => withoutLoopbackPort(uri) === stripped);
}

/**
 * The authorization server identifier: the install's public address
 * (`getAppUrl()`), no trailing slash. Read on every call, because the saved
 * address can change; throws before install, like `getAppUrl()`.
 */
export async function oauthIssuer(): Promise<string> {
  return (await getAppUrl()).replace(/\/+$/, "");
}

/** Absolute URL on the install's public address. */
export async function appUrl(path: string): Promise<string> {
  return `${await oauthIssuer()}${path}`;
}

/** The protected resource (RFC 8707): the connector URL. */
export async function mcpResourceUrl(): Promise<string> {
  return appUrl("/mcp");
}

function comparableResource(value: string): string {
  const hash = value.indexOf("#");
  return (hash === -1 ? value : value.slice(0, hash)).replace(/\/$/, "");
}

/** Is the requested resource the expected one (ignoring fragment and trailing slash)? */
export function sameResource(given: string, canonical: string): boolean {
  if (!given) return false;
  return comparableResource(given) === comparableResource(canonical);
}

/**
 * CORS for the routes AI apps read from the browser: metadata, registration
 * and token. Open to any origin because none of them uses cookies.
 */
export const OAUTH_CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};
