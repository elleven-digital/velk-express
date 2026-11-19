import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { CheckoutInput, PaymentProvider, WebhookEffect, WebhookEvent, WebhookRequest } from "./types";

const API = "https://api.mercadopago.com";
const TIMEOUT_MS = 10_000;
// Writes carry an idempotency key, so a failed one is retried with the same key.
const WRITE_RETRIES = 2;
/** Checkout ids of preapprovals start with this; preference ids do not. */
const PREAPPROVAL_PREFIX = "pre:";

export type MercadoPagoKeys = { accessToken: string; webhookSecret: string };
export type MercadoPagoDeps = { fetch?: typeof fetch };

type Json = Record<string, unknown>;

/** A failed call; the message names only the method, the path and the status. */
export class MercadoPagoError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "MercadoPagoError";
  }
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

/** Parses `ts=...,v1=...`; null when either part is missing. */
function parseSignature(header: string | null): { ts: string; v1: string } | null {
  if (!header) return null;
  const parts: Record<string, string> = {};
  for (const piece of header.split(",")) {
    const at = piece.indexOf("=");
    if (at > 0) parts[piece.slice(0, at).trim()] = piece.slice(at + 1).trim();
  }
  return parts.ts && parts.v1 ? { ts: parts.ts, v1: parts.v1 } : null;
}

/**
 * The documented manifest `id:{data.id};request-id:{x-request-id};ts:{ts};`, with data.id from the
 * query string (lowercased when alphanumeric) and the request-id part left out when the header is.
 */
export function signatureManifest(dataId: string, requestId: string | null, ts: string): string {
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  return `id:${id};${requestId ? `request-id:${requestId};` : ""}ts:${ts};`;
}

function verify(req: WebhookRequest, secret: string): { dataId: string; ts: string; requestId: string | null } | null {
  const signature = parseSignature(req.headers.get("x-signature"));
  const dataId = req.url.searchParams.get("data.id");
  if (!signature || !dataId) return null;
  const manifest = signatureManifest(dataId, req.headers.get("x-request-id"), signature.ts);
  const expected = Buffer.from(createHmac("sha256", secret).update(manifest).digest("hex"));
  const given = Buffer.from(signature.v1.toLowerCase());
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { dataId, ts: signature.ts, requestId: req.headers.get("x-request-id") };
}

function preapprovalEffect(status: string | null): WebhookEffect {
  if (status === "authorized") return "active";
  // The docs spell it both ways.
  if (status === "cancelled" || status === "canceled") return "canceled";
  // Paused by the seller or after refused installments: not collecting.
  if (status === "paused") return "past_due";
  return "ignore";
}

/**
 * Mercado Pago over plain fetch: Checkout Pro preferences for one-time charges (Pix, boleto and
 * card, nothing excluded) and preapprovals without a plan for monthly ones. BRL only.
 */
export function createMercadoPagoProvider(keys: MercadoPagoKeys, deps: MercadoPagoDeps = {}): PaymentProvider {
  const fetcher = deps.fetch ?? fetch;

  async function request(method: "GET" | "POST" | "PUT", path: string, body?: Json, idempotencyKey?: string): Promise<Json> {
    const headers: Record<string, string> = { Authorization: `Bearer ${keys.accessToken}`, Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
    const attempts = method === "GET" ? 1 : 1 + WRITE_RETRIES;
    // Never put the token, the body or the response in an error: they may hold keys or e-mails.
    let failure = new MercadoPagoError(`Mercado Pago ${method} ${path} failed`, null);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * 3 ** (attempt - 1)));
      let res: Response;
      try {
        res = await fetcher(`${API}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
      } catch (e) {
        failure = new MercadoPagoError(
          `Mercado Pago ${method} ${path} failed: ${e instanceof Error ? e.name : "network error"}`,
          null,
        );
        continue;
      }
      if (res.ok) {
        try {
          return (obj(await res.json()) ?? {}) as Json;
        } catch {
          // Not retried: a write may have gone through.
          throw new MercadoPagoError(`Mercado Pago ${method} ${path} returned an unreadable ${res.status} response`, res.status);
        }
      }
      failure = new MercadoPagoError(`Mercado Pago ${method} ${path} failed with ${res.status}`, res.status);
      if (res.status < 500 && res.status !== 429) break;
    }
    throw failure;
  }

  async function cancelSubscription(externalId: string): Promise<void> {
    await request("PUT", `/preapproval/${encodeURIComponent(externalId)}`, { status: "canceled" }, `cancel:${externalId}:${randomUUID()}`);
  }

  function supports(c: { currency: string; kind: string; payerEmail: string | null }): boolean {
    // The subscription needs the payer's e-mail up front.
    return c.currency === "BRL" && (c.kind === "one_time" || !!c.payerEmail);
  }

  /**
   * An activation or renewal for a preapproval that is cancelled by now (the cancel was processed
   * first) means canceled: the charge must not become active for a subscription that no longer bills.
   */
  async function settledByPreapproval(preapprovalId: string, effect: WebhookEffect): Promise<WebhookEffect> {
    if (effect === "ignore") return effect;
    const preapproval = await request("GET", `/preapproval/${encodeURIComponent(preapprovalId)}`);
    return preapprovalEffect(str(preapproval.status)) === "canceled" ? "canceled" : effect;
  }

  async function paymentEvent(eventId: string, paymentId: string): Promise<WebhookEvent> {
    const payment = await request("GET", `/v1/payments/${encodeURIComponent(paymentId)}`);
    const chargeId = str(payment.external_reference);
    const externalPaymentId = str(payment.id) ?? paymentId;
    const approved = payment.status === "approved";
    // [INFERRED] An installment of a subscription carries the subscription's reference; it keeps
    // the subscription active and is never a one-time payment.
    const metadata = obj(payment.metadata);
    const preapprovalId = str(metadata?.preapproval_id);
    if (payment.operation_type === "recurring_payment" || preapprovalId) {
      const effect: WebhookEffect = approved ? "active" : "ignore";
      return {
        eventId,
        chargeId,
        ...(preapprovalId ? { externalSubscriptionId: preapprovalId } : {}),
        externalPaymentId,
        effect: preapprovalId ? await settledByPreapproval(preapprovalId, effect) : effect,
      };
    }
    // Pix or boleto waiting, a refused card, a refund: nothing to do here.
    return { eventId, chargeId, externalPaymentId, effect: approved ? "paid" : "ignore" };
  }

  async function preapprovalEvent(eventId: string, preapprovalId: string): Promise<WebhookEvent> {
    const preapproval = await request("GET", `/preapproval/${encodeURIComponent(preapprovalId)}`);
    return {
      eventId,
      chargeId: str(preapproval.external_reference),
      externalSubscriptionId: str(preapproval.id) ?? preapprovalId,
      effect: preapprovalEffect(str(preapproval.status)),
    };
  }

  async function authorizedPaymentEvent(eventId: string, authorizedPaymentId: string): Promise<WebhookEvent> {
    const installment = await request("GET", `/authorized_payments/${encodeURIComponent(authorizedPaymentId)}`);
    const payment = obj(installment.payment);
    const paymentStatus = str(payment?.status);
    const externalSubscriptionId = str(installment.preapproval_id);
    const externalPaymentId = str(payment?.id);
    let effect: WebhookEffect = "ignore";
    if (paymentStatus === "approved") effect = "active";
    // A refused installment is retried ("recycling") before Mercado Pago gives up.
    else if (paymentStatus === "rejected" || installment.status === "recycling") effect = "past_due";
    if (externalSubscriptionId) effect = await settledByPreapproval(externalSubscriptionId, effect);
    return {
      eventId,
      chargeId: str(installment.external_reference),
      ...(externalSubscriptionId ? { externalSubscriptionId } : {}),
      ...(externalPaymentId ? { externalPaymentId } : {}),
      effect,
    };
  }

  return {
    name: "mercadopago",
    supports,

    async createCheckout(i: CheckoutInput) {
      if (!supports(i)) throw new Error("Mercado Pago cannot take this charge.");
      // One key per checkout attempt; retries of that attempt reuse it.
      const idempotencyKey = `${i.chargeId}:${randomUUID()}`;
      const amount = i.amountCents / 100;
      const result =
        i.kind === "subscription"
          ? await request(
              "POST",
              "/preapproval",
              {
                reason: i.label,
                external_reference: i.chargeId,
                payer_email: i.payerEmail,
                auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: amount, currency_id: "BRL" },
                back_url: i.successUrl,
                // Also configure the subscription topics in the Mercado Pago panel: the docs
                // disagree on which of the two delivers subscription notifications.
                notification_url: i.notificationUrl,
                status: "pending",
              },
              idempotencyKey,
            )
          : await request(
              "POST",
              "/checkout/preferences",
              {
                items: [{ id: i.chargeId, title: i.label, quantity: 1, unit_price: amount, currency_id: "BRL" }],
                ...(i.payerEmail ? { payer: { email: i.payerEmail } } : {}),
                external_reference: i.chargeId,
                notification_url: i.notificationUrl,
                back_urls: { success: i.successUrl, pending: i.successUrl, failure: i.cancelUrl },
                auto_return: "approved",
                payment_methods: { excluded_payment_types: [], excluded_payment_methods: [] },
              },
              idempotencyKey,
            );
      const url = str(result.init_point);
      const id = str(result.id);
      if (!url || !id) throw new Error("Mercado Pago returned a checkout without a link.");
      // The id says which kind it is, so expiring knows whether there is a preapproval to close.
      return { url, checkoutId: i.kind === "subscription" ? `${PREAPPROVAL_PREFIX}${id}` : id };
    },

    cancelSubscription,

    async expireCheckout(checkoutId: string) {
      // A preference has no open state to close. A preapproval is canceled only while pending: one the
      // payer already authorized (or that is already canceled) is left alone.
      if (!checkoutId.startsWith(PREAPPROVAL_PREFIX)) return;
      const id = checkoutId.slice(PREAPPROVAL_PREFIX.length);
      const current = await request("GET", `/preapproval/${encodeURIComponent(id)}`);
      if (current.status === "pending") await cancelSubscription(id);
    },

    async parseWebhook(req: WebhookRequest) {
      const verified = verify(req, keys.webhookSecret);
      if (!verified) return "invalid";
      let body: Json = {};
      try {
        body = obj(JSON.parse(req.rawBody)) ?? {};
      } catch {
        // The signature covers the query and headers, not the body; the type also comes in the query.
      }
      // Only data.id, x-request-id and ts are signed. The body (its id included) and the type are not,
      // so the idempotency key is built from the signed parts plus the type: replaying a signed request
      // with another body.id changes nothing. The type only routes which object is fetched, the effect
      // always comes from that object, and a replay under another type is harmless because the
      // transitions are conditional.
      const type = req.url.searchParams.get("type") ?? str(body.type) ?? "";
      const eventId = `${type}:${verified.dataId}:${verified.requestId ?? ""}:${verified.ts}`;
      try {
        switch (type) {
          case "payment":
            return [await paymentEvent(eventId, verified.dataId)];
          case "subscription_preapproval":
          case "preapproval":
            return [await preapprovalEvent(eventId, verified.dataId)];
          case "subscription_authorized_payment":
          case "authorized_payment":
            return [await authorizedPaymentEvent(eventId, verified.dataId)];
          default:
            return [{ eventId, chargeId: null, effect: "ignore" }];
        }
      } catch (e) {
        // A simulated or foreign id will never be found; ignoring it stops endless retries.
        // Other errors propagate so the route answers 5xx and Mercado Pago retries.
        if (e instanceof MercadoPagoError && e.status === 404) return [{ eventId, chargeId: null, effect: "ignore" }];
        throw e;
      }
    },
  };
}
