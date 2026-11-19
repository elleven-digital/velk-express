import { after } from "next/server";
import { handleWebhook } from "@/lib/core/charge-webhooks";

export const dynamic = "force-dynamic";

/**
 * Stripe's webhook. The body is read as raw text, since the signature covers it byte for byte; this
 * route is outside the proxy matcher so nothing touches it first. 501 without keys, 400 for a bad
 * signature, 500 so Stripe retries, 200 otherwise.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const { status } = await handleWebhook("stripe", { rawBody, headers: request.headers, url: new URL(request.url) }, { defer: after });
  return Response.json({ received: status === 200 }, { status, headers: { "Cache-Control": "no-store" } });
}
