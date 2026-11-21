import {
  REGISTRATION_ERRORS,
  REGISTRATION_MAX_BYTES,
  parseRegistration,
  registrationResponse,
} from "@/lib/oauth/registration";
import { readCappedBody } from "@/lib/oauth/read-body";
import { OAUTH_CORS_HEADERS } from "@/lib/oauth/rules";
import { registerClient } from "@/lib/oauth/store";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * Dynamic client registration (RFC 7591): the AI app sends its name and
 * redirect URIs and gets a client_id. Open, sessionless and secretless, as
 * the MCP spec asks; nothing happens until a person clicks Authorize. The
 * per-address limit keeps anyone from filling the table; without a known
 * address it is shared by every caller.
 */

const PER_MINUTE = 10;

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store", ...extra },
  });
}

function refuse(error: string, description: string): Response {
  return json({ error, error_description: description }, 400);
}

export async function POST(request: Request): Promise<Response> {
  if (!rateLimit(`oauth-register:${clientIp(request.headers)}`, { limit: PER_MINUTE, windowMs: 60_000 })) {
    return json({ error: "too_many_requests" }, 429, { "Retry-After": "60" });
  }

  const text = await readCappedBody(request, REGISTRATION_MAX_BYTES);
  if (text === null) return refuse("invalid_client_metadata", REGISTRATION_ERRORS.tooLarge);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse("invalid_client_metadata", REGISTRATION_ERRORS.notJson);
  }

  const parsed = parseRegistration(body);
  if (!parsed.ok) return refuse(parsed.refusal.error, parsed.refusal.description);

  const now = new Date();
  const client = await registerClient(parsed.value, now);
  return json(registrationResponse(client, now), 201);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}
