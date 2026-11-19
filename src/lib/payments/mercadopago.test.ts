import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMercadoPagoProvider } from "./mercadopago";
import type { CheckoutInput } from "./types";

const ACCESS_TOKEN = "TEST-access-token";
const WEBHOOK_SECRET = "mp-webhook-secret";
const API = "https://api.mercadopago.com";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; signal: unknown };

/** A fake fetch answering from a route table; records every call. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({
      url: href,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    });
    const key = `${init?.method ?? "GET"} ${href.replace(API, "")}`;
    if (!(key in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function setup(routes: Record<string, unknown> = {}) {
  const f = fakeFetch(routes);
  const provider = createMercadoPagoProvider({ accessToken: ACCESS_TOKEN, webhookSecret: WEBHOOK_SECRET }, { fetch: f.fetch });
  return { provider, calls: f.calls };
}

function input(over: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    chargeId: "charge-1",
    label: "#12 Fix the header",
    amountCents: 150000,
    currency: "BRL",
    kind: "one_time",
    payerEmail: "ana@example.com",
    successUrl: "https://app.example.com/pay/tok/done?r=ok",
    cancelUrl: "https://app.example.com/pay/tok/done?r=cancel",
    notificationUrl: "https://app.example.com/api/webhooks/mercadopago",
    ...over,
  };
}

function sign(manifest: string, secret = WEBHOOK_SECRET) {
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

/** A notification as Mercado Pago delivers it: data.id and type in the query, the signature in headers. */
function notification(opts: {
  type: string;
  dataId: string;
  bodyId?: number | string;
  requestId?: string | null;
  ts?: string;
  secret?: string;
  v1?: string;
}) {
  const ts = opts.ts ?? "1704908010";
  const requestId = opts.requestId === undefined ? "req-123" : opts.requestId;
  const idPart = /^[a-z0-9]+$/i.test(opts.dataId) ? opts.dataId.toLowerCase() : opts.dataId;
  const manifest = `id:${idPart};${requestId ? `request-id:${requestId};` : ""}ts:${ts};`;
  const v1 = opts.v1 ?? sign(manifest, opts.secret);
  const headers = new Headers({ "x-signature": `ts=${ts},v1=${v1}` });
  if (requestId) headers.set("x-request-id", requestId);
  const body: Record<string, unknown> = { type: opts.type, action: `${opts.type}.updated`, data: { id: opts.dataId } };
  if (opts.bodyId !== undefined) body.id = opts.bodyId;
  return {
    rawBody: JSON.stringify(body),
    headers,
    url: new URL(`https://app.example.com/api/webhooks/mercadopago?data.id=${opts.dataId}&type=${opts.type}`),
  };
}

describe("mercado pago provider", () => {
  it("mercado pago builds a preference with external_reference, notification_url and Pix, boleto and card", async () => {
    const { provider, calls } = setup({
      "POST /checkout/preferences": { id: "pref-1", init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1" },
    });

    expect(await provider.createCheckout(input())).toEqual({
      url: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1",
      checkoutId: "pref-1",
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(`${API}/checkout/preferences`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call.headers["x-idempotency-key"]).toMatch(/^charge-1:/);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toEqual({
      items: [{ id: "charge-1", title: "#12 Fix the header", quantity: 1, unit_price: 1500, currency_id: "BRL" }],
      payer: { email: "ana@example.com" },
      external_reference: "charge-1",
      notification_url: "https://app.example.com/api/webhooks/mercadopago",
      back_urls: {
        success: "https://app.example.com/pay/tok/done?r=ok",
        pending: "https://app.example.com/pay/tok/done?r=ok",
        failure: "https://app.example.com/pay/tok/done?r=cancel",
      },
      auto_return: "approved",
      // Nothing excluded: Pix, boleto and card all show.
      payment_methods: { excluded_payment_types: [], excluded_payment_methods: [] },
    });

    // A new click is a new attempt with its own idempotency key.
    await provider.createCheckout(input({ payerEmail: null, amountCents: 1999 }));
    expect(calls[1].headers["x-idempotency-key"]).not.toBe(call.headers["x-idempotency-key"]);
    expect(calls[1].body).not.toHaveProperty("payer");
    expect((calls[1].body as { items: { unit_price: number }[] }).items[0].unit_price).toBe(19.99);
  });

  it("mercado pago builds a preapproval for a monthly charge with the payer e-mail", async () => {
    const { provider, calls } = setup({
      "POST /preapproval": { id: "pre-1", status: "pending", init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre-1" },
    });

    expect(await provider.createCheckout(input({ kind: "subscription", amountCents: 9990 }))).toEqual({
      url: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre-1",
      checkoutId: "pre:pre-1",
    });
    const [call] = calls;
    expect(call.url).toBe(`${API}/preapproval`);
    expect(call.method).toBe("POST");
    expect(call.headers["x-idempotency-key"]).toMatch(/^charge-1:/);
    expect(call.body).toEqual({
      reason: "#12 Fix the header",
      external_reference: "charge-1",
      payer_email: "ana@example.com",
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: 99.9, currency_id: "BRL" },
      back_url: "https://app.example.com/pay/tok/done?r=ok",
      notification_url: "https://app.example.com/api/webhooks/mercadopago",
      status: "pending",
    });
  });

  it("mercado pago verifies x-signature with the documented manifest", async () => {
    const { provider } = setup({ "GET /v1/payments/123": { id: 123, status: "pending", external_reference: "charge-1" } });

    expect(await provider.parseWebhook(notification({ type: "payment", dataId: "123", bodyId: 9 }))).not.toBe("invalid");
    // Without x-request-id the manifest drops that part.
    expect(await provider.parseWebhook(notification({ type: "payment", dataId: "123", requestId: null }))).not.toBe("invalid");

    expect(await provider.parseWebhook(notification({ type: "payment", dataId: "123", secret: "other" }))).toBe("invalid");
    expect(await provider.parseWebhook(notification({ type: "payment", dataId: "123", v1: "00" }))).toBe("invalid");
    // Signed for one id, delivered for another.
    const moved = notification({ type: "payment", dataId: "123" });
    moved.url.searchParams.set("data.id", "124");
    expect(await provider.parseWebhook(moved)).toBe("invalid");
    // Signed with a request id the delivery does not carry.
    const stripped = notification({ type: "payment", dataId: "123" });
    stripped.headers.delete("x-request-id");
    expect(await provider.parseWebhook(stripped)).toBe("invalid");
    const unsigned = notification({ type: "payment", dataId: "123" });
    unsigned.headers.delete("x-signature");
    expect(await provider.parseWebhook(unsigned)).toBe("invalid");

    // An alphanumeric id is lowercased in the manifest.
    const { provider: p2 } = setup({ "GET /preapproval/ABC123": { id: "ABC123", status: "pending", external_reference: "charge-2" } });
    const upper = notification({ type: "subscription_preapproval", dataId: "ABC123" });
    expect(await p2.parseWebhook(upper)).not.toBe("invalid");
    const wrongCase = notification({ type: "subscription_preapproval", dataId: "ABC123", v1: sign("id:ABC123;request-id:req-123;ts:1704908010;") });
    expect(await p2.parseWebhook(wrongCase)).toBe("invalid");
  });

  it("mercado pago maps payment and preapproval statuses", async () => {
    const { provider, calls } = setup({
      "GET /v1/payments/1": { id: 1, status: "approved", external_reference: "charge-1" },
      "GET /v1/payments/2": { id: 2, status: "pending", external_reference: "charge-1", payment_type_id: "ticket" },
      "GET /v1/payments/3": { id: 3, status: "rejected", external_reference: "charge-1" },
      "GET /v1/payments/4": { id: 4, status: "approved", external_reference: "charge-2", operation_type: "recurring_payment" },
      "GET /preapproval/pa": { id: "pa", status: "authorized", external_reference: "charge-2" },
      "GET /preapproval/pc": { id: "pc", status: "cancelled", external_reference: "charge-2" },
      "GET /preapproval/pd": { id: "pd", status: "canceled", external_reference: "charge-2" },
      "GET /preapproval/pp": { id: "pp", status: "pending", external_reference: "charge-2" },
      "GET /preapproval/pz": { id: "pz", status: "paused", external_reference: "charge-2" },
      "GET /authorized_payments/11": { id: 11, preapproval_id: "pa", external_reference: "charge-2", status: "processed", payment: { id: 41, status: "approved" } },
      "GET /authorized_payments/12": { id: 12, preapproval_id: "pa", status: "recycling", payment: { id: 42, status: "rejected" } },
      "GET /authorized_payments/13": { id: 13, preapproval_id: "pa", status: "scheduled", payment: null },
    });
    const parse = async (type: string, dataId: string, bodyId?: number) =>
      provider.parseWebhook(notification({ type, dataId, bodyId }));

    // The event id is built from signed material only (type, data id, request id, ts), never the body's id.
    expect(await parse("payment", "1", 555)).toEqual([
      { eventId: "payment:1:req-123:1704908010", chargeId: "charge-1", externalPaymentId: "1", effect: "paid" },
    ]);
    expect(calls.at(-1)!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(await parse("payment", "1")).toEqual([
      { eventId: "payment:1:req-123:1704908010", chargeId: "charge-1", externalPaymentId: "1", effect: "paid" },
    ]);
    // Pix or boleto waiting, or a refused card: nothing to do.
    expect((await parse("payment", "2", 1))).toEqual([
      { eventId: "payment:2:req-123:1704908010", chargeId: "charge-1", externalPaymentId: "2", effect: "ignore" },
    ]);
    expect((await parse("payment", "3", 1) as { effect: string }[])[0].effect).toBe("ignore");
    // A subscription installment is not a one-time payment.
    expect((await parse("payment", "4", 1) as { effect: string }[])[0].effect).toBe("active");

    expect(await parse("subscription_preapproval", "pa", 2)).toEqual([
      { eventId: "subscription_preapproval:pa:req-123:1704908010", chargeId: "charge-2", externalSubscriptionId: "pa", effect: "active" },
    ]);
    expect((await parse("subscription_preapproval", "pc", 2) as { effect: string }[])[0].effect).toBe("canceled");
    expect((await parse("subscription_preapproval", "pd", 2) as { effect: string }[])[0].effect).toBe("canceled");
    expect((await parse("subscription_preapproval", "pp", 2) as { effect: string }[])[0].effect).toBe("ignore");
    expect((await parse("subscription_preapproval", "pz", 2) as { effect: string }[])[0].effect).toBe("past_due");

    expect(await parse("subscription_authorized_payment", "11", 3)).toEqual([
      { eventId: "subscription_authorized_payment:11:req-123:1704908010", chargeId: "charge-2", externalSubscriptionId: "pa", externalPaymentId: "41", effect: "active" },
    ]);
    expect(await parse("subscription_authorized_payment", "12", 3)).toEqual([
      { eventId: "subscription_authorized_payment:12:req-123:1704908010", chargeId: null, externalSubscriptionId: "pa", externalPaymentId: "42", effect: "past_due" },
    ]);
    expect((await parse("subscription_authorized_payment", "13", 3) as { effect: string }[])[0].effect).toBe("ignore");

    // Other topics are acknowledged without a lookup.
    const before = calls.length;
    expect(await parse("topic_claims_integration_wh", "77", 4)).toEqual([{ eventId: "topic_claims_integration_wh:77:req-123:1704908010", chargeId: null, effect: "ignore" }]);
    expect(calls.length).toBe(before);
  });

  it("mercado pago keys the event on signed material, not on the unsigned body id", async () => {
    const { provider } = setup({ "GET /v1/payments/1": { id: 1, status: "approved", external_reference: "charge-1" } });
    const first = await provider.parseWebhook(notification({ type: "payment", dataId: "1", bodyId: 111 }));
    const replay = await provider.parseWebhook(notification({ type: "payment", dataId: "1", bodyId: 222 }));
    const noBodyId = await provider.parseWebhook(notification({ type: "payment", dataId: "1" }));
    const keys = [first, replay, noBodyId].map((r) => (r as { eventId: string }[])[0].eventId);
    expect(new Set(keys).size).toBe(1);
    // A different signed request (another ts) is another event.
    const later = await provider.parseWebhook(notification({ type: "payment", dataId: "1", ts: "1704908099" }));
    expect((later as { eventId: string }[])[0].eventId).not.toBe(keys[0]);
  });

  it("mercado pago re-reads the preapproval of an installment", async () => {
    const { provider, calls } = setup({
      "GET /preapproval/pc": { id: "pc", status: "cancelled", external_reference: "charge-2" },
      "GET /preapproval/pa": { id: "pa", status: "authorized", external_reference: "charge-2" },
      "GET /v1/payments/5": { id: 5, status: "approved", external_reference: "charge-2", metadata: { preapproval_id: "pc" } },
      "GET /v1/payments/6": { id: 6, status: "approved", external_reference: "charge-2", metadata: { preapproval_id: "pa" } },
      "GET /v1/payments/7": { id: 7, status: "rejected", external_reference: "charge-2", metadata: { preapproval_id: "pc" } },
      "GET /authorized_payments/21": { id: 21, preapproval_id: "pc", external_reference: "charge-2", payment: { id: 51, status: "approved" } },
      "GET /authorized_payments/22": { id: 22, preapproval_id: "pc", status: "recycling", payment: { id: 52, status: "rejected" } },
      "GET /authorized_payments/23": { id: 23, preapproval_id: "pa", external_reference: "charge-2", payment: { id: 53, status: "approved" } },
    });
    const parse = async (type: string, dataId: string) => provider.parseWebhook(notification({ type, dataId, bodyId: 1 }));

    // Cancelled before the payment was processed: the late payment says canceled, never active.
    expect(await parse("payment", "5")).toEqual([
      { eventId: "payment:5:req-123:1704908010", chargeId: "charge-2", externalSubscriptionId: "pc", externalPaymentId: "5", effect: "canceled" },
    ]);
    expect(calls.map((c) => c.url.replace(API, ""))).toEqual(["/v1/payments/5", "/preapproval/pc"]);
    expect((await parse("payment", "6") as { effect: string }[])[0].effect).toBe("active");
    // Nothing to act on, so no second lookup.
    const before = calls.length;
    expect((await parse("payment", "7") as { effect: string }[])[0].effect).toBe("ignore");
    expect(calls.length).toBe(before + 1);

    expect(await parse("subscription_authorized_payment", "21")).toEqual([
      { eventId: "subscription_authorized_payment:21:req-123:1704908010", chargeId: "charge-2", externalSubscriptionId: "pc", externalPaymentId: "51", effect: "canceled" },
    ]);
    expect((await parse("subscription_authorized_payment", "22") as { effect: string }[])[0].effect).toBe("canceled");
    expect((await parse("subscription_authorized_payment", "23") as { effect: string }[])[0].effect).toBe("active");
  });

  it("mercado pago supports only BRL, and recurring only with an e-mail", async () => {
    const { provider, calls } = setup();
    expect(provider.supports({ currency: "BRL", kind: "one_time", payerEmail: null })).toBe(true);
    expect(provider.supports({ currency: "BRL", kind: "subscription", payerEmail: "ana@example.com" })).toBe(true);
    expect(provider.supports({ currency: "BRL", kind: "subscription", payerEmail: null })).toBe(false);
    expect(provider.supports({ currency: "USD", kind: "one_time", payerEmail: "ana@example.com" })).toBe(false);
    expect(provider.supports({ currency: "EUR", kind: "one_time", payerEmail: null })).toBe(false);

    await expect(provider.createCheckout(input({ currency: "USD" }))).rejects.toThrow();
    await expect(provider.createCheckout(input({ kind: "subscription", payerEmail: null }))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("mercado pago cancels a preapproval and has no checkout to expire", async () => {
    const { provider, calls } = setup({ "PUT /preapproval/pre-1": { id: "pre-1", status: "cancelled" } });
    await provider.cancelSubscription("pre-1");
    expect(calls[0]).toMatchObject({ url: `${API}/preapproval/pre-1`, method: "PUT", body: { status: "canceled" } });
    await provider.expireCheckout("pref-1");
    expect(calls).toHaveLength(1);
  });

  it("mercado pago expires a pending preapproval checkout and leaves an authorized one alone", async () => {
    const pending = setup({
      "GET /preapproval/pre-1": { id: "pre-1", status: "pending" },
      "PUT /preapproval/pre-1": { id: "pre-1", status: "cancelled" },
    });
    await pending.provider.expireCheckout("pre:pre-1");
    expect(pending.calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(pending.calls[1]).toMatchObject({ url: `${API}/preapproval/pre-1`, body: { status: "canceled" } });
    for (const status of ["authorized", "cancelled"]) {
      const other = setup({ "GET /preapproval/pre-2": { id: "pre-2", status } });
      await other.provider.expireCheckout("pre:pre-2");
      expect(other.calls.map((c) => c.method)).toEqual(["GET"]);
    }
  });

  it("mercado pago ignores a notification whose object is not found", async () => {
    // Nothing is routed, so every lookup answers 404 (a simulated or foreign id).
    const { provider, calls } = setup();
    for (const type of ["payment", "subscription_preapproval", "subscription_authorized_payment"]) {
      expect(await provider.parseWebhook(notification({ type, dataId: "999", bodyId: 7 }))).toEqual([
        { eventId: `${type}:999:req-123:1704908010`, chargeId: null, effect: "ignore" },
      ]);
    }
    expect(calls.map((c) => c.url.replace(API, ""))).toEqual(["/v1/payments/999", "/preapproval/999", "/authorized_payments/999"]);

    // Any other failure is thrown, so the route answers 5xx and Mercado Pago retries.
    const failing = createMercadoPagoProvider(
      { accessToken: ACCESS_TOKEN, webhookSecret: WEBHOOK_SECRET },
      { fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch },
    );
    await expect(failing.parseWebhook(notification({ type: "payment", dataId: "999" }))).rejects.toThrow("503");
  });

  it("mercado pago reports an unreadable response without its content", async () => {
    const provider = createMercadoPagoProvider(
      { accessToken: ACCESS_TOKEN, webhookSecret: WEBHOOK_SECRET },
      { fetch: (async () => new Response("<html>payer ana@example.com</html>", { status: 200 })) as unknown as typeof fetch },
    );
    const error = await provider.createCheckout(input()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Mercado Pago POST /checkout/preferences returned an unreadable 200 response");
  });

  it("mercado pago reports a failed request without the token", async () => {
    const { provider } = setup();
    const error = await provider.cancelSubscription("missing").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("404");
    expect((error as Error).message).not.toContain(ACCESS_TOKEN);
  });
});
