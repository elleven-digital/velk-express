import "server-only";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS } from "@/lib/oauth/rules";
import { rateLimit } from "@/lib/rate-limit";
import { isRateLimited, mcpBearerGate, principalOf } from "@/lib/mcp/auth";
import { buildServer } from "@/lib/mcp/server";

/**
 * Serving /mcp: the gate checks the token, the request is counted against
 * the connection's limit (in memory, like the login limits), and the MCP
 * library answers — the 2026 revision as JSON, and the 2025 one
 * statelessly, for apps that still speak it.
 *
 * Over the limit the request is still served, flagged: tools answer the
 * limit sentence and the tool list keeps working. A 429 would reach the app
 * as a connection failure; the sentence reaches the person.
 */

const handler = createMcpHandler(
  ({ authInfo }) => {
    if (!authInfo) throw new Error("/mcp served a request without a checked token.");
    return buildServer({ ...principalOf(authInfo), rateLimited: isRateLimited(authInfo) });
  },
  {
    responseMode: "json",
    onerror: (error) => {
      // Name only: the message may carry what the app sent.
      console.error("[mcp] request failed", { error: error.name });
    },
  },
);

const NO_STORE = { "Cache-Control": "no-store" };

function jsonRpcError(status: number, code: number, message: string, id: unknown = null): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE },
  });
}

/**
 * Does the request open a notification subscription (`subscriptions/listen`)?
 * The library would serve it as an SSE stream with keep-alives, holding the
 * server function. The connector has no notifications: method not found.
 */
async function findListenRequest(request: Request): Promise<{ id: unknown } | null> {
  if (request.method !== "POST") return null;
  let body: unknown;
  try {
    body = JSON.parse(await request.clone().text());
  } catch {
    return null;
  }
  for (const m of Array.isArray(body) ? body : [body]) {
    if (typeof m === "object" && m !== null && (m as { method?: unknown }).method === "subscriptions/listen") {
      const id = (m as { id?: unknown }).id;
      return { id: typeof id === "string" || typeof id === "number" ? id : null };
    }
  }
  return null;
}

export async function serveMcp(request: Request, now?: Date): Promise<Response> {
  let auth: AuthInfo | Response;
  try {
    auth = await mcpBearerGate(now)(request);
  } catch (err) {
    // No public address yet, say: the token can't be checked.
    console.error("[mcp] request failed", { error: err instanceof Error ? err.name : typeof err });
    return jsonRpcError(500, -32603, "Internal error");
  }
  if (auth instanceof Response) return auth;

  const listen = await findListenRequest(request);
  if (listen) return jsonRpcError(200, -32601, "Method not found", listen.id);

  try {
    const allowed = rateLimit(`mcp:${auth.clientId}`, { limit: MCP_RATE_LIMIT, windowMs: MCP_RATE_WINDOW_MS });
    const authInfo: AuthInfo = { ...auth, extra: { ...auth.extra, rateLimited: !allowed } };
    return await handler.fetch(request, { authInfo });
  } catch (err) {
    console.error("[mcp] request failed", {
      connectionId: auth.clientId,
      error: err instanceof Error ? err.name : typeof err,
    });
    return jsonRpcError(500, -32603, "Internal error");
  }
}
