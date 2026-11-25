import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  charges,
  clients,
  files,
  hourPurchases,
  quoteItems,
  quotes,
  tickets,
  users,
  type Client,
  type Db,
  type User,
} from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { readConfig } from "@/lib/config";
import type { sendMail } from "@/lib/mail/send";
import { getProviders, type PaymentProvider, type ProviderName } from "@/lib/payments";
import type { Storage } from "@/lib/storage";
import {
  applyWebhookEffect,
  attachChargeDocument,
  availableProviders,
  cancelCharge,
  chargeFor,
  createCharge,
  getCharge,
  listCharges,
  markChargePaid,
  removeChargeDocument,
  ticketBilledOnQuote,
} from "./charges";
import { deleteHourPurchase, getHoursSummary } from "./hours";
import { executeQuote } from "./quote-execute";
import { saveQuote, sendQuote, type QuoteInput, type QuoteItemInput } from "./quotes";
import { updateTicketValue } from "./tickets";

// getConfig() is lazy: a database URL and a fixed public address.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let ticketNumber = 0;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
const noMail = (async () => ({ sent: false })) as unknown as typeof sendMail;

type FakeProvider = PaymentProvider & {
  cancelSubscription: ReturnType<typeof vi.fn>;
  expireCheckout: ReturnType<typeof vi.fn>;
};

/** A provider that never talks to anyone: Stripe takes anything, Mercado Pago BRL only (recurring with an e-mail). */
function fakeProvider(name: ProviderName): FakeProvider {
  return {
    name,
    supports: ({ currency, kind, payerEmail }) => name === "stripe" || (currency === "BRL" && (kind === "one_time" || Boolean(payerEmail))),
    createCheckout: vi.fn(async () => ({ url: "https://pay.example/x", checkoutId: "cs_x" })),
    cancelSubscription: vi.fn(async () => {}),
    expireCheckout: vi.fn(async () => {}),
    parseWebhook: vi.fn(async () => []),
  } as FakeProvider;
}

let stripe: FakeProvider;
let mercadopago: FakeProvider;
let providers: PaymentProvider[];

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  const rows = await db
    .insert(users)
    .values([
      { name: "Ana", email: "ana@x.com", role: "owner" },
      { name: "Mo", email: "mo@x.com", role: "manager" },
      { name: "Cris", email: "cris@x.com", role: "collaborator" },
    ])
    .returning();
  [owner, manager, collab] = rows.map(asTeam);
  ticketNumber = 0;
  stripe = fakeProvider("stripe");
  mercadopago = fakeProvider("mercadopago");
  providers = [stripe, mercadopago];
});

afterAll(async () => {
  await db?.$client.end();
});

async function makeClient(values: Partial<typeof clients.$inferInsert> = {}): Promise<Client> {
  const [c] = await db.insert(clients).values({ name: "Acme", ...values }).returning();
  return c;
}

async function makeTicket(clientId: string, values: Partial<typeof tickets.$inferInsert> = {}) {
  ticketNumber += 1;
  const [t] = await db
    .insert(tickets)
    .values({
      number: ticketNumber,
      clientId,
      type: "single",
      title: "Landing page",
      valueCents: 1500_00,
      createdByType: "agency",
      createdById: owner.user.id,
      ...values,
    })
    .returning();
  return t;
}

async function makePurchase(clientId: string, values: Partial<typeof hourPurchases.$inferInsert> = {}) {
  const [p] = await db
    .insert(hourPurchases)
    .values({ clientId, minutes: 120, cycle: "2026-11", priceCents: 200_00, ...values })
    .returning();
  return p;
}

const item = (over: Partial<QuoteItemInput> = {}): QuoteItemInput => ({
  kind: "site_creation",
  title: "Website",
  amountCents: 1000_00,
  config: {},
  ...over,
});

/** Saves a quote and marks it as sent. */
async function sentQuote(input: Omit<QuoteInput, "title"> & { title?: string }): Promise<string> {
  const saved = await saveQuote(owner, { title: "Proposal", ...input }, { db });
  if (!saved.ok) throw new Error(saved.error);
  const marked = await sendQuote(owner, saved.value.id, { db, send: noMail });
  if (!marked.ok) throw new Error(marked.error);
  return saved.value.id;
}

async function itemsOf(quoteId: string) {
  return db.select().from(quoteItems).where(eq(quoteItems.quoteId, quoteId)).orderBy(quoteItems.position);
}

async function chargeRow(id: string) {
  const [row] = await db.select().from(charges).where(eq(charges.id, id));
  return row;
}

function expectOk<T>(res: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
  return res.value;
}

const deps = () => ({ db, providers });

describe("charges", () => {
  it("amounts follow each source's rule", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00, email: "fin@acme.com" });

    // Ticket: its value, "#N title", the agency's currency; the pay link carries the token.
    const ticket = await makeTicket(client.id, { title: "Landing page", valueCents: 1500_00 });
    const t = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: null }, deps()));
    expect(t.payUrl).toMatch(/^https:\/\/painel\.acme\.com\/pay\/[A-Za-z0-9_-]{32}$/);
    const tRow = await chargeRow(t.id);
    expect(tRow).toMatchObject({
      source: "ticket",
      kind: "one_time",
      status: "pending",
      provider: null,
      amountCents: 1500_00,
      currency: "BRL",
      label: `#${ticket.number} Landing page`,
      clientId: client.id,
      ticketId: ticket.id,
      createdById: owner.user.id,
    });
    expect(t.payUrl.endsWith(tRow.payToken)).toBe(true);
    // A ticket without a value, or a support ticket, has nothing to charge.
    const noValue = await makeTicket(client.id, { valueCents: null });
    expect(await createCharge(owner, { source: "ticket", sourceId: noValue.id, provider: null }, deps())).toEqual({ ok: false, error: "nothingToCharge" });
    const support = await makeTicket(client.id, { type: "support", valueCents: null });
    expect(await createCharge(owner, { source: "ticket", sourceId: support.id, provider: null }, deps())).toEqual({ ok: false, error: "nothingToCharge" });
    expect(await createCharge(owner, { source: "ticket", provider: null }, deps())).toEqual({ ok: false, error: "required" });
    expect(await createCharge(owner, { source: "ticket", sourceId: "nope", provider: null }, deps())).toEqual({ ok: false, error: "notFound" });

    // Support: the monthly fee, always a subscription, labeled in the creator's language.
    await db.update(users).set({ locale: "pt" }).where(eq(users.id, manager.user.id));
    const pt = { ...manager, user: { ...manager.user, locale: "pt" } };
    const s = expectOk(await createCharge(pt, { source: "support", sourceId: client.id, kind: "one_time", amountCents: 1, provider: null }, deps()));
    expect(await chargeRow(s.id)).toMatchObject({
      source: "support",
      kind: "subscription",
      amountCents: 500_00,
      label: "Mensalidade de suporte — Acme",
      clientId: client.id,
    });
    const noPlan = await makeClient({ name: "No plan" });
    expect(await createCharge(owner, { source: "support", sourceId: noPlan.id, provider: null }, deps())).toEqual({ ok: false, error: "nothingToCharge" });

    // Hours: the purchase's price, "Extra hours 2h30 — 2026-11".
    const purchase = await makePurchase(client.id, { minutes: 150, priceCents: 300_00 });
    const h = expectOk(await createCharge(owner, { source: "hours", sourceId: purchase.id, provider: null }, deps()));
    expect(await chargeRow(h.id)).toMatchObject({
      source: "hours",
      kind: "one_time",
      amountCents: 300_00,
      label: "Extra hours 2h30 — 2026-11",
      hourPurchaseId: purchase.id,
      clientId: client.id,
    });
    const free = await makePurchase(client.id, { priceCents: null });
    expect(await createCharge(owner, { source: "hours", sourceId: free.id, provider: null }, deps())).toEqual({ ok: false, error: "nothingToCharge" });

    // Quote: while sent, every one-time item (monthly ones never); its own currency, not the agency's.
    const quoteId = await sentQuote({
      clientId: client.id,
      title: "New site",
      items: [
        item({ title: "Site", amountCents: 1000_00 }),
        item({ kind: "maintenance", title: "Migration", amountCents: 400_00 }),
        item({ kind: "support", title: "Plan", amountCents: 300_00 }),
      ],
    });
    await db.update(agency).set({ currency: "USD" });
    const q = expectOk(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps()));
    expect(await chargeRow(q.id)).toMatchObject({
      source: "quote",
      kind: "one_time",
      amountCents: 1400_00,
      currency: "BRL",
      label: "New site",
      quoteId,
      clientId: client.id,
    });
    // Accepted: only what the client approved.
    expectOk(await cancelCharge(owner, q.id, deps()));
    const [site] = await itemsOf(quoteId);
    await db.update(quoteItems).set({ clientApproved: true }).where(eq(quoteItems.id, site.id));
    await db.update(quotes).set({ status: "accepted" }).where(eq(quotes.id, quoteId));
    const q2 = expectOk(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps()));
    expect((await chargeRow(q2.id)).amountCents).toBe(1000_00);
    // Executed: approved or executed items.
    expectOk(await cancelCharge(owner, q2.id, deps()));
    const [, migration] = await itemsOf(quoteId);
    await db.update(quoteItems).set({ executed: true }).where(eq(quoteItems.id, migration.id));
    await db.update(quotes).set({ status: "executed" }).where(eq(quotes.id, quoteId));
    const q3 = expectOk(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps()));
    expect((await chargeRow(q3.id)).amountCents).toBe(1400_00);
    // Draft and archived quotes have nothing to charge.
    expectOk(await cancelCharge(owner, q3.id, deps()));
    await db.update(quotes).set({ status: "archived" }).where(eq(quotes.id, quoteId));
    expect(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps())).toEqual({ ok: false, error: "nothingToCharge" });
    await db.update(quotes).set({ status: "draft" }).where(eq(quotes.id, quoteId));
    expect(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps())).toEqual({ ok: false, error: "nothingToCharge" });

    // No source: typed amount, label and kind, in the agency's current currency.
    const n = expectOk(
      await createCharge(
        owner,
        { source: "none", clientId: client.id, label: "  Domain renewal  ", amountCents: 90_00, kind: "subscription", provider: null },
        deps(),
      ),
    );
    expect(await chargeRow(n.id)).toMatchObject({
      source: "none",
      kind: "subscription",
      amountCents: 90_00,
      currency: "USD",
      label: "Domain renewal",
      clientId: client.id,
      ticketId: null,
      hourPurchaseId: null,
      quoteId: null,
    });
    const none = (over: object) => createCharge(owner, { source: "none", clientId: client.id, label: "X", amountCents: 100, provider: null, ...over }, deps());
    expect(await none({ label: " " })).toEqual({ ok: false, error: "required" });
    expect(await none({ clientId: undefined })).toEqual({ ok: false, error: "required" });
    expect(await none({ amountCents: undefined })).toEqual({ ok: false, error: "required" });
    expect(await none({ amountCents: 0 })).toEqual({ ok: false, error: "invalidAmount" });
    expect(await none({ amountCents: 1.5 })).toEqual({ ok: false, error: "invalidAmount" });
    expect(await none({ amountCents: 3_000_000_000 })).toEqual({ ok: false, error: "invalidAmount" });
    expect(await none({ clientId: "00000000-0000-4000-8000-000000000000" })).toEqual({ ok: false, error: "notFound" });
    expect((await chargeRow(expectOk(await none({})).id)).kind).toBe("one_time");
  });

  it("two concurrent creations for one source make one charge", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00 });
    const ticket = await makeTicket(client.id);
    const purchase = await makePurchase(client.id);
    const quoteId = await sentQuote({ clientId: client.id, items: [item()] });
    const sources = [
      { source: "ticket" as const, sourceId: ticket.id },
      { source: "support" as const, sourceId: client.id },
      { source: "hours" as const, sourceId: purchase.id },
      { source: "quote" as const, sourceId: quoteId },
    ];
    for (let round = 0; round < 20; round++) {
      const target = sources[round % sources.length];
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => createCharge(owner, { ...target, provider: null }, deps())),
      );
      const values = results.map((r) => {
        if (r.status === "rejected") throw r.reason;
        return r.value;
      });
      const wins = values.filter((v) => v.ok);
      expect(wins).toHaveLength(1);
      for (const v of values.filter((v) => !v.ok)) expect(v).toEqual({ ok: false, error: "chargeExists" });
      // Canceled charges do not block the next one.
      const win = wins[0];
      if (!win.ok) throw new Error("unreachable");
      expectOk(await cancelCharge(owner, win.value.id, deps()));
    }
    const all = await db.select().from(charges);
    expect(all).toHaveLength(20);
    expect(all.every((c) => c.status === "canceled")).toBe(true);
  });

  it("a quote charge and its tickets' charges never coexist", async () => {
    const client = await makeClient();
    const quoteId = await sentQuote({ clientId: client.id, items: [item({ title: "Site" }), item({ kind: "maintenance", title: "Fix" })] });
    const items = await itemsOf(quoteId);
    expectOk(await executeQuote(owner, quoteId, items.map((i) => i.id), { db, send: noMail }));
    const made = await db.select().from(tickets).where(inArray(tickets.quoteItemId, items.map((i) => i.id)));
    expect(made).toHaveLength(2);
    const [first, second] = made;

    // The quote is charged: its tickets are not.
    const q = expectOk(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps()));
    expect(await createCharge(owner, { source: "ticket", sourceId: first.id, provider: null }, deps())).toEqual({ ok: false, error: "billedOnQuote" });
    // The ticket panel learns it is billed on the quote; only the owner learns which quote.
    expect(expectOk(await ticketBilledOnQuote(owner, first.id, deps()))).toEqual({ billed: true, quote: { id: quoteId, title: "Proposal" } });
    expect(expectOk(await ticketBilledOnQuote(manager, first.id, deps()))).toEqual({ billed: true });
    expect(await ticketBilledOnQuote(collab, first.id, deps())).toEqual({ ok: false, error: "forbidden" });
    expectOk(await cancelCharge(owner, q.id, deps()));
    expect(expectOk(await ticketBilledOnQuote(owner, first.id, deps()))).toBeNull();

    // A ticket is charged: the quote is not.
    const t = expectOk(await createCharge(owner, { source: "ticket", sourceId: first.id, provider: null }, deps()));
    expect(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps())).toEqual({ ok: false, error: "billedOnTickets" });
    // A paid ticket charge still blocks it.
    expectOk(await markChargePaid(owner, t.id, deps()));
    expect(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps())).toEqual({ ok: false, error: "billedOnTickets" });
    // The other ticket stays chargeable on its own.
    const t2 = expectOk(await createCharge(owner, { source: "ticket", sourceId: second.id, provider: null }, deps()));
    expectOk(await cancelCharge(owner, t2.id, deps()));
    await db.delete(charges).where(eq(charges.id, t.id));

    // Racing both sides: never both.
    for (let round = 0; round < 10; round++) {
      const results = await Promise.all([
        createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps()),
        createCharge(owner, { source: "ticket", sourceId: second.id, provider: null }, deps()),
      ]);
      const wins = results.filter((r) => r.ok);
      expect(wins).toHaveLength(1);
      const lost = results.find((r) => !r.ok);
      expect(["billedOnQuote", "billedOnTickets"]).toContain(lost && !lost.ok ? lost.error : "");
      const live = await db.select().from(charges).where(inArray(charges.status, ["pending", "paid", "active", "past_due"]));
      expect(live).toHaveLength(1);
      for (const w of wins) if (w.ok) expectOk(await cancelCharge(owner, w.value.id, deps()));
    }
  });

  it("collaborators never see money", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00 });
    const ticket = await makeTicket(client.id);
    const purchase = await makePurchase(client.id);
    const forbidden = { ok: false, error: "forbidden" };
    for (const input of [
      { source: "ticket" as const, sourceId: ticket.id },
      { source: "support" as const, sourceId: client.id },
      { source: "hours" as const, sourceId: purchase.id },
      { source: "none" as const, clientId: client.id, label: "X", amountCents: 100 },
    ]) {
      expect(await createCharge(collab, { ...input, provider: null }, deps())).toEqual(forbidden);
    }
    const c = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: null }, deps()));
    expect(await listCharges(collab, {}, deps())).toEqual(forbidden);
    expect(await chargeFor(collab, { source: "ticket", sourceId: ticket.id }, deps())).toEqual(forbidden);
    expect(await markChargePaid(collab, c.id, deps())).toEqual(forbidden);
    expect(await cancelCharge(collab, c.id, deps())).toEqual(forbidden);
    expect(await attachChargeDocument(collab, c.id, "00000000-0000-4000-8000-000000000000", deps())).toEqual(forbidden);
    expect(await removeChargeDocument(collab, c.id, deps())).toEqual(forbidden);
    expect(await updateTicketValue(collab, ticket.id, 10_00, { db })).toEqual(forbidden);
    expect((await chargeRow(c.id)).status).toBe("pending");
  });

  it("quote charges are owner only", async () => {
    const client = await makeClient();
    const quoteId = await sentQuote({ clientId: client.id, items: [item()] });
    const forbidden = { ok: false, error: "forbidden" };
    expect(await createCharge(manager, { source: "quote", sourceId: quoteId, provider: null }, deps())).toEqual(forbidden);
    expect(await chargeFor(manager, { source: "quote", sourceId: quoteId }, deps())).toEqual(forbidden);

    const q = expectOk(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps()));
    expect(await markChargePaid(manager, q.id, deps())).toEqual(forbidden);
    expect(await cancelCharge(manager, q.id, deps())).toEqual(forbidden);
    expect(await attachChargeDocument(manager, q.id, "00000000-0000-4000-8000-000000000000", deps())).toEqual(forbidden);
    expect(await removeChargeDocument(manager, q.id, deps())).toEqual(forbidden);
    // The manager never sees it, not even in the list.
    expect(expectOk(await listCharges(manager, {}, deps()))).toEqual([]);
    expect(expectOk(await listCharges(manager, { clientId: client.id }, deps()))).toEqual([]);
    expect(expectOk(await listCharges(owner, {}, deps())).map((r) => [r.id, r.canAct])).toEqual([[q.id, true]]);
    // The owner acts.
    expect(expectOk(await chargeFor(owner, { source: "quote", sourceId: quoteId }, deps()))?.id).toBe(q.id);
    expectOk(await markChargePaid(owner, q.id, deps()));
    expect((await chargeRow(q.id)).status).toBe("paid");
  });

  it("mark paid only for a pending one-time charge, and it releases the hour purchase", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00 });
    const purchase = await makePurchase(client.id, { pending: true });
    const h = expectOk(await createCharge(manager, { source: "hours", sourceId: purchase.id, provider: "stripe" }, deps()));
    await db.update(charges).set({ externalCheckoutId: "cs_open" }).where(eq(charges.id, h.id));
    expect((await getHoursSummary(client.id, "2026-11", { db }))?.purchasedMinutes).toBe(0);

    expectOk(await markChargePaid(manager, h.id, deps()));
    const paid = await chargeRow(h.id);
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).toBeInstanceOf(Date);
    const [released] = await db.select().from(hourPurchases).where(eq(hourPurchases.id, purchase.id));
    expect(released.pending).toBe(false);
    expect((await getHoursSummary(client.id, "2026-11", { db }))?.purchasedMinutes).toBe(120);
    // The open checkout can no longer be paid twice.
    expect(stripe.expireCheckout).toHaveBeenCalledWith("cs_open");

    // Twice, a subscription, a canceled one: refused.
    expect(await markChargePaid(manager, h.id, deps())).toEqual({ ok: false, error: "chargeNotPending" });
    const s = expectOk(await createCharge(manager, { source: "support", sourceId: client.id, provider: null }, deps()));
    expect(await markChargePaid(manager, s.id, deps())).toEqual({ ok: false, error: "chargeNotPending" });
    const ticket = await makeTicket(client.id);
    const t = expectOk(await createCharge(manager, { source: "ticket", sourceId: ticket.id, provider: null }, deps()));
    expectOk(await cancelCharge(manager, t.id, deps()));
    expect(await markChargePaid(manager, t.id, deps())).toEqual({ ok: false, error: "chargeNotPending" });
    expect(await markChargePaid(manager, "nope", deps())).toEqual({ ok: false, error: "notFound" });
  });

  it("canceling deletes a pending purchase, cancels the provider subscription and expires the open checkout", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00, email: "fin@acme.com" });

    // A portal purchase waiting for payment: canceled, it goes away with its open checkout.
    const pending = await makePurchase(client.id, { pending: true });
    const h = expectOk(await createCharge(owner, { source: "hours", sourceId: pending.id, provider: "stripe" }, deps()));
    await db.update(charges).set({ externalCheckoutId: "cs_open" }).where(eq(charges.id, h.id));
    expect(expectOk(await cancelCharge(owner, h.id, deps()))).toEqual({ changed: true });
    const canceled = await chargeRow(h.id);
    expect(canceled.status).toBe("canceled");
    expect(canceled.canceledAt).toBeInstanceOf(Date);
    expect(await db.select().from(hourPurchases).where(eq(hourPurchases.id, pending.id))).toEqual([]);
    expect(stripe.expireCheckout).toHaveBeenCalledWith("cs_open");
    // Again: nothing changes and the provider is not called again.
    expect(expectOk(await cancelCharge(owner, h.id, deps()))).toEqual({ changed: false });
    expect(stripe.expireCheckout).toHaveBeenCalledTimes(1);

    // A manual purchase stays (its hours already count).
    const manual = await makePurchase(client.id);
    const m = expectOk(await createCharge(owner, { source: "hours", sourceId: manual.id, provider: null }, deps()));
    expectOk(await cancelCharge(owner, m.id, deps()));
    expect(await db.select().from(hourPurchases).where(eq(hourPurchases.id, manual.id))).toHaveLength(1);

    // An active subscription: canceled at the provider too; a provider failure does not stop the cancel
    // and is logged without its message.
    const s = expectOk(await createCharge(owner, { source: "support", sourceId: client.id, provider: "mercadopago" }, deps()));
    await db.update(charges).set({ status: "active", externalSubscriptionId: "pre_1" }).where(eq(charges.id, s.id));
    const secret = "token APP_USR-secret in the body";
    mercadopago.cancelSubscription.mockRejectedValueOnce(Object.assign(new TypeError(secret), { code: "ECONNRESET" }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(expectOk(await cancelCharge(owner, s.id, deps()))).toEqual({ changed: true });
      expect(mercadopago.cancelSubscription).toHaveBeenCalledWith("pre_1");
      expect((await chargeRow(s.id)).status).toBe("canceled");
      const text = JSON.stringify(logged.mock.calls);
      expect(text).toContain("TypeError");
      expect(text).toContain("ECONNRESET");
      expect(text).not.toContain("secret");
    } finally {
      logged.mockRestore();
    }

    // A paid charge is not canceled.
    const ticket = await makeTicket(client.id);
    const t = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: null }, deps()));
    expectOk(await markChargePaid(owner, t.id, deps()));
    expect(await cancelCharge(owner, t.id, deps())).toEqual({ ok: false, error: "alreadyPaid" });
  });

  it("paying a portal hour purchase releases it into its cycle", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00, hoursTracked: true, hoursVisible: true, hoursLimited: true, hoursPurchasable: true, includedMinutes: 600, extraHourCents: 100_00 });
    const purchase = await makePurchase(client.id, { pending: true, minutes: 180, priceCents: 300_00, cycle: "2026-10" });
    const h = expectOk(await createCharge(owner, { source: "hours", sourceId: purchase.id, provider: "stripe" }, deps()));
    expect((await getHoursSummary(client.id, "2026-10", { db }))?.purchasedMinutes).toBe(0);

    // Another provider's event, an unknown charge and a foreign reference change nothing.
    await db.transaction(async (tx) => {
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e0", chargeId: h.id, effect: "paid" }, "mercadopago")).toEqual({ changed: false });
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e1", chargeId: "00000000-0000-4000-8000-000000000000", effect: "paid" }, "stripe")).toEqual({ changed: false });
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e2", chargeId: "order-123", effect: "paid" }, "stripe")).toEqual({ changed: false });
    });
    expect((await chargeRow(h.id)).status).toBe("pending");

    await db.transaction(async (tx) => {
      const res = await applyWebhookEffect(tx as unknown as Db, { eventId: "e3", chargeId: h.id, externalPaymentId: "pi_1", effect: "paid" }, "stripe");
      expect(res).toEqual({ changed: true });
    });
    const paid = await chargeRow(h.id);
    expect(paid).toMatchObject({ status: "paid", externalPaymentId: "pi_1" });
    const firstPaidAt = paid.paidAt;
    expect(firstPaidAt).toBeInstanceOf(Date);
    const summary = await getHoursSummary(client.id, "2026-10", { db });
    expect(summary?.purchasedMinutes).toBe(180);
    expect((await getHoursSummary(client.id, "2026-11", { db }))?.purchasedMinutes).toBe(0);

    // A replay keeps the first paid_at.
    await db.transaction(async (tx) => {
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e4", chargeId: h.id, effect: "paid" }, "stripe")).toEqual({ changed: false });
    });
    expect((await chargeRow(h.id)).paidAt?.getTime()).toBe(firstPaidAt?.getTime());

    // A one-time charge canceled and then paid becomes paid (the money came in).
    const ticket = await makeTicket(client.id);
    const t = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: "stripe" }, deps()));
    expectOk(await cancelCharge(owner, t.id, deps()));
    await db.transaction(async (tx) => {
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e5", chargeId: t.id, effect: "paid" }, "stripe")).toEqual({ changed: true });
    });
    expect(await chargeRow(t.id)).toMatchObject({ status: "paid", canceledAt: null });

    // A subscription found by its provider id; once canceled it ignores everything.
    const s = expectOk(await createCharge(owner, { source: "support", sourceId: client.id, provider: "stripe" }, deps()));
    await db.transaction(async (tx) => {
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e6", chargeId: s.id, externalSubscriptionId: "sub_1", effect: "active" }, "stripe")).toEqual({ changed: true });
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e7", chargeId: null, externalSubscriptionId: "sub_1", effect: "past_due" }, "stripe")).toEqual({ changed: true });
    });
    expect(await chargeRow(s.id)).toMatchObject({ status: "past_due", externalSubscriptionId: "sub_1" });
    await db.transaction(async (tx) => {
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e8", chargeId: null, externalSubscriptionId: "sub_1", effect: "canceled" }, "stripe")).toEqual({ changed: true });
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await db.transaction(async (tx) => {
        expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "e9", chargeId: s.id, effect: "active" }, "stripe")).toEqual({ changed: false });
      });
    } finally {
      quiet.mockRestore();
    }
    const sub = await chargeRow(s.id);
    expect(sub.status).toBe("canceled");
    expect(sub.canceledAt).toBeInstanceOf(Date);
    expect(sub.paidAt).toBeInstanceOf(Date);
  });

  it("a second subscription for an active charge is reported as orphan", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00, email: "fin@acme.com" });
    const s = expectOk(await createCharge(owner, { source: "support", sourceId: client.id, provider: "stripe" }, deps()));
    await db.update(charges).set({ status: "active", externalSubscriptionId: "sub_1" }).where(eq(charges.id, s.id));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await db.transaction(async (tx) => {
        for (const effect of ["active", "past_due"] as const) {
          expect(await applyWebhookEffect(tx as unknown as Db, { eventId: `o-${effect}`, chargeId: s.id, externalSubscriptionId: "sub_2", effect }, "stripe")).toEqual({
            changed: false,
            orphanSubscriptionId: "sub_2",
          });
        }
        // The cancel of the extra one is not the charge's.
        expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "o-c", chargeId: s.id, externalSubscriptionId: "sub_2", effect: "canceled" }, "stripe")).toEqual({ changed: false });
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("sub_2"));
    } finally {
      logged.mockRestore();
    }
    expect(await chargeRow(s.id)).toMatchObject({ status: "active", externalSubscriptionId: "sub_1" });
  });

  it("a canceled event for a superseded checkout does not cancel a pending subscription charge", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00, email: "fin@acme.com" });
    const s = expectOk(await createCharge(owner, { source: "support", sourceId: client.id, provider: "mercadopago" }, deps()));
    await db.transaction(async (tx) => {
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "x1", chargeId: s.id, externalSubscriptionId: "pre-1", effect: "canceled" }, "mercadopago")).toEqual({ changed: false });
    });
    expect(await chargeRow(s.id)).toMatchObject({ status: "pending", externalSubscriptionId: null, canceledAt: null });
    await db.transaction(async (tx) => {
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "x2", chargeId: s.id, externalSubscriptionId: "pre-2", effect: "active" }, "mercadopago")).toEqual({ changed: true });
    });
    expect(await chargeRow(s.id)).toMatchObject({ status: "active", externalSubscriptionId: "pre-2" });
    // The stale one cancelling later still changes nothing; the real one cancelling does.
    await db.transaction(async (tx) => {
      expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "x3", chargeId: s.id, externalSubscriptionId: "pre-1", effect: "canceled" }, "mercadopago")).toEqual({ changed: false });
    });
    expect((await chargeRow(s.id)).status).toBe("active");
  });

  it("a payment after a manual mark as paid is logged", async () => {
    const client = await makeClient();
    const t = expectOk(await createCharge(owner, { source: "none", clientId: client.id, label: "Hosting", amountCents: 10_00, provider: "mercadopago" }, deps()));
    expectOk(await markChargePaid(owner, t.id, deps()));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await db.transaction(async (tx) => {
        expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "m1", chargeId: t.id, externalPaymentId: "pay_9", effect: "paid" }, "mercadopago")).toEqual({ changed: false });
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("marked paid by hand"));
      expect(logged.mock.calls.join(" ")).toContain("pay_9");
    } finally {
      logged.mockRestore();
    }
    expect(await chargeRow(t.id)).toMatchObject({ status: "paid", externalPaymentId: null });
  });

  it("a second payment for a paid charge is logged", async () => {
    const client = await makeClient();
    const t = expectOk(await createCharge(owner, { source: "none", clientId: client.id, label: "Hosting", amountCents: 10_00, provider: "stripe" }, deps()));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await db.transaction(async (tx) => {
        expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "p1", chargeId: t.id, externalPaymentId: "pi_1", effect: "paid" }, "stripe")).toEqual({ changed: true });
        expect(await applyWebhookEffect(tx as unknown as Db, { eventId: "p2", chargeId: t.id, externalPaymentId: "pi_2", effect: "paid" }, "stripe")).toEqual({ changed: false });
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("possible duplicate payment"));
      expect(logged.mock.calls.join(" ")).toContain("pi_2");
    } finally {
      logged.mockRestore();
    }
    expect(await chargeRow(t.id)).toMatchObject({ status: "paid", externalPaymentId: "pi_1" });
  });

  it("a subscription that goes live after its charge was canceled is reported for canceling at the provider", async () => {
    const client = await makeClient({ supportActive: true, supportMonthlyCents: 500_00, email: "fin@acme.com" });
    // Staff cancels while the client is still in the checkout: no subscription id is known yet.
    const s = expectOk(await createCharge(owner, { source: "support", sourceId: client.id, provider: "stripe" }, deps()));
    expectOk(await cancelCharge(owner, s.id, deps()));
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await db.transaction(async (tx) => {
        const res = await applyWebhookEffect(
          tx as unknown as Db,
          { eventId: "late", chargeId: s.id, externalSubscriptionId: "sub_late", effect: "active" },
          "stripe",
        );
        expect(res).toEqual({ changed: false, orphanSubscriptionId: "sub_late" });
        // A renewal failure for it says the same.
        expect(
          await applyWebhookEffect(tx as unknown as Db, { eventId: "late2", chargeId: s.id, externalSubscriptionId: "sub_late", effect: "past_due" }, "stripe"),
        ).toEqual({ changed: false, orphanSubscriptionId: "sub_late" });
        // The provider confirming the cancel is not an orphan.
        expect(
          await applyWebhookEffect(tx as unknown as Db, { eventId: "late3", chargeId: s.id, externalSubscriptionId: "sub_late", effect: "canceled" }, "stripe"),
        ).toEqual({ changed: false });
      });
      const text = JSON.stringify(logged.mock.calls);
      expect(text).toContain(s.id);
      expect(text).toContain("sub_late");
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
    // The charge stays canceled and keeps no provider id.
    expect(await chargeRow(s.id)).toMatchObject({ status: "canceled", externalSubscriptionId: null, paidAt: null });
  });

  it("a purchase with a live or paid charge cannot be deleted", async () => {
    const client = await makeClient({ supportActive: true, hoursTracked: true, hoursVisible: true, hoursLimited: true, includedMinutes: 600 });
    const live = await makePurchase(client.id);
    const c = expectOk(await createCharge(owner, { source: "hours", sourceId: live.id, provider: null }, deps()));
    expect(await deleteHourPurchase(owner, client.id, live.id, { db })).toEqual({ ok: false, error: "chargeExists" });
    expectOk(await cancelCharge(owner, c.id, deps()));
    expectOk(await deleteHourPurchase(owner, client.id, live.id, { db }));
    // The canceled charge stays, without its source.
    expect((await chargeRow(c.id)).hourPurchaseId).toBeNull();

    const paid = await makePurchase(client.id);
    const p = expectOk(await createCharge(owner, { source: "hours", sourceId: paid.id, provider: null }, deps()));
    expectOk(await markChargePaid(owner, p.id, deps()));
    expect(await deleteHourPurchase(owner, client.id, paid.id, { db })).toEqual({ ok: false, error: "chargeExists" });
    expect(await db.select().from(hourPurchases).where(eq(hourPurchases.id, paid.id))).toHaveLength(1);
  });

  it("executing a prospect quote links its charges to the new client", async () => {
    const quoteId = await sentQuote({
      clientId: null,
      prospectName: "Bia Doces",
      items: [item({ title: "Site" })],
    });
    const q = expectOk(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps()));
    expect((await chargeRow(q.id)).clientId).toBeNull();
    // A canceled charge of another quote is left alone.
    const other = await sentQuote({ clientId: null, prospectName: "Other", items: [item()] });
    const o = expectOk(await createCharge(owner, { source: "quote", sourceId: other, provider: null }, deps()));

    const items = await itemsOf(quoteId);
    expectOk(await executeQuote(owner, quoteId, items.map((i) => i.id), { db, send: noMail }));
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote.clientId).not.toBeNull();
    expect((await chargeRow(q.id)).clientId).toBe(quote.clientId);
    expect((await chargeRow(o.id)).clientId).toBeNull();
    // The tickets it made remember their item.
    const made = await db.select().from(tickets).where(eq(tickets.clientId, quote.clientId!));
    expect(made.map((t) => t.quoteItemId)).toEqual([items[0].id]);
    // The new client's charge list shows it.
    const listed = expectOk(await listCharges(owner, { clientId: quote.clientId! }, deps()));
    expect(listed.map((r) => [r.id, r.clientName])).toEqual([[q.id, "Bia Doces"]]);
  });

  it("the ticket value is editable only without a live or paid charge", async () => {
    const client = await makeClient();
    const ticket = await makeTicket(client.id, { valueCents: null });
    expectOk(await updateTicketValue(manager, ticket.id, 800_00, { db }));
    expect((await db.select().from(tickets).where(eq(tickets.id, ticket.id)))[0].valueCents).toBe(800_00);
    expect(await updateTicketValue(manager, ticket.id, -1, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await updateTicketValue(manager, ticket.id, 1.5, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await updateTicketValue(manager, "nope", 1, { db })).toEqual({ ok: false, error: "notFound" });
    const support = await makeTicket(client.id, { type: "support", valueCents: null });
    expect(await updateTicketValue(owner, support.id, 100, { db })).toEqual({ ok: false, error: "invalid" });

    const c = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: null }, deps()));
    expect(await updateTicketValue(owner, ticket.id, 900_00, { db })).toEqual({ ok: false, error: "chargeExists" });
    expectOk(await cancelCharge(owner, c.id, deps()));
    expectOk(await updateTicketValue(owner, ticket.id, 900_00, { db }));
    const c2 = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: null }, deps()));
    expect((await chargeRow(c2.id)).amountCents).toBe(900_00);
    expectOk(await markChargePaid(owner, c2.id, deps()));
    expect(await updateTicketValue(owner, ticket.id, null, { db })).toEqual({ ok: false, error: "chargeExists" });

    const other = await makeTicket(client.id);
    expectOk(await updateTicketValue(owner, other.id, null, { db }));
    expect((await db.select().from(tickets).where(eq(tickets.id, other.id)))[0].valueCents).toBeNull();
  });

  it("providers offered follow currency, kind and e-mail", async () => {
    const config = readConfig({
      DATABASE_URL: "postgres://localhost/x",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      MERCADOPAGO_ACCESS_TOKEN: "TEST-x",
      MERCADOPAGO_WEBHOOK_SECRET: "mp-x",
    });
    const real = { providers: getProviders(config, { fetch: (async () => new Response("{}")) as typeof fetch }) };
    expect(availableProviders({ currency: "BRL", kind: "one_time", clientEmail: null }, real)).toEqual(["stripe", "mercadopago", null]);
    expect(availableProviders({ currency: "BRL", kind: "subscription", clientEmail: null }, real)).toEqual(["stripe", null]);
    expect(availableProviders({ currency: "BRL", kind: "subscription", clientEmail: "a@b.com" }, real)).toEqual(["stripe", "mercadopago", null]);
    expect(availableProviders({ currency: "USD", kind: "one_time", clientEmail: "a@b.com" }, real)).toEqual(["stripe", null]);
    expect(availableProviders({ currency: "EUR", kind: "subscription", clientEmail: null }, real)).toEqual(["stripe", null]);
    // Without keys only the manual record is left.
    expect(availableProviders({ currency: "BRL", kind: "one_time", clientEmail: null }, { providers: [] })).toEqual([null]);

    // Creation applies the same rule.
    const noEmail = await makeClient({ supportActive: true, supportMonthlyCents: 500_00 });
    expect(await createCharge(owner, { source: "support", sourceId: noEmail.id, provider: "mercadopago" }, deps())).toEqual({
      ok: false,
      error: "providerUnavailable",
    });
    expectOk(await createCharge(owner, { source: "support", sourceId: noEmail.id, provider: "stripe" }, deps()));
    const ticket = await makeTicket(noEmail.id);
    await db.update(agency).set({ currency: "USD" });
    expect(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: "mercadopago" }, deps())).toEqual({
      ok: false,
      error: "providerUnavailable",
    });
    expect(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: "stripe" }, { db, providers: [mercadopago] })).toEqual({
      ok: false,
      error: "providerUnavailable",
    });
    const made = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: "stripe" }, deps()));
    expect(await chargeRow(made.id)).toMatchObject({ provider: "stripe", currency: "USD" });
    // Nothing was created by the refusals.
    expect(await db.select().from(charges).where(and(eq(charges.ticketId, ticket.id)))).toHaveLength(1);
  });

  it("a fiscal document is attached, replaced and removed", async () => {
    const client = await makeClient();
    const ticket = await makeTicket(client.id);
    const c = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: null }, deps()));
    const removed: string[] = [];
    const storage = { remove: async (key: string) => void removed.push(key) } as unknown as Storage;
    const doc = async (key: string, values: Partial<typeof files.$inferInsert> = {}) => {
      const [f] = await db
        .insert(files)
        .values({ storageKey: key, name: "nf.pdf", mime: "application/pdf", sizeBytes: 1000, uploadedByType: "agency", uploadedById: owner.user.id, ...values })
        .returning();
      return f;
    };
    const first = await doc("documents/2026/11/a");
    expectOk(await attachChargeDocument(manager, c.id, first.id, { ...deps(), storage }));
    expect((await chargeRow(c.id)).documentFileId).toBe(first.id);

    // A file that is not a document upload is refused.
    const attachment = await doc("attachments/2026/11/b");
    expect(await attachChargeDocument(manager, c.id, attachment.id, { ...deps(), storage })).toEqual({ ok: false, error: "invalidFile" });
    const zip = await doc("documents/2026/11/z", { mime: "application/zip" });
    expect(await attachChargeDocument(manager, c.id, zip.id, { ...deps(), storage })).toEqual({ ok: false, error: "invalidFile" });
    const big = await doc("documents/2026/11/big", { sizeBytes: 9 * 1024 * 1024 });
    expect(await attachChargeDocument(manager, c.id, big.id, { ...deps(), storage })).toEqual({ ok: false, error: "invalidFile" });

    // Replacing drops the previous file and its object.
    const second = await doc("documents/2026/11/c", { mime: "image/png", name: "nf.png" });
    expectOk(await attachChargeDocument(manager, c.id, second.id, { ...deps(), storage }));
    expect((await chargeRow(c.id)).documentFileId).toBe(second.id);
    expect(await db.select().from(files).where(eq(files.id, first.id))).toEqual([]);
    expect(removed).toEqual(["documents/2026/11/a"]);
    // The same file cannot back two charges.
    const t2 = await makeTicket(client.id);
    const c2 = expectOk(await createCharge(owner, { source: "ticket", sourceId: t2.id, provider: null }, deps()));
    expect(await attachChargeDocument(manager, c2.id, second.id, { ...deps(), storage })).toEqual({ ok: false, error: "invalidFile" });

    const listed = expectOk(await listCharges(manager, {}, deps()));
    expect(listed.find((r) => r.id === c.id)?.document).toEqual({ id: second.id, name: "nf.png" });

    expectOk(await removeChargeDocument(manager, c.id, { ...deps(), storage }));
    expect((await chargeRow(c.id)).documentFileId).toBeNull();
    expect(await db.select().from(files).where(eq(files.id, second.id))).toEqual([]);
    expect(removed).toEqual(["documents/2026/11/a", "documents/2026/11/c"]);
    // Nothing to remove is fine.
    expectOk(await removeChargeDocument(manager, c.id, { ...deps(), storage }));
  });

  it("lists charges by client and status, and finds a source's live or paid charge", async () => {
    const a = await makeClient({ name: "Acme" });
    const b = await makeClient({ name: "Beta" });
    const ta = await makeTicket(a.id);
    const tb = await makeTicket(b.id);
    const ca = expectOk(await createCharge(owner, { source: "ticket", sourceId: ta.id, provider: null }, deps()));
    const cb = expectOk(await createCharge(owner, { source: "ticket", sourceId: tb.id, provider: null }, deps()));
    expectOk(await cancelCharge(owner, cb.id, deps()));

    expect(expectOk(await listCharges(manager, { clientId: a.id }, deps())).map((r) => r.id)).toEqual([ca.id]);
    expect(expectOk(await listCharges(manager, { status: "canceled" }, deps())).map((r) => r.id)).toEqual([cb.id]);
    expect(expectOk(await listCharges(manager, {}, deps())).map((r) => r.id).sort()).toEqual([ca.id, cb.id].sort());
    expect(expectOk(await listCharges(manager, { clientId: "nope" }, deps()))).toEqual([]);
    const row = expectOk(await listCharges(manager, { clientId: a.id }, deps()))[0];
    expect(row).toMatchObject({ clientName: "Acme", amountCents: 1500_00, status: "pending", canAct: true, document: null });
    expect(row.payUrl.startsWith("https://painel.acme.com/pay/")).toBe(true);

    expect(expectOk(await chargeFor(manager, { source: "ticket", sourceId: ta.id }, deps()))?.id).toBe(ca.id);
    // Only canceled ones: none.
    expect(expectOk(await chargeFor(manager, { source: "ticket", sourceId: tb.id }, deps()))).toBeNull();
    expect(expectOk(await chargeFor(manager, { source: "support", sourceId: a.id }, deps()))).toBeNull();
  });

  it("finds one charge with the list's visibility: a manager does not see a quote's, a collaborator nothing", async () => {
    const client = await makeClient({ name: "Acme" });
    const ticket = await makeTicket(client.id);
    const t = expectOk(await createCharge(owner, { source: "ticket", sourceId: ticket.id, provider: null }, deps()));
    const quoteId = await sentQuote({ clientId: client.id, items: [item()] });
    const q = expectOk(await createCharge(owner, { source: "quote", sourceId: quoteId, provider: null }, deps()));
    const notFound = { ok: false, error: "notFound" };

    // The same row the list shows, for each viewer.
    const ownerList = expectOk(await listCharges(owner, {}, deps()));
    expect(expectOk(await getCharge(owner, q.id, deps()))).toEqual(ownerList.find((r) => r.id === q.id));
    expect(expectOk(await getCharge(owner, t.id, deps()))).toEqual(ownerList.find((r) => r.id === t.id));
    const managerList = expectOk(await listCharges(manager, {}, deps()));
    expect(expectOk(await getCharge(manager, t.id, deps()))).toEqual(managerList.find((r) => r.id === t.id));
    expect(expectOk(await getCharge(manager, t.id, deps()))).toMatchObject({ clientName: "Acme", canAct: true, source: "ticket" });

    // A quote's charge does not exist for a manager.
    expect(await getCharge(manager, q.id, deps())).toEqual(notFound);
    expect(await getCharge(collab, t.id, deps())).toEqual({ ok: false, error: "forbidden" });
    expect(await getCharge(owner, "nope", deps())).toEqual(notFound);
    expect(await getCharge(owner, "00000000-0000-4000-8000-000000000000", deps())).toEqual(notFound);
  });
});
