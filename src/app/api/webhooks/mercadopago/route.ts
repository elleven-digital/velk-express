import { after } from "next/server";
import { handleWebhook } from "@/lib/core/charge-webhooks";

export const dynamic = "force-dynamic";

/**
 * Mercado Pago's webhook. The signature covers `data.id` in the query and the request headers; the
 * raw body only names the topic, and the payment or preapproval is read from Mercado Pago's API.
 * This route is outside the proxy matcher, like Stripe's. 501 without keys, 400 for a bad
 * signature, 500 so Mercado Pago retries, 200 otherwise.
 *
 * Mercado Pago gives up after about 22 s: each lookup at its API times out at 10 s, and the
 * cancel of an orphan subscription runs after the response.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const { status } = await handleWebhook("mercadopago", { rawBody, headers: request.headers, url: new URL(request.url) }, { defer: after });
  return Response.json({ received: status === 200 }, { status, headers: { "Cache-Control": "no-store" } });
}
