import { createHmac, randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import { agency, charges, paymentEvents, type Db } from "@/lib/db";
import type { WebhookRequest } from "@/lib/payments";
import { createMercadoPagoProvider } from "@/lib/payments/mercadopago";
import { createStripeProvider } from "@/lib/payments/stripe";
import { newPayToken } from "./charges";
import { handleWebhook } from "./charge-webhooks";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

// Test-only secrets: the bodies are signed here, and no provider is ever called.
const STRIPE_WEBHOOK_SECRET = "whsec_test_only";
const MP_WEBHOOK_SECRET = "mp-webhook-secret";
const MP_API = "https://api.mercadopago.com";

let db: Db;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db?.$client.end();
});

function missing() {
  return new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    message: "No such object",
    code: "resource_missing",
    statusCode: 404,
  });
}

/** The real Stripe provider over a client whose lookups answer from these tables. */
function stripeWorld() {
  const client = new Stripe("sk_test_x");
  const sessions: Record<string, object> = {};
  const subscriptions: Record<string, object> = {};
  const invoices: Record<string, object> = {};
  const lookup = (table: Record<string, object>) => (async (id: string) => {
    if (!(id in table)) throw missing();
    return table[id];
  }) as never;
  const retrieveSession = vi.spyOn(client.checkout.sessions, "retrieve").mockImplementation(lookup(sessions));
  vi.spyOn(client.subscriptions, "retrieve").mockImplementation(lookup(subscriptions));
  vi.spyOn(client.invoices, "retrieve").mockImplementation(lookup(invoices));
  const cancel = vi.spyOn(client.subscriptions, "cancel").mockResolvedValue({} as never);
  const provider = createStripeProvider({ secretKey: "sk_test_x", webhookSecret: STRIPE_WEBHOOK_SECRET }, client);
  return { client, provider, sessions, subscriptions, invoices, retrieveSession, cancel };
}

/** A Stripe delivery: the event as JSON, signed with the webhook secret. */
function stripeDelivery(id: string, type: string, objectId: string, secret = STRIPE_WEBHOOK_SECRET): WebhookRequest {
  const rawBody = JSON.stringify({ id, object: "event", type, data: { object: { id: objectId } } });
  const header = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload: rawBody, secret });
  return { rawBody, headers: new Headers({ "stripe-signature": header }), url: new URL("https://painel.acme.com/api/webhooks/stripe") };
}

function session(chargeId: string, over: Record<string, unknown> = {}) {
  return {
    mode: "payment",
    payment_status: "paid",
    client_reference_id: chargeId,
    metadata: { chargeId },
    payment_intent: "pi_1",
    subscription: null,
    ...over,
  };
}

/** The real Mercado Pago provider over a fetch answering from a route table (404 otherwise). */
function mercadoPagoWorld() {
  const routes: Record<string, unknown> = {};
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(url).replace(MP_API, "")}`;
    calls.push(key);
    if (!(key in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const provider = createMercadoPagoProvider({ accessToken: "TEST-token", webhookSecret: MP_WEBHOOK_SECRET }, { fetch });
  return { provider, routes, calls };
}

/** A Mercado Pago delivery, signed over the documented manifest. */
function mpDelivery(type: string, dataId: string, bodyId: number, secret = MP_WEBHOOK_SECRET): WebhookRequest {
  const ts = "1704908010";
  const requestId = `req-${bodyId}`;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac("sha256", secret).update(manifest).digest("hex");
  return {
    rawBody: JSON.stringify({ id: bodyId, type, action: `${type}.updated`, data: { id: dataId } }),
    headers: new Headers({ "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId }),
    url: new URL(`https://painel.acme.com/api/webhooks/mercadopago?data.id=${dataId}&type=${type}`),
  };
}

async function makeCharge(values: Partial<typeof charges.$inferInsert> = {}) {
  const [row] = await db
    .insert(charges)
    .values({
      source: "none",
      kind: "one_time",
      provider: "stripe",
      label: "Hosting",
      amountCents: 100_00,
      currency: "BRL",
      payToken: newPayToken(),
      ...values,
    })
    .returning();
  return row;
}

const row = async (id: string) => (await db.select().from(charges).where(eq(charges.id, id)))[0];
const eventCount = async () => (await db.select().from(paymentEvents)).length;

describe("handleWebhook", () => {
  it("a replayed event changes nothing", async () => {
    const w = stripeWorld();
    const c = await makeCharge();
    w.sessions.cs_1 = session(c.id);
    const delivery = stripeDelivery("evt_1", "checkout.session.completed", "cs_1");
    expect(await handleWebhook("stripe", delivery, { db, providers: [w.provider] })).toEqual({ status: 200 });
    expect((await row(c.id)).status).toBe("paid");

    // Put the charge back by hand: if the replay were applied, it would be paid again.
    await db.update(charges).set({ status: "pending", paidAt: null }).where(eq(charges.id, c.id));
    expect(await handleWebhook("stripe", delivery, { db, providers: [w.provider] })).toEqual({ status: 200 });
    expect((await row(c.id)).status).toBe("pending");
    expect(await eventCount()).toBe(1);

    // The same for Mercado Pago: the notification's own id is the key.
    const mp = mercadoPagoWorld();
    const m = await makeCharge({ provider: "mercadopago" });
    mp.routes["GET /v1/payments/1"] = { id: 1, status: "approved", external_reference: m.id };
    const notice = mpDelivery("payment", "1", 900);
    expect(await handleWebhook("mercadopago", notice, { db, providers: [mp.provider] })).toEqual({ status: 200 });
    await db.update(charges).set({ status: "pending", paidAt: null }).where(eq(charges.id, m.id));
    expect(await handleWebhook("mercadopago", notice, { db, providers: [mp.provider] })).toEqual({ status: 200 });
    expect((await row(m.id)).status).toBe("pending");
    expect(await eventCount()).toBe(2);
  });

  it("a bad signature is refused", async () => {
    const w = stripeWorld();
    const mp = mercadoPagoWorld();
    const c = await makeCharge();
    w.sessions.cs_1 = session(c.id);
    const deps = { db, providers: [w.provider, mp.provider] };

    expect(await handleWebhook("stripe", stripeDelivery("evt_1", "checkout.session.completed", "cs_1", "whsec_other"), deps)).toEqual({ status: 400 });
    const good = stripeDelivery("evt_1", "checkout.session.completed", "cs_1");
    expect(await handleWebhook("stripe", { ...good, rawBody: good.rawBody.replace("evt_1", "evt_2") }, deps)).toEqual({ status: 400 });
    expect(await handleWebhook("stripe", { ...good, headers: new Headers() }, deps)).toEqual({ status: 400 });
    expect(await handleWebhook("mercadopago", mpDelivery("payment", "1", 900, "other-secret"), deps)).toEqual({ status: 400 });

    expect(w.retrieveSession).not.toHaveBeenCalled();
    expect(mp.calls).toEqual([]);
    expect((await row(c.id)).status).toBe("pending");
    expect(await eventCount()).toBe(0);
  });

  it("an unpaid completed session stays pending", async () => {
    const w = stripeWorld();
    const c = await makeCharge();
    // A boleto was issued: the session completed, nothing was paid yet.
    w.sessions.cs_1 = session(c.id, { payment_status: "unpaid" });
    expect(await handleWebhook("stripe", stripeDelivery("evt_1", "checkout.session.completed", "cs_1"), { db, providers: [w.provider] })).toEqual({
      status: 200,
    });
    const after = await row(c.id);
    expect(after.status).toBe("pending");
    expect(after.paidAt).toBeNull();
  });

  it("async boleto success marks paid", async () => {
    const w = stripeWorld();
    const c = await makeCharge();
    const deps = { db, providers: [w.provider] };
    w.sessions.cs_1 = session(c.id, { payment_status: "unpaid" });
    expect(await handleWebhook("stripe", stripeDelivery("evt_1", "checkout.session.completed", "cs_1"), deps)).toEqual({ status: 200 });
    expect((await row(c.id)).status).toBe("pending");

    w.sessions.cs_1 = session(c.id, { payment_status: "paid", payment_intent: "pi_boleto" });
    expect(await handleWebhook("stripe", stripeDelivery("evt_2", "checkout.session.async_payment_succeeded", "cs_1"), deps)).toEqual({ status: 200 });
    const after = await row(c.id);
    expect(after.status).toBe("paid");
    expect(after.paidAt).toBeInstanceOf(Date);
    expect(after.externalPaymentId).toBe("pi_boleto");
  });

  it("a payment after cancel marks a one-time charge paid", async () => {
    const w = stripeWorld();
    const c = await makeCharge({ status: "canceled", canceledAt: new Date() });
    w.sessions.cs_1 = session(c.id);
    expect(await handleWebhook("stripe", stripeDelivery("evt_1", "checkout.session.completed", "cs_1"), { db, providers: [w.provider] })).toEqual({
      status: 200,
    });
    const after = await row(c.id);
    expect(after.status).toBe("paid");
    expect(after.canceledAt).toBeNull();
    expect(after.paidAt).toBeInstanceOf(Date);
  });

  it("subscription events out of order end in the right state", async () => {
    const w = stripeWorld();
    const c = await makeCharge({ kind: "subscription" });
    const deps = { db, providers: [w.provider] };
    const deliver = (id: string, type: string, objectId: string) => handleWebhook("stripe", stripeDelivery(id, type, objectId), deps);
    w.sessions.cs_1 = session(c.id, { mode: "subscription", payment_intent: null, subscription: "sub_A" });
    w.invoices.in_1 = { id: "in_1", parent: { subscription_details: { subscription: "sub_A", metadata: { chargeId: c.id } } } };

    // The first renewal failed and the card was then updated: sub_A is active again. The events
    // arrive late and shuffled; each one reads sub_A's current state.
    w.subscriptions.sub_A = { id: "sub_A", status: "active", metadata: { chargeId: c.id } };
    expect(await deliver("evt_3", "customer.subscription.updated", "sub_A")).toEqual({ status: 200 });
    expect((await row(c.id)).status).toBe("active");
    expect(await deliver("evt_1", "checkout.session.completed", "cs_1")).toEqual({ status: 200 });
    expect(await deliver("evt_2", "invoice.payment_failed", "in_1")).toEqual({ status: 200 });
    let after = await row(c.id);
    expect(after.status).toBe("active");
    expect(after.externalSubscriptionId).toBe("sub_A");

    // Then the client cancels; the deletion arrives before a stale update and a stale invoice.
    w.subscriptions.sub_A = { id: "sub_A", status: "canceled", metadata: { chargeId: c.id } };
    expect(await deliver("evt_6", "customer.subscription.deleted", "sub_A")).toEqual({ status: 200 });
    expect(await deliver("evt_4", "customer.subscription.updated", "sub_A")).toEqual({ status: 200 });
    expect(await deliver("evt_5", "invoice.paid", "in_1")).toEqual({ status: 200 });
    after = await row(c.id);
    expect(after.status).toBe("canceled");
    // Nothing still bills the client, so nothing is canceled at the provider.
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it("mercado pago approved payment marks paid; pending keeps pending", async () => {
    const mp = mercadoPagoWorld();
    const approved = await makeCharge({ provider: "mercadopago" });
    const waiting = await makeCharge({ provider: "mercadopago" });
    mp.routes["GET /v1/payments/1"] = { id: 1, status: "approved", external_reference: approved.id };
    // A Pix or boleto still waiting.
    mp.routes["GET /v1/payments/2"] = { id: 2, status: "pending", external_reference: waiting.id, payment_type_id: "ticket" };
    const deps = { db, providers: [mp.provider] };

    expect(await handleWebhook("mercadopago", mpDelivery("payment", "1", 901), deps)).toEqual({ status: 200 });
    expect(await handleWebhook("mercadopago", mpDelivery("payment", "2", 902), deps)).toEqual({ status: 200 });
    const paid = await row(approved.id);
    expect(paid.status).toBe("paid");
    expect(paid.externalPaymentId).toBe("1");
    expect((await row(waiting.id)).status).toBe("pending");
  });

  it("mercado pago preapproval authorized activates; cancelled cancels", async () => {
    const mp = mercadoPagoWorld();
    const c = await makeCharge({ provider: "mercadopago", kind: "subscription" });
    const deps = { db, providers: [mp.provider] };

    mp.routes["GET /preapproval/pre-1"] = { id: "pre-1", status: "authorized", external_reference: c.id };
    expect(await handleWebhook("mercadopago", mpDelivery("subscription_preapproval", "pre-1", 903), deps)).toEqual({ status: 200 });
    let after = await row(c.id);
    expect(after.status).toBe("active");
    expect(after.externalSubscriptionId).toBe("pre-1");

    mp.routes["GET /preapproval/pre-1"] = { id: "pre-1", status: "cancelled", external_reference: c.id };
    expect(await handleWebhook("mercadopago", mpDelivery("subscription_preapproval", "pre-1", 904), deps)).toEqual({ status: 200 });
    after = await row(c.id);
    expect(after.status).toBe("canceled");
    expect(after.canceledAt).toBeInstanceOf(Date);
  });

  it("an unknown charge is ignored with 200", async () => {
    const w = stripeWorld();
    const mp = mercadoPagoWorld();
    const c = await makeCharge();
    const deps = { db, providers: [w.provider, mp.provider] };
    // A charge id that is not ours, a foreign reference, and a session that does not exist here.
    w.sessions.cs_unknown = session(randomUUID());
    w.sessions.cs_foreign = session("order-123");
    mp.routes["GET /v1/payments/5"] = { id: 5, status: "approved", external_reference: randomUUID() };

    expect(await handleWebhook("stripe", stripeDelivery("evt_1", "checkout.session.completed", "cs_unknown"), deps)).toEqual({ status: 200 });
    expect(await handleWebhook("stripe", stripeDelivery("evt_2", "checkout.session.completed", "cs_foreign"), deps)).toEqual({ status: 200 });
    expect(await handleWebhook("stripe", stripeDelivery("evt_3", "checkout.session.completed", "cs_missing"), deps)).toEqual({ status: 200 });
    expect(await handleWebhook("mercadopago", mpDelivery("payment", "5", 905), deps)).toEqual({ status: 200 });
    expect(await handleWebhook("mercadopago", mpDelivery("payment", "404", 906), deps)).toEqual({ status: 200 });

    const untouched = await row(c.id);
    expect(untouched.status).toBe("pending");
    expect(untouched.updatedAt).toEqual(c.updatedAt);
  });

  it("no keys answer 501", async () => {
    const w = stripeWorld();
    expect(await handleWebhook("stripe", stripeDelivery("evt_1", "checkout.session.completed", "cs_1"), { db, providers: [] })).toEqual({ status: 501 });
    expect(await handleWebhook("mercadopago", mpDelivery("payment", "1", 900), { db, providers: [w.provider] })).toEqual({ status: 501 });
    expect(await eventCount()).toBe(0);
  });

  it("a database or provider failure answers 500 and the retry is processed", async () => {
    const w = stripeWorld();
    const c = await makeCharge();
    w.sessions.cs_1 = session(c.id);
    const deps = { db, providers: [w.provider] };
    const delivery = stripeDelivery("evt_1", "checkout.session.completed", "cs_1");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // The database fails mid-way: the event row rolls back with the effect.
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "08006" }));
    expect(await handleWebhook("stripe", delivery, deps)).toEqual({ status: 500 });
    transaction.mockRestore();
    expect(await eventCount()).toBe(0);
    expect((await row(c.id)).status).toBe("pending");

    // The provider lookup fails: Stripe will retry.
    w.retrieveSession.mockRejectedValueOnce(new Stripe.errors.StripeAPIError({ type: "api_error", message: "Server error", statusCode: 500 }));
    expect(await handleWebhook("stripe", delivery, deps)).toEqual({ status: 500 });
    expect(await eventCount()).toBe(0);

    // Logs carry the error's class and code only, never the body or the headers.
    const text = JSON.stringify(logged.mock.calls);
    expect(text).toContain("Error, code 08006");
    expect(text).toContain("StripeAPIError, status 500");
    expect(text).not.toContain("connection reset");
    expect(text).not.toContain("cs_1");
    expect(text).not.toContain(delivery.headers.get("stripe-signature")!);

    expect(await handleWebhook("stripe", delivery, deps)).toEqual({ status: 200 });
    expect((await row(c.id)).status).toBe("paid");
    expect(await eventCount()).toBe(1);
  });

  it("a subscription still billing for a canceled charge is canceled at the provider after the commit", async () => {
    const w = stripeWorld();
    const c = await makeCharge({ kind: "subscription", status: "canceled", canceledAt: new Date(), externalSubscriptionId: "sub_A" });
    // The checkout completed just before staff canceled: sub_A is alive at Stripe.
    w.sessions.cs_1 = session(c.id, { mode: "subscription", payment_intent: null, subscription: "sub_A" });
    w.subscriptions.sub_A = { id: "sub_A", status: "active", metadata: { chargeId: c.id } };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let committed = -1;
    w.cancel.mockImplementation((async () => {
      committed = await eventCount();
      throw new Stripe.errors.StripeAPIError({ type: "api_error", message: "Server error", statusCode: 500 });
    }) as never);

    expect(await handleWebhook("stripe", stripeDelivery("evt_1", "checkout.session.completed", "cs_1"), { db, providers: [w.provider] })).toEqual({
      status: 200,
    });
    expect(w.cancel).toHaveBeenCalledWith("sub_A");
    // Canceled only once the event is on record; a failure there is logged, not retried by the provider.
    expect(committed).toBe(1);
    expect((await row(c.id)).status).toBe("canceled");
    expect(JSON.stringify(logged.mock.calls)).toContain("StripeAPIError, status 500");

    // Deferred: the route hands the cancel to after(), so the response does not wait for it.
    const later: (() => Promise<void>)[] = [];
    w.cancel.mockClear();
    expect(
      await handleWebhook("stripe", stripeDelivery("evt_2", "invoice.paid", "in_1"), { db, providers: [w.provider], defer: (work) => later.push(work) }),
    ).toEqual({ status: 200 });
    // in_1 does not exist: nothing to cancel, nothing deferred.
    expect(later).toEqual([]);
    w.invoices.in_1 = { id: "in_1", parent: { subscription_details: { subscription: "sub_A", metadata: { chargeId: c.id } } } };
    expect(
      await handleWebhook("stripe", stripeDelivery("evt_3", "invoice.paid", "in_1"), { db, providers: [w.provider], defer: (work) => later.push(work) }),
    ).toEqual({ status: 200 });
    expect(w.cancel).not.toHaveBeenCalled();
    expect(later).toHaveLength(1);
    await later[0]();
    expect(w.cancel).toHaveBeenCalledWith("sub_A");
  });

  it("an activation for a subscription canceled at the provider never activates the charge", async () => {
    const w = stripeWorld();
    const c = await makeCharge({ kind: "subscription" });
    const deps = { db, providers: [w.provider] };
    w.sessions.cs_1 = session(c.id, { mode: "subscription", payment_intent: null, subscription: "sub_A" });
    w.subscriptions.sub_A = { id: "sub_A", status: "canceled", metadata: { chargeId: c.id } };

    // The cancel is processed first; the pending charge has no subscription yet, so it is ignored.
    expect(await handleWebhook("stripe", stripeDelivery("evt_2", "customer.subscription.deleted", "sub_A"), deps)).toEqual({ status: 200 });
    // Then the late activation: sub_A is really canceled, so the charge must not become active.
    expect(await handleWebhook("stripe", stripeDelivery("evt_1", "checkout.session.completed", "cs_1"), deps)).toEqual({ status: 200 });
    let after = await row(c.id);
    expect(after.status).toBe("pending");
    expect(after.externalSubscriptionId).toBeNull();

    // The same with a Mercado Pago installment of a cancelled preapproval.
    const mp = mercadoPagoWorld();
    const m = await makeCharge({ provider: "mercadopago", kind: "subscription" });
    mp.routes["GET /preapproval/pre-A"] = { id: "pre-A", status: "cancelled", external_reference: m.id };
    mp.routes["GET /v1/payments/7"] = { id: 7, status: "approved", external_reference: m.id, metadata: { preapproval_id: "pre-A" } };
    mp.routes["GET /authorized_payments/8"] = { id: 8, preapproval_id: "pre-A", external_reference: m.id, payment: { id: 9, status: "approved" } };
    const mpDeps = { db, providers: [mp.provider] };
    expect(await handleWebhook("mercadopago", mpDelivery("subscription_preapproval", "pre-A", 910), mpDeps)).toEqual({ status: 200 });
    expect(await handleWebhook("mercadopago", mpDelivery("payment", "7", 911), mpDeps)).toEqual({ status: 200 });
    expect(await handleWebhook("mercadopago", mpDelivery("subscription_authorized_payment", "8", 912), mpDeps)).toEqual({ status: 200 });
    after = await row(m.id);
    expect(after.status).toBe("pending");
    expect(after.externalSubscriptionId).toBeNull();
  });
});
