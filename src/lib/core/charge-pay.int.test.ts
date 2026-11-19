import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import { agency, charges, clients, quotes, type Db } from "@/lib/db";
import type { PaymentProvider, ProviderName } from "@/lib/payments";
import { newPayToken } from "./charges";
import { getPayDone, startPayment } from "./charge-pay";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";

let db: Db;

type FakeProvider = PaymentProvider & {
  createCheckout: ReturnType<typeof vi.fn>;
  expireCheckout: ReturnType<typeof vi.fn>;
};

/** A provider that never talks to anyone: Stripe takes anything, Mercado Pago BRL only (recurring with an e-mail). */
function fakeProvider(name: ProviderName): FakeProvider {
  let n = 0;
  return {
    name,
    supports: ({ currency, kind, payerEmail }) => name === "stripe" || (currency === "BRL" && (kind === "one_time" || Boolean(payerEmail))),
    createCheckout: vi.fn(async () => {
      n += 1;
      return { url: `https://pay.example/${name}/${n}`, checkoutId: `cs_${name}_${n}` };
    }),
    cancelSubscription: vi.fn(async () => {}),
    expireCheckout: vi.fn(async () => {}),
    parseWebhook: vi.fn(async () => []),
  } as FakeProvider;
}

let stripe: FakeProvider;
let mercadopago: FakeProvider;
let providers: PaymentProvider[];
const deps = () => ({ db, providers });

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  stripe = fakeProvider("stripe");
  mercadopago = fakeProvider("mercadopago");
  providers = [stripe, mercadopago];
});

afterAll(async () => {
  await db?.$client.end();
});

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

describe("startPayment", () => {
  it("pay refuses paid, canceled and active charges", async () => {
    const paid = await makeCharge({ status: "paid", paidAt: new Date() });
    const canceled = await makeCharge({ status: "canceled", canceledAt: new Date() });
    const active = await makeCharge({ kind: "subscription", status: "active" });
    const pastDue = await makeCharge({ kind: "subscription", status: "past_due" });
    expect(await startPayment(paid.payToken, deps())).toEqual({ ok: false, error: "alreadyPaid" });
    expect(await startPayment(canceled.payToken, deps())).toEqual({ ok: false, error: "canceled" });
    expect(await startPayment(active.payToken, deps())).toEqual({ ok: false, error: "alreadyActive" });
    expect(await startPayment(pastDue.payToken, deps())).toEqual({ ok: false, error: "alreadyActive" });
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it("an unknown token is not found", async () => {
    expect(await startPayment("nope", deps())).toEqual({ ok: false, error: "notFound" });
    expect(await startPayment("x".repeat(500), deps())).toEqual({ ok: false, error: "notFound" });
  });

  it("a manual charge has no checkout", async () => {
    const manual = await makeCharge({ provider: null });
    expect(await startPayment(manual.payToken, deps())).toEqual({ ok: false, error: "manual" });
    const paidManual = await makeCharge({ provider: null, status: "paid", paidAt: new Date() });
    expect(await startPayment(paidManual.payToken, deps())).toEqual({ ok: false, error: "alreadyPaid" });
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it("each click creates a fresh checkout and remembers it", async () => {
    const [client] = await db.insert(clients).values({ name: "Acme", email: "fin@acme.com" }).returning();
    const charge = await makeCharge({ clientId: client.id });
    const first = await startPayment(charge.payToken, deps());
    expect(first).toEqual({ ok: true, value: { url: "https://pay.example/stripe/1" } });
    expect((await row(charge.id)).externalCheckoutId).toBe("cs_stripe_1");
    const second = await startPayment(charge.payToken, deps());
    expect(second).toEqual({ ok: true, value: { url: "https://pay.example/stripe/2" } });
    expect((await row(charge.id)).externalCheckoutId).toBe("cs_stripe_2");
    expect(stripe.createCheckout).toHaveBeenLastCalledWith({
      chargeId: charge.id,
      label: "Hosting",
      amountCents: 100_00,
      currency: "BRL",
      kind: "one_time",
      payerEmail: "fin@acme.com",
      successUrl: `https://painel.acme.com/pay/${charge.payToken}/done?r=ok`,
      cancelUrl: `https://painel.acme.com/pay/${charge.payToken}/done?r=cancel`,
      notificationUrl: "https://painel.acme.com/api/webhooks/mercadopago",
    });
  });

  it("the done page data is read-only and unknown tokens find nothing", async () => {
    const charge = await makeCharge({});
    expect(await getPayDone(charge.payToken, { db })).toEqual({ label: "Hosting", amountCents: 100_00, currency: "BRL", status: "pending", kind: "one_time" });
    expect(await getPayDone("nope", { db })).toBeNull();
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it("a quote's charge returns to the public quote page", async () => {
    const [quote] = await db.insert(quotes).values({ title: "Site", token: "tok123", currency: "BRL", prospectName: "Zed", prospectEmail: "zed@x.com" }).returning();
    const charge = await makeCharge({ source: "quote", quoteId: quote.id });
    expect((await startPayment(charge.payToken, deps())).ok).toBe(true);
    expect(stripe.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ payerEmail: "zed@x.com", successUrl: "https://painel.acme.com/q/tok123", cancelUrl: "https://painel.acme.com/q/tok123" }),
    );
  });

  it("mercado pago is offered only for BRL and recurring only with an e-mail", async () => {
    const [withMail] = await db.insert(clients).values({ name: "A", email: "a@x.com" }).returning();
    const [noMail] = await db.insert(clients).values({ name: "B" }).returning();
    const usd = await makeCharge({ provider: "mercadopago", currency: "USD" });
    expect(await startPayment(usd.payToken, deps())).toEqual({ ok: false, error: "providerUnavailable" });
    const recurringNoMail = await makeCharge({ provider: "mercadopago", kind: "subscription", clientId: noMail.id });
    expect(await startPayment(recurringNoMail.payToken, deps())).toEqual({ ok: false, error: "providerUnavailable" });
    expect(mercadopago.createCheckout).not.toHaveBeenCalled();
    const recurring = await makeCharge({ provider: "mercadopago", kind: "subscription", clientId: withMail.id });
    expect((await startPayment(recurring.payToken, deps())).ok).toBe(true);
    const oneTime = await makeCharge({ provider: "mercadopago" });
    expect((await startPayment(oneTime.payToken, deps())).ok).toBe(true);
    expect(mercadopago.createCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ notificationUrl: "https://painel.acme.com/api/webhooks/mercadopago" }));
    // The key was removed since the charge was made.
    const gone = await startPayment(oneTime.payToken, { db, providers: [stripe] });
    expect(gone).toEqual({ ok: false, error: "providerUnavailable" });
  });

  it("a provider failure is providerUnavailable and stores nothing", async () => {
    const charge = await makeCharge();
    stripe.createCheckout.mockRejectedValueOnce(Object.assign(new Error("secret sk_live_x"), { code: "boom" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await startPayment(charge.payToken, deps())).toEqual({ ok: false, error: "providerUnavailable" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk_live_x");
    log.mockRestore();
    expect((await row(charge.id)).externalCheckoutId).toBeNull();
  });

  it("a charge canceled during the provider call keeps no checkout and the new one is expired", async () => {
    const charge = await makeCharge();
    stripe.createCheckout.mockImplementationOnce(async () => {
      await db.update(charges).set({ status: "canceled", canceledAt: new Date() }).where(eq(charges.id, charge.id));
      return { url: "https://pay.example/late", checkoutId: "cs_late" };
    });
    expect(await startPayment(charge.payToken, deps())).toEqual({ ok: false, error: "canceled" });
    expect(stripe.expireCheckout).toHaveBeenCalledWith("cs_late");
    expect((await row(charge.id)).externalCheckoutId).toBeNull();
  });

  it("a new click closes the previous open checkout", async () => {
    const charge = await makeCharge();
    await startPayment(charge.payToken, deps());
    expect(stripe.expireCheckout).not.toHaveBeenCalled();
    await startPayment(charge.payToken, deps());
    expect(stripe.expireCheckout).toHaveBeenCalledTimes(1);
    expect(stripe.expireCheckout).toHaveBeenCalledWith("cs_stripe_1");
    // A failing close is only logged.
    stripe.expireCheckout.mockRejectedValueOnce(Object.assign(new Error("sk_live_y"), { code: "x" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await startPayment(charge.payToken, deps())).ok).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk_live_y");
    log.mockRestore();
    expect((await row(charge.id)).externalCheckoutId).toBe("cs_stripe_3");
  });

  it("a currency outside BRL, USD and EUR is providerUnavailable", async () => {
    const odd = await makeCharge({ currency: "JPY" });
    expect(await startPayment(odd.payToken, deps())).toEqual({ ok: false, error: "providerUnavailable" });
  });
});
