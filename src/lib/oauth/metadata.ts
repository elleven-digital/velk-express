import { OAUTH_CORS_HEADERS, OAUTH_SCOPE, appUrl, mcpResourceUrl, oauthIssuer } from "@/lib/oauth/rules";

/**
 * The documents an AI app reads to find out how to sign in: protected
 * resource metadata (RFC 9728 — the `/mcp` and who authorizes it) and
 * authorization server metadata (RFC 8414). Every URL comes from the
 * install's public address, read on each request (it can change); before
 * the install there is none and these throw.
 */

export async function protectedResourceMetadata() {
  return {
    resource: await mcpResourceUrl(),
    authorization_servers: [await oauthIssuer()],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Velk Express",
  };
}

export async function authorizationServerMetadata() {
  return {
    issuer: await oauthIssuer(),
    authorization_endpoint: await appUrl("/oauth/authorize"),
    token_endpoint: await appUrl("/oauth/token"),
    registration_endpoint: await appUrl("/oauth/register"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    client_id_metadata_document_supported: true as const,
    authorization_response_iss_parameter_supported: true as const,
  };
}

/** Where the /mcp 401 points to. */
export async function protectedResourceMetadataUrl(): Promise<string> {
  return appUrl("/.well-known/oauth-protected-resource/mcp");
}

/** JSON on GET (and HEAD, without body), CORS preflight on OPTIONS, 405 otherwise. */
export function metadataResponse(request: Request, document: object): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { ...OAUTH_CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" },
    });
  }
  const response = Response.json(document, { headers: OAUTH_CORS_HEADERS });
  return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
}
