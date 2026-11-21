import "server-only";
import { OAUTH_CORS_HEADERS } from "@/lib/oauth/rules";
import {
  exchangeAuthorizationCode,
  isKnownClient,
  refreshAccessToken,
  type TokenSet,
} from "@/lib/oauth/store";

/**
 * The token exchange (`POST /oauth/token`, RFC 6749 with PKCE): the code for
 * the first token, and a refresh for the next one. Form-encoded body; every
 * response is `no-store`.
 *
 * RFC errors, all 400 with `{ error }`. An unexpected failure (database down)
 * is `server_error` with 500, still with no-store and CORS; only the error's
 * name is logged.
 *
 * The app is checked in the database only: a client_id never seen is
 * `invalid_client` without fetching anything — this route is public.
 */

type TokenEndpointError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_target"
  | "unsupported_grant_type"
  | "server_error";

export const TOKEN_BODY_MAX_BYTES = 16 * 1024;

const NO_STORE = { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" };

function error(code: TokenEndpointError, status = 400): Response {
  return Response.json({ error: code }, { status, headers: NO_STORE });
}

export function tooManyRequests(): Response {
  return Response.json(
    { error: "too_many_requests" },
    { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } },
  );
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TOKEN_BODY_MAX_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > TOKEN_BODY_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function tokens(set: TokenSet): Response {
  return Response.json(
    {
      access_token: set.accessToken,
      token_type: "Bearer",
      expires_in: set.expiresIn,
      refresh_token: set.refreshToken,
      scope: set.scope,
    },
    { headers: NO_STORE },
  );
}

class RefusedField extends Error {}

export async function handleTokenRequest(request: Request, now?: Date): Promise<Response> {
  try {
    return await exchange(request, now);
  } catch (failure) {
    console.error("[mcp] token exchange failed", {
      error: failure instanceof Error ? failure.name : "unknown",
    });
    return error("server_error", 500);
  }
}

async function exchange(request: Request, now: Date | undefined): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  if (type.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return error("invalid_request");
  }
  const text = await readBody(request);
  if (text === null) return error("invalid_request");
  const body = new URLSearchParams(text);

  const optional = (name: string): string | null => {
    const values = body.getAll(name);
    if (values.length > 1) throw new RefusedField();
    return values[0] || null;
  };
  const required = (name: string): string => {
    const value = optional(name);
    if (value === null) throw new RefusedField();
    return value;
  };

  try {
    const grantType = required("grant_type");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return error("unsupported_grant_type");
    }
    const clientId = required("client_id");
    const resource = optional("resource");

    if (grantType === "authorization_code") {
      const code = required("code");
      const redirectUri = required("redirect_uri");
      const codeVerifier = required("code_verifier");
      if (!(await isKnownClient(clientId))) return error("invalid_client");
      const result = await exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri,
        codeVerifier,
        resource,
        now,
      });
      return result.ok ? tokens(result.tokens) : error(result.error);
    }

    const refreshToken = required("refresh_token");
    if (!(await isKnownClient(clientId))) return error("invalid_client");
    const result = await refreshAccessToken({ refreshToken, clientId, resource, now });
    return result.ok ? tokens(result.tokens) : error(result.error);
  } catch (failure) {
    if (failure instanceof RefusedField) return error("invalid_request");
    throw failure;
  }
}
