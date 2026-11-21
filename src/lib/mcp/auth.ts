import "server-only";
import {
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { protectedResourceMetadataUrl } from "@/lib/oauth/metadata";
import { OAUTH_SCOPE, mcpResourceUrl } from "@/lib/oauth/rules";
import { verifyAccessToken } from "@/lib/oauth/store";

/**
 * The /mcp door: the AI app's access token, checked against the OAuth store,
 * becomes the `AuthInfo` the MCP library passes on. The library builds the
 * standard 401 (with `WWW-Authenticate` pointing at the resource metadata);
 * Velk Express says whether the token is valid.
 *
 * In `AuthInfo`, `clientId` is the connection (what the person revokes) and
 * `extra` carries the person and the app — tools read from there only.
 */

export type ConnectorPrincipal = {
  userId: string;
  connectionId: string;
  /** The app's public client_id — what goes to the log. */
  clientId: string;
  /** The app's name as it declared it: shown to people, never logged. */
  clientName: string;
};

export function velkTokenVerifier(resource: string, now?: Date): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let access: Awaited<ReturnType<typeof verifyAccessToken>>;
      try {
        access = await verifyAccessToken(token, resource, now);
      } catch (err) {
        // Database down, say: the library answers 500. Only the error's name is logged.
        console.error("[mcp] token check failed", {
          error: err instanceof Error ? err.name : typeof err,
        });
        throw err;
      }
      if (!access) throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
      return {
        token,
        clientId: access.connectionId,
        scopes: [OAUTH_SCOPE],
        expiresAt: Math.floor(access.expiresAt.getTime() / 1000),
        resource: new URL(access.resource),
        extra: {
          userId: access.userId,
          appClientId: access.clientId,
          appName: access.clientName,
          rateLimited: false,
        },
      };
    },
  };
}

/**
 * The gate of one request: the URLs come from the install's public address,
 * read at call time (it can change). A token of a connection granted for
 * another address is refused, by the store and by the library.
 */
export function mcpBearerGate(now?: Date): (request: Request) => Promise<AuthInfo | Response> {
  return async (request) => {
    const resource = await mcpResourceUrl();
    const gate = requireBearerAuth({
      verifier: velkTokenVerifier(resource, now),
      requiredScopes: [OAUTH_SCOPE],
      expectedResource: new URL(resource),
      resourceMetadataUrl: await protectedResourceMetadataUrl(),
    });
    return gate(request);
  };
}

function extraString(authInfo: AuthInfo, key: string): string {
  const value = authInfo.extra?.[key];
  if (typeof value !== "string") throw new Error("Connector AuthInfo without person or app.");
  return value;
}

export function principalOf(authInfo: AuthInfo): ConnectorPrincipal {
  return {
    userId: extraString(authInfo, "userId"),
    connectionId: authInfo.clientId,
    clientId: extraString(authInfo, "appClientId"),
    clientName: extraString(authInfo, "appName"),
  };
}

export function isRateLimited(authInfo: AuthInfo): boolean {
  return authInfo.extra?.rateLimited === true;
}
