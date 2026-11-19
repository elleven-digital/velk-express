import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createStripeProvider } from "./stripe";
import type { CheckoutInput, WebhookEvent } from "./types";

const WEBHOOK_SECRET = "whsec_test_only";

function setup() {
  const client = new Stripe("sk_test_x");
  const provider = createStripeProvider({ secretKey: "sk_test_x", webhookSecret: WEBHOOK_SECRET }, client);
  return { client, provider };
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
    notificationUrl: "https://app.example.com/api/webhooks/stripe",
    ...over,
  };
}

function signed(event: object, secret = WEBHOOK_SECRET) {
  const rawBody = JSON.stringify(event);
  const client = new Stripe("sk_test_x");
  const header = client.webhooks.generateTestHeaderString({ payload: rawBody, secret });
  return {
    rawBody,
    headers: new Headers({ "stripe-signature": header }),
    url: new URL("https://app.example.com/api/webhooks/stripe"),
  };
}

function event(id: string, type: string, object: object) {
  return { id, object: "event", type, data: { object } };
}

describe("stripe provider", () => {
  it("stripe builds a payment session with inline price data and the charge id", async () => {
    const { client, provider } = setup();
    const create = vi
      .spyOn(client.checkout.sessions, "create")
      .mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" } as never);

    expect(await provider.createCheckout(input())).toEqual({
      url: "https://checkout.stripe.com/c/cs_1",
      checkoutId: "cs_1",
    });
    const params = create.mock.calls[0][0]!;
    expect(params).toMatchObject({
      mode: "payment",
      line_items: [
        { quantity: 1, price_data: { currency: "brl", unit_amount: 150000, product_data: { name: "#12 Fix the header" } } },
      ],
      client_reference_id: "charge-1",
      metadata: { chargeId: "charge-1" },
      payment_intent_data: { metadata: { chargeId: "charge-1" } },
      customer_email: "ana@example.com",
      success_url: "https://app.example.com/pay/tok/done?r=ok",
      cancel_url: "https://app.example.com/pay/tok/done?r=cancel",
    });
    // Dynamic payment methods: the agency's Dashboard decides (card, Pix, boleto).
    expect(params).not.toHaveProperty("payment_method_types");
    expect(params).not.toHaveProperty("subscription_data");
    expect(params.line_items![0].price_data).not.toHaveProperty("recurring");
  });

  it("stripe builds a monthly subscription session", async () => {
    const { client, provider } = setup();
    const create = vi
      .spyOn(client.checkout.sessions, "create")
      .mockResolvedValue({ id: "cs_2", url: "https://checkout.stripe.com/c/cs_2" } as never);

    await provider.createCheckout(input({ kind: "subscription", currency: "USD", amountCents: 9900, payerEmail: null }));
    const params = create.mock.calls[0][0]!;
    expect(params).toMatchObject({
      mode: "subscription",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 9900,
            recurring: { interval: "month" },
            product_data: { name: "#12 Fix the header" },
          },
        },
      ],
      client_reference_id: "charge-1",
      metadata: { chargeId: "charge-1" },
      subscription_data: { metadata: { chargeId: "charge-1" } },
    });
    expect(params).not.toHaveProperty("payment_intent_data");
    expect(params).not.toHaveProperty("customer_email");
    expect(params).not.toHaveProperty("payment_method_types");
  });

  it("stripe maps completed, async and subscription events, ignoring unpaid completions", async () => {
    const { client, provider } = setup();
    const sessions: Record<string, object> = {
      cs_paid: {
        id: "cs_paid",
        mode: "payment",
        payment_status: "paid",
        client_reference_id: "charge-1",
        metadata: { chargeId: "charge-1" },
        payment_intent: "pi_1",
        subscription: null,
      },
      // Boleto issued, not paid yet.
      cs_unpaid: {
        id: "cs_unpaid",
        mode: "payment",
        payment_status: "unpaid",
        client_reference_id: "charge-1",
        metadata: { chargeId: "charge-1" },
        payment_intent: "pi_2",
        subscription: null,
      },
      cs_sub: {
        id: "cs_sub",
        mode: "subscription",
        payment_status: "paid",
        client_reference_id: null,
        metadata: { chargeId: "charge-2" },
        payment_intent: null,
        subscription: { id: "sub_1" },
      },
    };
    const subscriptions: Record<string, object> = {
      sub_1: { id: "sub_1", status: "active", metadata: { chargeId: "charge-2" } },
      sub_active: { id: "sub_active", status: "active", metadata: { chargeId: "charge-2" } },
      sub_trialing: { id: "sub_trialing", status: "trialing", metadata: { chargeId: "charge-2" } },
      sub_past_due: { id: "sub_past_due", status: "past_due", metadata: { chargeId: "charge-2" } },
      sub_unpaid: { id: "sub_unpaid", status: "unpaid", metadata: {} },
      sub_canceled: { id: "sub_canceled", status: "canceled", metadata: { chargeId: "charge-2" } },
      sub_expired: { id: "sub_expired", status: "incomplete_expired", metadata: { chargeId: "charge-2" } },
      sub_incomplete: { id: "sub_incomplete", status: "incomplete", metadata: { chargeId: "charge-2" } },
    };
    const invoices: Record<string, object> = {
      in_sub: {
        id: "in_sub",
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_active", metadata: { chargeId: "charge-2" } } },
      },
      in_failed: {
        id: "in_failed",
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_unpaid", metadata: { chargeId: "charge-3" } } },
      },
      in_one_off: { id: "in_one_off", parent: null },
    };
    vi.spyOn(client.checkout.sessions, "retrieve").mockImplementation((async (id: string) => sessions[id]) as never);
    vi.spyOn(client.subscriptions, "retrieve").mockImplementation((async (id: string) => subscriptions[id]) as never);
    vi.spyOn(client.invoices, "retrieve").mockImplementation((async (id: string) => invoices[id]) as never);

    const parse = (type: string, object: object, id = "evt_1") => provider.parseWebhook(signed(event(id, type, object)));

    expect(await parse("checkout.session.completed", { id: "cs_paid" })).toEqual([
      { eventId: "evt_1", chargeId: "charge-1", externalPaymentId: "pi_1", effect: "paid" },
    ]);
    // The body says paid, the fetched session does not: the fetched one wins.
    expect(await parse("checkout.session.completed", { id: "cs_unpaid", payment_status: "paid" })).toEqual([
      { eventId: "evt_1", chargeId: "charge-1", effect: "ignore" },
    ]);
    sessions.cs_unpaid = { ...sessions.cs_unpaid, payment_status: "paid" };
    expect(await parse("checkout.session.async_payment_succeeded", { id: "cs_unpaid" }, "evt_2")).toEqual([
      { eventId: "evt_2", chargeId: "charge-1", externalPaymentId: "pi_2", effect: "paid" },
    ]);
    expect(await parse("checkout.session.async_payment_failed", { id: "cs_unpaid" })).toEqual([
      { eventId: "evt_1", chargeId: null, effect: "ignore" },
    ]);
    expect(await parse("checkout.session.completed", { id: "cs_sub" })).toEqual([
      { eventId: "evt_1", chargeId: "charge-2", externalSubscriptionId: "sub_1", effect: "active" },
    ]);

    const sub = async (type: string, id: string) =>
      ((await parse(type, { id, object: "subscription" })) as WebhookEvent[])[0];
    expect(await sub("customer.subscription.updated", "sub_active")).toEqual({
      eventId: "evt_1",
      chargeId: "charge-2",
      externalSubscriptionId: "sub_active",
      effect: "active",
    });
    expect((await sub("customer.subscription.updated", "sub_trialing")).effect).toBe("active");
    expect((await sub("customer.subscription.updated", "sub_past_due")).effect).toBe("past_due");
    expect(await sub("customer.subscription.updated", "sub_unpaid")).toEqual({
      eventId: "evt_1",
      chargeId: null,
      externalSubscriptionId: "sub_unpaid",
      effect: "past_due",
    });
    expect((await sub("customer.subscription.updated", "sub_canceled")).effect).toBe("canceled");
    // The first payment never went through: the charge stays pending for another try.
    expect((await sub("customer.subscription.updated", "sub_expired")).effect).toBe("ignore");
    expect((await sub("customer.subscription.updated", "sub_incomplete")).effect).toBe("ignore");
    expect((await sub("customer.subscription.deleted", "sub_canceled")).effect).toBe("canceled");

    expect(await parse("invoice.paid", { id: "in_sub" })).toEqual([
      { eventId: "evt_1", chargeId: "charge-2", externalSubscriptionId: "sub_active", effect: "active" },
    ]);
    expect(await parse("invoice.payment_failed", { id: "in_failed" })).toEqual([
      // The subscription has no charge id; the invoice's snapshot of its metadata does.
      { eventId: "evt_1", chargeId: "charge-3", externalSubscriptionId: "sub_unpaid", effect: "past_due" },
    ]);
    expect(await parse("invoice.paid", { id: "in_one_off" })).toEqual([
      { eventId: "evt_1", chargeId: null, effect: "ignore" },
    ]);
    expect(await parse("charge.succeeded", { id: "ch_1" })).toEqual([
      { eventId: "evt_1", chargeId: null, effect: "ignore" },
    ]);
  });

  it("stripe re-reads the subscription of a completed subscription session", async () => {
    const { client, provider } = setup();
    const sessions: Record<string, object> = {
      cs_sub: {
        id: "cs_sub",
        mode: "subscription",
        payment_status: "paid",
        client_reference_id: "charge-2",
        metadata: { chargeId: "charge-2" },
        payment_intent: null,
        subscription: "sub_1",
      },
    };
    const subscriptions: Record<string, { id: string; status: string; metadata: object }> = {
      sub_1: { id: "sub_1", status: "canceled", metadata: { chargeId: "charge-2" } },
    };
    vi.spyOn(client.checkout.sessions, "retrieve").mockImplementation((async (id: string) => sessions[id]) as never);
    const retrieve = vi.spyOn(client.subscriptions, "retrieve").mockImplementation((async (id: string) => subscriptions[id]) as never);
    const parse = (type: string) => provider.parseWebhook(signed(event("evt_1", type, { id: "cs_sub" })));

    // Canceled before the activation was processed: the late activation says canceled, never active.
    for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
      expect(await parse(type)).toEqual([{ eventId: "evt_1", chargeId: "charge-2", externalSubscriptionId: "sub_1", effect: "canceled" }]);
    }
    expect(retrieve).toHaveBeenCalledWith("sub_1");
    subscriptions.sub_1.status = "past_due";
    expect(((await parse("checkout.session.completed")) as WebhookEvent[])[0].effect).toBe("past_due");
    // The first payment has not gone through: nothing yet.
    subscriptions.sub_1.status = "incomplete";
    expect(((await parse("checkout.session.completed")) as WebhookEvent[])[0].effect).toBe("ignore");
    subscriptions.sub_1.status = "active";
    expect(((await parse("checkout.session.completed")) as WebhookEvent[])[0].effect).toBe("active");
  });

  it("stripe refuses a bad signature", async () => {
    const { client, provider } = setup();
    const retrieve = vi.spyOn(client.checkout.sessions, "retrieve");
    const good = signed(event("evt_1", "checkout.session.completed", { id: "cs_1" }));

    expect(await provider.parseWebhook(signed(event("evt_1", "checkout.session.completed", { id: "cs_1" }), "whsec_other"))).toBe(
      "invalid",
    );
    expect(await provider.parseWebhook({ ...good, rawBody: good.rawBody.replace("cs_1", "cs_2") })).toBe("invalid");
    expect(await provider.parseWebhook({ ...good, headers: new Headers() })).toBe("invalid");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("stripe ignores an event whose object is not found", async () => {
    const { client, provider } = setup();
    const missing = () =>
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "No such object",
        code: "resource_missing",
        statusCode: 404,
      });
    vi.spyOn(client.checkout.sessions, "retrieve").mockRejectedValue(missing());
    vi.spyOn(client.subscriptions, "retrieve").mockRejectedValue(missing());
    vi.spyOn(client.invoices, "retrieve").mockRejectedValue(missing());

    for (const type of ["checkout.session.completed", "customer.subscription.updated", "invoice.paid"]) {
      expect(await provider.parseWebhook(signed(event("evt_9", type, { id: "x_missing" })))).toEqual([
        { eventId: "evt_9", chargeId: null, effect: "ignore" },
      ]);
    }

    // Any other failure is thrown, so the route answers 5xx and Stripe retries.
    vi.spyOn(client.checkout.sessions, "retrieve").mockRejectedValue(
      new Stripe.errors.StripeAPIError({ type: "api_error", message: "Server error", statusCode: 500 }),
    );
    await expect(provider.parseWebhook(signed(event("evt_9", "checkout.session.completed", { id: "cs_1" })))).rejects.toThrow();
  });

  it("stripe cancels a subscription and expires only an open session", async () => {
    const { client, provider } = setup();
    const cancel = vi.spyOn(client.subscriptions, "cancel").mockResolvedValue({} as never);
    const retrieve = vi.spyOn(client.checkout.sessions, "retrieve");
    const expire = vi.spyOn(client.checkout.sessions, "expire").mockResolvedValue({} as never);

    await provider.cancelSubscription("sub_1");
    expect(cancel).toHaveBeenCalledWith("sub_1");

    retrieve.mockResolvedValueOnce({ id: "cs_open", status: "open" } as never);
    await provider.expireCheckout("cs_open");
    expect(expire).toHaveBeenCalledWith("cs_open");

    retrieve.mockResolvedValueOnce({ id: "cs_done", status: "complete" } as never);
    await provider.expireCheckout("cs_done");
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("stripe serves every currency and kind", () => {
    const { provider } = setup();
    for (const currency of ["BRL", "USD", "EUR"] as const) {
      expect(provider.supports({ currency, kind: "one_time", payerEmail: null })).toBe(true);
      expect(provider.supports({ currency, kind: "subscription", payerEmail: null })).toBe(true);
    }
  });
});
