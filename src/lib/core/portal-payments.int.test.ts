import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestDb } from "@/test/db";
import {
  agency,
  charges,
  clientMemberships,
  clientUsers,
  clients,
  hourPurchases,
  quoteItems,
  quotes,
  tickets,
  type Client,
  type ClientRole,
  type ClientUser,
  type Db,
} from "@/lib/db";
import type { PortalSession } from "@/lib/auth/session";
import { getHoursSummary } from "./hours";
import type { PaymentProvider, ProviderName } from "@/lib/payments";
import { getPortalHome } from "./portal-home";
import { buyHours, countPendingPortalPayments, listPortalPayments } from "./portal-payments";
import { getPortalTicketView } from "./portal-tickets";
import { getPublicQuote } from "./quote-public";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";

let db: Db;
let A: Client;
let B: Client;
let boss: ClientUser;
let helper: ClientUser;

const asPortal = (client: Client, user: ClientUser, role: ClientRole): PortalSession => ({
  userType: "client",
  user,
  client,
  role,
});

function fakeProvider(name: ProviderName): PaymentProvider {
  return {
    name,
    supports: ({ currency, kind, payerEmail }) => name === "stripe" || (currency === "BRL" && (kind === "one_time" || Boolean(payerEmail))),
    createCheckout: vi.fn(async () => ({ url: "https://pay.example/x", checkoutId: "cs_x" })),
    cancelSubscription: vi.fn(async () => {}),
    expireCheckout: vi.fn(async () => {}),
    parseWebhook: vi.fn(async () => []),
  } as PaymentProvider;
}
const both = [fakeProvider("stripe"), fakeProvider("mercadopago")];
const stripeOnly = [fakeProvider("stripe")];

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  [A, B] = await db
    .insert(clients)
    .values([
      { name: "Alpha", supportActive: true, supportMonthlyCents: 150_000, hoursMode: "package", includedMinutes: 600, extraHourCents: 20_000 },
      { name: "Beta" },
    ])
    .returning();
  [boss, helper] = await db
    .insert(clientUsers)
    .values([
      { name: "Boss", email: "boss@x.com", passwordHash: "x" },
      { name: "Helper", email: "helper@x.com", passwordHash: "x", locale: "pt" },
    ])
    .returning();
  await db.insert(clientMemberships).values([
    { clientUserId: boss.id, clientId: A.id, role: "admin" },
    { clientUserId: boss.id, clientId: B.id, role: "collaborator" },
    { clientUserId: helper.id, clientId: A.id, role: "collaborator" },
  ]);
});

afterAll(async () => {
  await db?.$client.end();
});

let n = 0;
async function charge(clientId: string | null, over: Partial<typeof charges.$inferInsert> = {}) {
  n += 1;
  const [row] = await db
    .insert(charges)
    .values({
      clientId,
      source: "none",
      kind: "one_time",
      status: "pending",
      provider: "stripe",
      label: `Charge ${n}`,
      amountCents: 10_000,
      currency: "BRL",
      payToken: `token-${n}-${Math.random().toString(36).slice(2)}`,
      ...over,
    })
    .returning();
  return row;
}

describe("portal payments", () => {
  it("portal payments are admin only and the session company's", async () => {
    const mine = await charge(A.id, { label: "Mine", createdAt: new Date("2026-01-02") });
    const paid = await charge(A.id, { label: "Paid", status: "paid", paidAt: new Date("2026-01-03"), createdAt: new Date("2026-01-03") });
    const manual = await charge(A.id, { label: "Manual", provider: null, createdAt: new Date("2026-01-01") });
    await charge(A.id, { label: "Never paid", status: "canceled" });
    await charge(A.id, { label: "Paid then canceled", status: "canceled", paidAt: new Date("2026-01-04"), createdAt: new Date("2026-01-04") });
    await charge(B.id, { label: "Theirs" });

    const rows = await listPortalPayments(asPortal(A, boss, "admin"), { db });
    if (!rows.ok) throw new Error(rows.error);
    expect(rows.value.map((r) => r.label)).toEqual(["Paid then canceled", "Paid", "Mine", "Manual"]);
    const byLabel = Object.fromEntries(rows.value.map((r) => [r.label, r]));
    expect(byLabel.Mine.payPath).toBe(`/pay/${mine.payToken}`);
    expect(byLabel.Paid.payPath).toBeNull();
    expect(byLabel.Manual.payPath).toBeNull();
    expect(paid.id).toBeTruthy();
    expect(manual.id).toBeTruthy();

    // a collaborator gets nothing, and the count is the admin's pending charges with a provider
    expect(await listPortalPayments(asPortal(A, helper, "collaborator"), { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await countPendingPortalPayments(asPortal(A, helper, "collaborator"), { db })).toBe(0);
    expect(await countPendingPortalPayments(asPortal(A, boss, "admin"), { db })).toBe(1);
    // the same person is only a collaborator in B
    expect(await listPortalPayments(asPortal(B, boss, "collaborator"), { db })).toEqual({ ok: false, error: "forbidden" });
    // a role claimed by the session but not in the database
    expect(await listPortalPayments(asPortal(B, boss, "admin"), { db })).toEqual({ ok: false, error: "forbidden" });

    // the home: tasks, no money for collaborators
    const home = await getPortalHome(asPortal(A, boss, "admin"), db, { providers: both });
    expect(home.payments?.tasks.map((t) => t.label)).toEqual(["Mine"]);
    expect((await getPortalHome(asPortal(A, helper, "collaborator"), db, { providers: both })).payments).toBeNull();
  });

  it("the home offers the monthly setup, the past-due notice and buying hours to admins only", async () => {
    const sub = await charge(A.id, { source: "support", kind: "subscription", label: "Monthly support" });
    const admin = asPortal(A, boss, "admin");
    let home = await getPortalHome(admin, db, { providers: both });
    expect(home.payments?.setupPayPath).toBe(`/pay/${sub.payToken}`);
    expect(home.payments?.pastDue).toBe(false);
    expect(home.payments?.buyHours).toEqual({ unitCents: 20_000, currency: "BRL" });

    await db.update(charges).set({ status: "past_due" }).where(eq(charges.id, sub.id));
    home = await getPortalHome(admin, db, { providers: both });
    expect(home.payments?.setupPayPath).toBeNull();
    expect(home.payments?.pastDue).toBe(true);

    const collab = await getPortalHome(asPortal(A, helper, "collaborator"), db, { providers: both });
    expect(collab.payments).toBeNull();

    // no online provider, no purchase
    home = await getPortalHome(admin, db, { providers: [] });
    expect(home.payments?.buyHours).toBeNull();
  });
});

describe("buyHours", () => {
  const admin = () => asPortal(A, boss, "admin");

  it("buyHours checks the package, the price, the bounds and a BRL provider, and creates a pending purchase with its charge", async () => {
    // bounds
    for (const bad of [0, 101, 1.5, Number.NaN, -2]) {
      expect(await buyHours(admin(), bad, { db, providers: both })).toEqual({ ok: false, error: "invalidHours" });
    }
    // admin only
    expect(await buyHours(asPortal(A, helper, "collaborator"), 2, { db, providers: both })).toEqual({ ok: false, error: "forbidden" });
    // no online provider that takes the currency
    expect(await buyHours(admin(), 2, { db, providers: [] })).toEqual({ ok: false, error: "providerUnavailable" });
    // package and price
    await db.update(clients).set({ extraHourCents: null }).where(eq(clients.id, A.id));
    expect(await buyHours(admin(), 2, { db, providers: both })).toEqual({ ok: false, error: "nothingToCharge" });
    await db.update(clients).set({ extraHourCents: 20_000 }).where(eq(clients.id, A.id));
    await db.update(clients).set({ hoursMode: "internal", includedMinutes: 0, extraHourCents: null }).where(eq(clients.id, A.id));
    expect(await buyHours(admin(), 2, { db, providers: both })).toEqual({ ok: false, error: "nothingToCharge" });
    await db.update(clients).set({ hoursMode: "package", includedMinutes: 600, extraHourCents: 20_000 }).where(eq(clients.id, A.id));
    expect(await db.select().from(hourPurchases)).toHaveLength(0);
    expect(await db.select().from(charges)).toHaveLength(0);

    // the default provider wins when it can take the charge, else the first that can
    await db.update(agency).set({ defaultPaymentProvider: "mercadopago" }).where(eq(agency.id, 1));
    const res = await buyHours(admin(), 3, { db, providers: both });
    if (!res.ok) throw new Error(res.error);
    const [purchase] = await db.select().from(hourPurchases);
    expect(purchase).toMatchObject({ clientId: A.id, minutes: 180, priceCents: 60_000, pending: true, createdById: null });
    const [row] = await db.select().from(charges);
    expect(row).toMatchObject({
      source: "hours",
      kind: "one_time",
      status: "pending",
      provider: "mercadopago",
      clientId: A.id,
      hourPurchaseId: purchase.id,
      amountCents: 60_000,
      currency: "BRL",
      createdById: null,
    });
    expect(row.label).toBe(`Extra hours 3h — ${purchase.cycle}`);
    expect(res.value.payUrl).toBe(`https://painel.acme.com/pay/${row.payToken}`);
    // pending: not in the balance
    const summary = await getHoursSummary(A.id, undefined, { db });
    expect(summary?.purchasedMinutes).toBe(0);

    // the default cannot take it (Stripe only): falls back to the first usable
    await db.update(agency).set({ defaultPaymentProvider: "mercadopago" }).where(eq(agency.id, 1));
    const second = await buyHours(admin(), 1, { db, providers: stripeOnly });
    if (!second.ok) throw new Error(second.error);
    const rows = await db.select().from(charges).where(and(eq(charges.source, "hours"), eq(charges.provider, "stripe")));
    expect(rows).toHaveLength(1);
  });

  it("buying the same hours again reuses the pending purchase instead of stacking charges", async () => {
    const first = await buyHours(admin(), 2, { db, providers: both });
    const again = await buyHours(admin(), 2, { db, providers: both });
    if (!first.ok || !again.ok) throw new Error("buyHours failed");
    expect(again.value.payUrl).toBe(first.value.payUrl);
    expect(await db.select().from(charges)).toHaveLength(1);
    expect(await db.select().from(hourPurchases)).toHaveLength(1);

    // concurrent clicks end in one charge too
    await db.delete(charges);
    await db.delete(hourPurchases);
    const urls = await Promise.all([1, 2, 3].map(() => buyHours(admin(), 2, { db, providers: both })));
    expect(new Set(urls.map((r) => (r.ok ? r.value.payUrl : r.error))).size).toBe(1);
    expect(await db.select().from(charges)).toHaveLength(1);

    // other hours, or a charge that is no longer pending, make a new purchase
    const other = await buyHours(admin(), 3, { db, providers: both });
    if (!other.ok) throw new Error(other.error);
    expect(await db.select().from(charges)).toHaveLength(2);
    await db.update(charges).set({ status: "canceled" });
    const fresh = await buyHours(admin(), 3, { db, providers: both });
    if (!fresh.ok) throw new Error(fresh.error);
    expect(fresh.value.payUrl).not.toBe(other.value.payUrl);
  });

  it("a pending purchase is reused only while the hour price and the agency's currency stay the same", async () => {
    const providers = [fakeProvider("stripe"), fakeProvider("mercadopago")];
    const tokenOf = (res: Awaited<ReturnType<typeof buyHours>>) => {
      if (!res.ok) throw new Error(res.error);
      return res.value.payUrl.split("/pay/")[1];
    };
    const chargeOf = async (token: string) => (await db.select().from(charges).where(eq(charges.payToken, token)))[0];

    // same price: the same charge
    const first = tokenOf(await buyHours(admin(), 2, { db, providers }));
    expect(tokenOf(await buyHours(admin(), 2, { db, providers }))).toBe(first);
    const original = await chargeOf(first);
    await db.update(charges).set({ externalCheckoutId: "cs_old" }).where(eq(charges.id, original.id));

    // the price changed: a new charge at the new price, the old one canceled with its purchase gone
    await db.update(clients).set({ extraHourCents: 25_000 }).where(eq(clients.id, A.id));
    const repriced = tokenOf(await buyHours(admin(), 2, { db, providers }));
    expect(repriced).not.toBe(first);
    expect(await chargeOf(first)).toMatchObject({ status: "canceled", hourPurchaseId: null });
    expect((await chargeOf(first)).canceledAt).not.toBeNull();
    expect(providers[0].expireCheckout).toHaveBeenCalledWith("cs_old");
    const second = await chargeOf(repriced);
    expect(second).toMatchObject({ status: "pending", amountCents: 50_000, currency: "BRL" });
    expect(await db.select().from(hourPurchases)).toEqual([expect.objectContaining({ id: second.hourPurchaseId, priceCents: 50_000, pending: true })]);
    expect(tokenOf(await buyHours(admin(), 2, { db, providers }))).toBe(repriced);

    // the agency's currency changed: idem
    await db.update(agency).set({ currency: "USD" }).where(eq(agency.id, 1));
    const usd = tokenOf(await buyHours(admin(), 2, { db, providers }));
    expect(usd).not.toBe(repriced);
    expect((await chargeOf(repriced)).status).toBe("canceled");
    const third = await chargeOf(usd);
    expect(third).toMatchObject({ status: "pending", amountCents: 50_000, currency: "USD" });
    expect(await db.select().from(hourPurchases)).toEqual([expect.objectContaining({ id: third.hourPurchaseId, pending: true })]);
    expect(await db.select().from(charges).where(eq(charges.status, "pending"))).toHaveLength(1);
  });

  it("a currency the old provider cannot take discards its pending purchase instead of stacking a charge", async () => {
    const providers = [fakeProvider("stripe"), fakeProvider("mercadopago")];
    await db.update(agency).set({ defaultPaymentProvider: "mercadopago" }).where(eq(agency.id, 1));
    const brl = await buyHours(admin(), 2, { db, providers });
    if (!brl.ok) throw new Error(brl.error);
    const [old] = await db.select().from(charges);
    expect(old).toMatchObject({ provider: "mercadopago", currency: "BRL", status: "pending" });

    // Mercado Pago takes BRL only: the USD purchase goes to Stripe and the BRL one is discarded.
    await db.update(agency).set({ currency: "USD" }).where(eq(agency.id, 1));
    const usd = await buyHours(admin(), 2, { db, providers });
    if (!usd.ok) throw new Error(usd.error);
    expect(usd.value.payUrl).not.toBe(brl.value.payUrl);
    expect((await db.select().from(charges).where(eq(charges.id, old.id)))[0]).toMatchObject({ status: "canceled", hourPurchaseId: null });
    const pending = await db.select().from(charges).where(eq(charges.status, "pending"));
    expect(pending).toEqual([expect.objectContaining({ provider: "stripe", currency: "USD" })]);
    expect(await db.select().from(hourPurchases)).toEqual([expect.objectContaining({ id: pending[0].hourPurchaseId })]);

    // A provider that is not configured any more: its pending purchase is discarded too.
    await db.update(agency).set({ currency: "BRL", defaultPaymentProvider: null }).where(eq(agency.id, 1));
    const again = await buyHours(admin(), 2, { db, providers: [fakeProvider("mercadopago")] });
    if (!again.ok) throw new Error(again.error);
    const live = await db.select().from(charges).where(eq(charges.status, "pending"));
    expect(live).toEqual([expect.objectContaining({ provider: "mercadopago", currency: "BRL" })]);
  });

  it("the purchase note and the label follow the portal user's language", async () => {
    await db.insert(clientMemberships).values({ clientUserId: helper.id, clientId: B.id, role: "admin" });
    await db.update(clients).set({ supportActive: true, hoursMode: "package", includedMinutes: 60, extraHourCents: 5_000 }).where(eq(clients.id, B.id));
    const res = await buyHours(asPortal(B, helper, "admin"), 1, { db, providers: both });
    if (!res.ok) throw new Error(res.error);
    const [row] = await db.select().from(charges);
    expect(row.label).toMatch(/^Horas extras 1h — /);
  });
});

describe("portal money elsewhere", () => {
  it("the portal ticket shows money only to admins", async () => {
    const [ticket] = await db
      .insert(tickets)
      .values({ number: 1, clientId: A.id, type: "single", title: "Landing", status: "open", valueCents: 50_000, createdByType: "client", createdById: boss.id })
      .returning();
    const view = async (role: ClientRole, user: ClientUser) => (await getPortalTicketView(asPortal(A, user, role), ticket.id, "en", db))!;
    expect((await view("admin", boss)).charge).toBeNull();

    const pending = await charge(A.id, { source: "ticket", ticketId: ticket.id, amountCents: 50_000 });
    expect((await view("admin", boss)).charge).toMatchObject({ status: "pending", amountCents: 50_000, payPath: `/pay/${pending.payToken}` });
    const collab = await view("collaborator", helper);
    expect(collab.charge).toBeNull();
    expect(JSON.stringify(collab)).not.toContain("50000");
    expect(JSON.stringify(collab)).not.toContain(pending.payToken);

    // a manual pending charge has nothing to pay; a paid one shows as paid
    await db.update(charges).set({ provider: null }).where(eq(charges.id, pending.id));
    expect((await view("admin", boss)).charge).toMatchObject({ status: "pending", payPath: null });
    await db.update(charges).set({ status: "paid", paidAt: new Date() }).where(eq(charges.id, pending.id));
    expect((await view("admin", boss)).charge).toMatchObject({ status: "paid", payPath: null });
    // a canceled one shows nothing
    await db.update(charges).set({ status: "canceled" }).where(eq(charges.id, pending.id));
    expect((await view("admin", boss)).charge).toBeNull();
  });

  it("the public quote shows its live charge", async () => {
    const [quote] = await db
      .insert(quotes)
      .values({ title: "Site", status: "sent", token: "quote-tok", currency: "BRL", prospectName: "Bia", prospectEmail: "bia@x.com" })
      .returning();
    await db.insert(quoteItems).values({ quoteId: quote.id, kind: "site_creation", title: "Site", amountCents: 100_000, monthly: false, position: 0 });
    expect((await getPublicQuote("quote-tok", { db }))?.charge).toBeNull();

    const c = await charge(null, { source: "quote", quoteId: quote.id, label: "Site", amountCents: 100_000 });
    expect((await getPublicQuote("quote-tok", { db }))?.charge).toMatchObject({
      status: "pending",
      label: "Site",
      amountCents: 100_000,
      currency: "BRL",
      payPath: `/pay/${c.payToken}`,
    });

    // canceled ones are hidden, a manual pending one has no link, a paid one is confirmed
    await db.update(charges).set({ status: "canceled" }).where(eq(charges.id, c.id));
    expect((await getPublicQuote("quote-tok", { db }))?.charge).toBeNull();
    const live = await charge(null, { source: "quote", quoteId: quote.id, provider: null, label: "Site" });
    expect((await getPublicQuote("quote-tok", { db }))?.charge).toMatchObject({ status: "pending", payPath: null });
    const paidAt = new Date("2026-03-04T10:00:00Z");
    await db.update(charges).set({ status: "paid", paidAt }).where(eq(charges.id, live.id));
    expect((await getPublicQuote("quote-tok", { db }))?.charge).toMatchObject({ status: "paid", paidAt, payPath: null });
  });
});
