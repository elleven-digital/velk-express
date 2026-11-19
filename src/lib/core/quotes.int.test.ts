import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientMemberships,
  clientUsers,
  clients,
  quoteItems,
  quotes,
  sites,
  users,
  type Db,
  type User,
} from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import type { MailMessage, sendMail } from "@/lib/mail/send";
import { QUOTES_PER_PAGE, archiveQuote, deleteQuote, getQuote, listQuotes, saveQuote, sendQuote, type QuoteInput, type QuoteItemInput } from "./quotes";

// getConfig() is lazy: a database URL and a fixed public address.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let sent: MailMessage[];
let send: typeof sendMail;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
const item = (over: Partial<QuoteItemInput> = {}): QuoteItemInput => ({
  kind: "site_creation",
  title: "Website",
  amountCents: 1000_00,
  config: {},
  ...over,
});
const prospect = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  clientId: null,
  prospectName: "Bia",
  title: "Proposal",
  items: [item()],
  ...over,
});

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
  sent = [];
  send = (async (m: MailMessage) => {
    sent.push(m);
    return { sent: true };
  }) as typeof sendMail;
});

afterAll(async () => {
  await db?.$client.end();
});

async function save(input: QuoteInput): Promise<string> {
  const res = await saveQuote(owner, input, { db });
  if (!res.ok) throw new Error(res.error);
  return res.value.id;
}

async function makeClient(name: string, email: string | null = null): Promise<string> {
  const [c] = await db.insert(clients).values({ name, email }).returning({ id: clients.id });
  return c.id;
}

async function makeSite(clientId: string, name = "Site"): Promise<string> {
  const [s] = await db.insert(sites).values({ clientId, name }).returning({ id: sites.id });
  return s.id;
}

async function makeLogin(clientId: string, o: { email: string; role?: "admin" | "collaborator"; password?: boolean; locale?: string | null; at?: Date }) {
  const [u] = await db
    .insert(clientUsers)
    .values({ name: o.email.split("@")[0], email: o.email, passwordHash: o.password === false ? null : "hash", locale: o.locale ?? null })
    .returning();
  await db.insert(clientMemberships).values({ clientUserId: u.id, clientId, role: o.role ?? "admin", ...(o.at ? { createdAt: o.at } : {}) });
}

describe("quotes", () => {
  it("quotes are owner only", async () => {
    const id = await save(prospect());
    for (const actor of [manager, collab]) {
      expect(await saveQuote(actor, prospect(), { db })).toEqual({ ok: false, error: "forbidden" });
      expect(await saveQuote(actor, { ...prospect(), quoteId: id }, { db })).toEqual({ ok: false, error: "forbidden" });
      expect(await sendQuote(actor, id, { db, send })).toEqual({ ok: false, error: "forbidden" });
      expect(await archiveQuote(actor, id, { db })).toEqual({ ok: false, error: "forbidden" });
      expect(await deleteQuote(actor, id, { db })).toEqual({ ok: false, error: "forbidden" });
      expect(await listQuotes(actor, { db })).toEqual({ ok: false, error: "forbidden" });
      expect(await getQuote(actor, id, { db })).toEqual({ ok: false, error: "forbidden" });
    }
    const [row] = await db.select().from(quotes).where(eq(quotes.id, id));
    expect(row.status).toBe("draft");
    expect(sent).toHaveLength(0);
  });

  it("saveQuote validates title, items, client or prospect name and prospect e-mail", async () => {
    const run = async (input: QuoteInput) => {
      const r = await saveQuote(owner, input, { db });
      return r.ok ? "ok" : r.error;
    };
    expect(await run(prospect({ title: "  " }))).toBe("required");
    expect(await run(prospect({ title: "x".repeat(201) }))).toBe("tooLong");
    expect(await run(prospect({ notes: "x".repeat(10_001) }))).toBe("tooLong");
    expect(await run(prospect({ items: [] }))).toBe("quoteNeedsItems");
    expect(await run(prospect({ items: Array.from({ length: 51 }, () => item()) }))).toBe("tooLong");
    expect(await run(prospect({ items: [item({ description: "x".repeat(5001) })] }))).toBe("tooLong");
    expect(await run(prospect({ items: [item({ title: " " })] }))).toBe("required");
    expect(await run(prospect({ items: [item({ amountCents: -1 })] }))).toBe("required");
    expect(await run(prospect({ items: [item({ amountCents: 1.5 })] }))).toBe("required");
    expect(await run(prospect({ prospectName: "  " }))).toBe("quoteNeedsClient");
    expect(await run({ ...prospect(), clientId: "nope" })).toBe("quoteNeedsClient");
    expect(await run({ ...prospect(), clientId: "00000000-0000-4000-8000-000000000000" })).toBe("quoteNeedsClient");
    expect(await run(prospect({ prospectEmail: "not-an-email" }))).toBe("invalidEmail");
    expect(await run(prospect({ items: Array.from({ length: 50 }, () => item()) }))).toBe("ok");
    expect(await run(prospect({ prospectEmail: " Bia@Corp.COM " }))).toBe("ok");
    const [row] = await db.select().from(quotes).where(eq(quotes.prospectEmail, "bia@corp.com"));
    expect(row.status).toBe("draft");
    expect(row.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(row.createdById).toBe(owner.user.id);
  });

  it("saveQuote returns an error, never throws, on wrongly typed fields", async () => {
    const forged = (over: Record<string, unknown>) => ({ ...prospect(), ...over }) as unknown as QuoteInput;
    const badItem = (over: Record<string, unknown>) => forged({ items: [{ ...item(), ...over }] });
    for (const input of [
      forged({ title: 1 }),
      forged({ notes: 5 }),
      forged({ prospectName: {} }),
      forged({ prospectEmail: 7 }),
      forged({ items: "x" }),
      forged({ items: [null] }),
      forged({ quoteId: 3 }),
      forged({ clientId: 3 }),
      badItem({ title: {} }),
      badItem({ description: [] }),
      badItem({ amountCents: "10" }),
      badItem({ kind: "other" }),
    ]) {
      expect(await saveQuote(owner, input, { db })).toEqual({ ok: false, error: "required" });
    }
    expect(await saveQuote(owner, badItem({ config: "x" }), { db })).toEqual({ ok: false, error: "required" });
  });

  it("saveQuote derives monthly from the kind, normalises the support hours and trims text", async () => {
    const id = await save(
      prospect({
        title: "  Plan  ",
        notes: "  ",
        items: [
          item({ description: "  desc " }),
          item({ kind: "support", title: "Support", amountCents: 300_00, config: { hoursMode: "internal", includedMinutes: 600, extraHourCents: 50_00 } }),
          item({ kind: "support", title: "Package", config: { hoursMode: "package", includedMinutes: 600, extraHourCents: 50_00 } }),
        ],
      }),
    );
    const got = await getQuote(owner, id, { db });
    if (!got.ok) throw new Error(got.error);
    expect(got.value.quote.title).toBe("Plan");
    expect(got.value.quote.notes).toBeNull();
    expect(got.value.items.map((i) => [i.title, i.monthly, i.position])).toEqual([
      ["Website", false, 0],
      ["Support", true, 1],
      ["Package", true, 2],
    ]);
    expect(got.value.items[0].description).toBe("desc");
    expect(got.value.items[1].config).toEqual({ hoursMode: "internal", includedMinutes: 0, extraHourCents: null });
    expect(got.value.items[2].config).toEqual({ hoursMode: "package", includedMinutes: 600, extraHourCents: 50_00 });
    expect(got.value.totals).toEqual({ oneTimeCents: 1000_00, monthlyCents: 300_00 + 1000_00 });
    const bad = await saveQuote(owner, prospect({ items: [item({ kind: "support", config: { hoursMode: "package", includedMinutes: 100_001 } })] }), { db });
    expect(bad).toEqual({ ok: false, error: "required" });
  });

  it("a site of another client is refused", async () => {
    const a = await makeClient("A");
    const b = await makeClient("B");
    const siteA = await makeSite(a);
    const siteB = await makeSite(b);
    const withCfg = (config: QuoteItemInput["config"]): QuoteInput => ({ clientId: a, title: "P", items: [item({ kind: "maintenance", config })] });
    expect(await saveQuote(owner, withCfg({ siteId: siteB }), { db })).toEqual({ ok: false, error: "invalidSite" });
    expect(await saveQuote(owner, withCfg({ siteIds: [siteA, siteB] }), { db })).toEqual({ ok: false, error: "invalidSite" });
    expect(await saveQuote(owner, withCfg({ siteId: "00000000-0000-4000-8000-000000000000" }), { db })).toEqual({ ok: false, error: "invalidSite" });
    expect(await saveQuote(owner, withCfg({ siteId: "nope" }), { db })).toEqual({ ok: false, error: "invalidSite" });
    expect((await saveQuote(owner, withCfg({ siteId: siteA, siteIds: [siteA] }), { db })).ok).toBe(true);
    // A prospect has no sites at all.
    expect(await saveQuote(owner, prospect({ items: [item({ config: { siteId: siteA } })] }), { db })).toEqual({ ok: false, error: "invalidSite" });
    expect(await saveQuote(owner, prospect({ items: [item({ config: { siteIds: [siteA] } })] }), { db })).toEqual({ ok: false, error: "invalidSite" });
    expect((await saveQuote(owner, prospect({ items: [item({ config: { newSite: { name: "Shop", url: "shop.com" } } })] }), { db })).ok).toBe(true);
    // Switching an existing quote to another client rechecks the sites against the new one.
    const id = await save(withCfg({ siteId: siteA }));
    expect(await saveQuote(owner, { ...withCfg({ siteId: siteA }), quoteId: id, clientId: b }, { db })).toEqual({ ok: false, error: "invalidSite" });
    const [still] = await db.select().from(quotes).where(eq(quotes.id, id));
    expect(still.clientId).toBe(a);
  });

  it("editing replaces items in one transaction and only in draft or sent", async () => {
    const id = await save(prospect({ items: [item({ title: "One" }), item({ title: "Two" })] }));
    const before = await db.select().from(quoteItems).where(eq(quoteItems.quoteId, id));
    expect(before).toHaveLength(2);

    // A failing edit changes nothing: the items stay.
    const failed = await saveQuote(owner, { ...prospect({ items: [item({ title: "Three" }), item({ amountCents: -5 })] }), quoteId: id }, { db });
    expect(failed.ok).toBe(false);
    expect((await db.select().from(quoteItems).where(eq(quoteItems.quoteId, id))).map((i) => i.title).sort()).toEqual(["One", "Two"]);

    // A failure after the first writes (unknown client) rolls everything back too.
    const rolledBack = await saveQuote(owner, { ...prospect({ title: "Renamed" }), quoteId: id, clientId: "00000000-0000-4000-8000-000000000000" }, { db });
    expect(rolledBack).toEqual({ ok: false, error: "quoteNeedsClient" });
    expect((await db.select().from(quotes).where(eq(quotes.id, id)))[0].title).toBe("Proposal");

    const edited = await saveQuote(owner, { ...prospect({ title: "Edited", items: [item({ title: "Three" })] }), quoteId: id }, { db });
    expect(edited).toEqual({ ok: true, value: { id } });
    const after = await db.select().from(quoteItems).where(eq(quoteItems.quoteId, id));
    expect(after.map((i) => i.title)).toEqual(["Three"]);
    const [q] = await db.select().from(quotes).where(eq(quotes.id, id));
    expect(q.title).toBe("Edited");
    expect(q.updatedAt.getTime()).toBeGreaterThan(q.createdAt.getTime() - 1);

    expect((await sendQuote(owner, id, { db, send })).ok).toBe(true);
    expect((await saveQuote(owner, { ...prospect(), quoteId: id }, { db })).ok).toBe(true);

    for (const status of ["accepted", "executed", "archived"] as const) {
      await db.update(quotes).set({ status }).where(eq(quotes.id, id));
      // an executed quote says so; the others are just locked
      const error = status === "executed" ? "quoteExecuted" : "quoteLocked";
      expect(await saveQuote(owner, { ...prospect({ title: "Nope" }), quoteId: id }, { db })).toEqual({ ok: false, error });
    }
    expect((await db.select().from(quotes).where(eq(quotes.id, id)))[0].title).toBe("Proposal");
    expect(await saveQuote(owner, { ...prospect(), quoteId: "00000000-0000-4000-8000-000000000000" }, { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("switching a quote between client and prospect wipes the other side", async () => {
    const c = await makeClient("A");
    const id = await save(prospect({ prospectEmail: "bia@x.com" }));
    expect((await saveQuote(owner, { quoteId: id, clientId: c, title: "P", prospectName: "Ignored", items: [item()] }, { db })).ok).toBe(true);
    const [q] = await db.select().from(quotes).where(eq(quotes.id, id));
    expect([q.clientId, q.prospectName, q.prospectEmail]).toEqual([c, null, null]);
  });

  it("the quote keeps the currency it was created with", async () => {
    const id = await save(prospect());
    await db.update(agency).set({ currency: "USD" });
    expect((await saveQuote(owner, { ...prospect({ title: "Edited" }), quoteId: id }, { db })).ok).toBe(true);
    expect((await db.select().from(quotes).where(eq(quotes.id, id)))[0].currency).toBe("BRL");
    const other = await save(prospect());
    expect((await db.select().from(quotes).where(eq(quotes.id, other)))[0].currency).toBe("USD");
  });

  it("sendQuote e-mails the client, else the first active portal admin, else nobody, in the recipient's language", async () => {
    // Client with an e-mail: goes there, in the agency's language.
    const withMail = await makeClient("Loja", "loja@x.com");
    const q1 = await save({ clientId: withMail, title: "Site novo", items: [item()] });
    const r1 = await sendQuote(owner, q1, { db, send });
    expect(r1).toEqual({ ok: true, value: { emailedTo: "loja@x.com" } });
    expect(sent[0].to).toBe("loja@x.com");
    expect(sent[0].subject).toBe("Proposal: Site novo — Studio Acme");
    const [row1] = await db.select().from(quotes).where(eq(quotes.id, q1));
    expect(row1.status).toBe("sent");
    expect(sent[0].text).toContain(`https://painel.acme.com/q/${row1.token}`);

    // No client e-mail: the oldest active admin (not a collaborator, not a pending invite), in their language.
    const noMail = await makeClient("Sem email");
    await makeLogin(noMail, { email: "collab@x.com", role: "collaborator", at: new Date("2026-01-01") });
    await makeLogin(noMail, { email: "pending@x.com", role: "admin", password: false, at: new Date("2026-01-02") });
    await makeLogin(noMail, { email: "late@x.com", role: "admin", locale: "es", at: new Date("2026-03-01") });
    await makeLogin(noMail, { email: "first@x.com", role: "admin", locale: "pt", at: new Date("2026-02-01") });
    const q2 = await save({ clientId: noMail, title: "Site", items: [item()] });
    expect(await sendQuote(owner, q2, { db, send })).toEqual({ ok: true, value: { emailedTo: "first@x.com" } });
    expect(sent[1].to).toBe("first@x.com");
    expect(sent[1].subject).toBe("Proposta: Site — Studio Acme");

    // A client e-mail that is also a portal login uses that login's language.
    const both = await makeClient("Both", "both@x.com");
    await makeLogin(both, { email: "both@x.com", locale: "es" });
    const q3 = await save({ clientId: both, title: "T", items: [item()] });
    await sendQuote(owner, q3, { db, send });
    expect(sent[2].subject).toBe("Propuesta: T — Studio Acme");

    // Nobody to write to: still sent, nothing e-mailed.
    const nobody = await makeClient("Nobody");
    await makeLogin(nobody, { email: "p@x.com", password: false });
    const q4 = await save({ clientId: nobody, title: "T", items: [item()] });
    expect(await sendQuote(owner, q4, { db, send })).toEqual({ ok: true, value: { emailedTo: null } });
    expect((await db.select().from(quotes).where(eq(quotes.id, q4)))[0].status).toBe("sent");
    expect(sent).toHaveLength(3);

    // A prospect with an e-mail gets it in the agency's language; without one nothing goes out.
    const q5 = await save(prospect({ prospectEmail: "bia@corp.com" }));
    expect(await sendQuote(owner, q5, { db, send })).toEqual({ ok: true, value: { emailedTo: "bia@corp.com" } });
    expect(sent[3].subject).toBe("Proposal: Proposal — Studio Acme");
    const q6 = await save(prospect());
    expect(await sendQuote(owner, q6, { db, send })).toEqual({ ok: true, value: { emailedTo: null } });
    expect(sent).toHaveLength(4);
  });

  it("sendQuote keeps the first sent date, allows a resend, reports a mail that did not go and refuses other statuses", async () => {
    const id = await save(prospect({ prospectEmail: "bia@corp.com" }));
    await sendQuote(owner, id, { db, send });
    const [first] = await db.select().from(quotes).where(eq(quotes.id, id));
    expect(first.sentAt).not.toBeNull();
    await sendQuote(owner, id, { db, send });
    const [again] = await db.select().from(quotes).where(eq(quotes.id, id));
    expect(again.sentAt).toEqual(first.sentAt);
    expect(sent).toHaveLength(2);

    // Without SMTP (or when the transport fails) the quote is sent and nobody is reported.
    const unsent = (async () => ({ sent: false })) as unknown as typeof sendMail;
    expect(await sendQuote(owner, id, { db, send: unsent })).toEqual({ ok: true, value: { emailedTo: null } });
    const throwing = (async () => {
      throw new Error("boom");
    }) as unknown as typeof sendMail;
    expect(await sendQuote(owner, id, { db, send: throwing })).toEqual({ ok: true, value: { emailedTo: null } });

    for (const status of ["accepted", "executed", "archived"] as const) {
      await db.update(quotes).set({ status }).where(eq(quotes.id, id));
      const error = status === "executed" ? "quoteExecuted" : "quoteLocked";
      expect(await sendQuote(owner, id, { db, send })).toEqual({ ok: false, error });
    }
    expect(await sendQuote(owner, "00000000-0000-4000-8000-000000000000", { db, send })).toEqual({ ok: false, error: "notFound" });
    expect(await sendQuote(owner, "nope", { db, send })).toEqual({ ok: false, error: "notFound" });
  });

  it("deleteQuote only deletes drafts", async () => {
    const id = await save(prospect());
    expect(await deleteQuote(owner, id, { db })).toEqual({ ok: true, value: undefined });
    expect(await db.select().from(quotes)).toHaveLength(0);
    expect(await db.select().from(quoteItems)).toHaveLength(0);
    expect(await deleteQuote(owner, id, { db })).toEqual({ ok: false, error: "notFound" });
    for (const status of ["sent", "accepted", "executed", "archived"] as const) {
      const q = await save(prospect());
      await db.update(quotes).set({ status }).where(eq(quotes.id, q));
      expect(await deleteQuote(owner, q, { db })).toEqual({ ok: false, error: status === "executed" ? "quoteExecuted" : "quoteLocked" });
      expect(await db.select().from(quotes).where(eq(quotes.id, q))).toHaveLength(1);
    }
  });

  it("archiveQuote refuses executed quotes", async () => {
    const id = await save(prospect());
    expect(await archiveQuote(owner, id, { db })).toEqual({ ok: true, value: { changed: true } });
    expect((await db.select().from(quotes).where(eq(quotes.id, id)))[0].status).toBe("archived");
    expect(await archiveQuote(owner, id, { db })).toEqual({ ok: true, value: { changed: false } });
    for (const status of ["draft", "sent", "accepted"] as const) {
      const q = await save(prospect());
      await db.update(quotes).set({ status }).where(eq(quotes.id, q));
      expect(await archiveQuote(owner, q, { db })).toEqual({ ok: true, value: { changed: true } });
    }
    const done = await save(prospect());
    await db.update(quotes).set({ status: "executed" }).where(eq(quotes.id, done));
    expect(await archiveQuote(owner, done, { db })).toEqual({ ok: false, error: "quoteExecuted" });
    expect((await db.select().from(quotes).where(eq(quotes.id, done)))[0].status).toBe("executed");
    expect(await archiveQuote(owner, "00000000-0000-4000-8000-000000000000", { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("listQuotes returns the rows with client name and totals; getQuote adds the client's sites", async () => {
    const c = await makeClient("Loja");
    const s1 = await makeSite(c, "Main");
    await makeSite(c, "Blog");
    const a = await save({ clientId: c, title: "A", items: [item({ amountCents: 500_00 }), item({ kind: "support", title: "S", amountCents: 80_00 })] });
    await save(prospect({ title: "B", items: [item({ amountCents: 10_00 })] }));
    const list = await listQuotes(owner, { db });
    if (!list.ok) throw new Error(list.error);
    expect(list.value.total).toBe(2);
    expect(list.value.rows).toHaveLength(2);
    const rowA = list.value.rows.find((q) => q.id === a)!;
    expect([rowA.clientName, rowA.oneTimeCents, rowA.monthlyCents]).toEqual(["Loja", 500_00, 80_00]);
    const rowB = list.value.rows.find((q) => q.id !== a)!;
    expect([rowB.clientName, rowB.prospectName, rowB.oneTimeCents, rowB.monthlyCents]).toEqual([null, "Bia", 10_00, 0]);

    const got = await getQuote(owner, a, { db });
    if (!got.ok) throw new Error(got.error);
    expect(got.value.client).toEqual({ id: c, name: "Loja" });
    expect(got.value.sites.map((s) => s.name).sort()).toEqual(["Blog", "Main"]);
    expect(got.value.sites.some((s) => s.id === s1)).toBe(true);
    expect(await getQuote(owner, "nope", { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("listQuotes pages at 50, newest first, with the total", async () => {
    const created = new Date("2026-01-01T00:00:00Z");
    await db.insert(quotes).values(
      Array.from({ length: QUOTES_PER_PAGE + 3 }, (_, n) => ({
        title: `Q${n}`,
        token: `tok-${n}`,
        currency: "BRL",
        prospectName: "Bia",
        createdAt: new Date(created.getTime() + n * 60_000),
      })),
    );
    const first = await listQuotes(owner, { db });
    if (!first.ok) throw new Error(first.error);
    expect(first.value.total).toBe(QUOTES_PER_PAGE + 3);
    expect(first.value.rows).toHaveLength(QUOTES_PER_PAGE);
    expect(first.value.rows[0].title).toBe(`Q${QUOTES_PER_PAGE + 2}`);
    const second = await listQuotes(owner, { db }, 2);
    if (!second.ok) throw new Error(second.error);
    expect(second.value.rows.map((r) => r.title)).toEqual(["Q2", "Q1", "Q0"]);
    // a page that makes no sense is the first one
    const odd = await listQuotes(owner, { db }, -4);
    if (!odd.ok) throw new Error(odd.error);
    expect(odd.value.rows[0].title).toBe(`Q${QUOTES_PER_PAGE + 2}`);
  });

  it("a quote whose saved site was deleted cannot be saved as it is: the site must be picked again", async () => {
    const c = await makeClient("Loja");
    const site = await makeSite(c, "Gone soon");
    const id = await save({ clientId: c, title: "Maint", items: [item({ kind: "maintenance", config: { siteId: site } })] });
    await db.delete(sites).where(eq(sites.id, site));
    const got = await getQuote(owner, id, { db });
    if (!got.ok) throw new Error(got.error);
    // the item still points at the deleted site and no listed site matches it
    expect(got.value.items[0].config.siteId).toBe(site);
    expect(got.value.sites.some((s) => s.id === site)).toBe(false);
    expect(await saveQuote(owner, { clientId: c, title: "Maint", items: [item({ kind: "maintenance", config: { siteId: site } })], quoteId: id }, { db })).toEqual({
      ok: false,
      error: "invalidSite",
    });
    // picking an existing site (or a new one) saves
    const other = await makeSite(c, "Other");
    expect((await saveQuote(owner, { clientId: c, title: "Maint", items: [item({ kind: "maintenance", config: { siteId: other } })], quoteId: id }, { db })).ok).toBe(true);
  });
});
