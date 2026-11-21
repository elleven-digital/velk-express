import "server-only";
import type { MetadataDeps } from "@/lib/oauth/client-metadata";
import {
  isValidCodeChallenge,
  mcpResourceUrl,
  oauthIssuer,
  redirectUriAllowed,
  sameResource,
} from "@/lib/oauth/rules";
import { resolveClient, type OAuthClient } from "@/lib/oauth/store";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Checking the authorization request (`/oauth/authorize`), used by the page
 * and again by the Authorize and Cancel actions, which never trust what the
 * page showed.
 *
 * Order matters. Until the app is recognised and the redirect URI is one of
 * its own, errors stay on the page: sending the person to an unchecked URL
 * would be an open redirect. After that, every error goes back to the app,
 * with `state` and `iss`.
 */

/** The request fields we read, in the order they are passed along. */
export const AUTHORIZE_FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
  "scope",
] as const;

export type AuthorizeQuery = Record<string, string | string[] | undefined>;

/** Errors shown on the page (keys of `t.oauth`). */
export type AuthorizePageError = "incomplete" | "unknownClient" | "badRedirect" | "tooMany";

const ATTEMPTS_PER_MINUTE = 20;

/**
 * Signed-in people are limited too: otherwise any account could make the
 * server fetch a new app document on every page load. `who` names the
 * person and their side (`team:<id>`, `portal:<id>`).
 */
export function authorizeAttemptAllowed(who: string): boolean {
  return rateLimit(`oauth-authorize:${who}`, { limit: ATTEMPTS_PER_MINUTE, windowMs: 60_000 });
}

export type AuthorizeCheck =
  | {
      ok: true;
      client: OAuthClient;
      redirectUri: string;
      codeChallenge: string;
      state: string | null;
      resource: string;
    }
  | { ok: false; show: AuthorizePageError }
  | { ok: false; redirectTo: string };

type AuthorizeError = "access_denied" | "invalid_request" | "unsupported_response_type" | "invalid_target";

function repeated(query: AuthorizeQuery, name: string): boolean {
  const value = query[name];
  return Array.isArray(value) && value.length > 1;
}

function field(query: AuthorizeQuery, name: string): string | null {
  const value = query[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value ?? null;
}

export async function checkAuthorizeRequest(
  query: AuthorizeQuery,
  opts: { deps?: MetadataDeps; now?: Date } = {},
): Promise<AuthorizeCheck> {
  const clientId = field(query, "client_id");
  const redirectUri = field(query, "redirect_uri");
  if (!clientId || !redirectUri) return { ok: false, show: "incomplete" };
  const client = await resolveClient(clientId, opts);
  if (!client) return { ok: false, show: "unknownClient" };
  if (!redirectUriAllowed(client.redirectUris, redirectUri)) return { ok: false, show: "badRedirect" };

  // From here on the redirect URI belongs to the app: errors go back to it.
  const state = field(query, "state");
  const back = async (error: AuthorizeError): Promise<AuthorizeCheck> => ({
    ok: false,
    redirectTo: await authorizeRedirect(redirectUri, { error }, state),
  });
  if (AUTHORIZE_FIELDS.some((name) => repeated(query, name))) return back("invalid_request");

  const responseType = field(query, "response_type");
  if (!responseType) return back("invalid_request");
  if (responseType !== "code") return back("unsupported_response_type");

  const codeChallenge = field(query, "code_challenge");
  if (!codeChallenge || !isValidCodeChallenge(codeChallenge) || field(query, "code_challenge_method") !== "S256") {
    return back("invalid_request");
  }

  // Without `resource`, the /mcp: the token only works there anyway.
  const canonical = await mcpResourceUrl();
  const resource = field(query, "resource");
  if (resource !== null && !sameResource(resource, canonical)) return back("invalid_target");

  return { ok: true, client, redirectUri, codeChallenge, state, resource: canonical };
}

/**
 * The return URL to the app, with the code or the error, `state` (when sent)
 * and always `iss` (RFC 9207), so the app can check who answered.
 */
export async function authorizeRedirect(
  redirectUri: string,
  result: { code: string } | { error: AuthorizeError },
  state: string | null,
): Promise<string> {
  const url = new URL(redirectUri);
  if ("code" in result) url.searchParams.set("code", result.code);
  else url.searchParams.set("error", result.error);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", await oauthIssuer());
  return url.toString();
}

/** The request fields that came, as a query string — what login hands back to the page. */
export function authorizeQueryString(query: AuthorizeQuery): string {
  const out = new URLSearchParams();
  for (const name of AUTHORIZE_FIELDS) {
    const value = query[name];
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      out.append(name, one);
    }
  }
  return out.toString();
}

/** This page with the request fields that came: where login sends back to. */
export function authorizePagePath(query: AuthorizeQuery): string {
  return `/oauth/authorize?${authorizeQueryString(query)}`;
}
