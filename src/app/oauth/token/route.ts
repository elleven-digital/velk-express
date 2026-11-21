import { OAUTH_CORS_HEADERS } from "@/lib/oauth/rules";
import { handleTokenRequest, tooManyRequests } from "@/lib/oauth/token-endpoint";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * Token exchange of the AI-app login (see `handleTokenRequest`). Public and
 * sessionless: limited per address, and generously — AI apps call from a
 * few addresses on behalf of many people. Without a known address the limit
 * is shared by every caller.
 */

const PER_MINUTE = 120;

export async function POST(request: Request): Promise<Response> {
  if (!rateLimit(`oauth-token:${clientIp(request.headers)}`, { limit: PER_MINUTE, windowMs: 60_000 })) {
    return tooManyRequests();
  }
  return handleTokenRequest(request);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}
