import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  authTokens,
  clientMemberships,
  clientUsers,
  clients,
  messages,
  quoteItems,
  quotes,
  sites,
  ticketAssignments,
  tickets,
  users,
  type Client,
  type ClientUser,
  type Db,
  type QuoteItemConfig,
  type User,
} from "@/lib/db";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import type { MailMessage, sendMail } from "@/lib/mail/send";
import { executeQuote } from "./quote-execute";
import { invitePortalUser } from "./portal-users";
import { saveQuote, sendQuote, type QuoteInput, type QuoteItemInput } from "./quotes";
import { openPortalTicket } from "./tickets";

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
const asPortal = (user: ClientUser, client: Client): PortalSession => ({ userType: "client", user, client, role: "admin" });
const item = (over: Partial<QuoteItemInput> = {}): QuoteItemInput => ({
  kind: "site_creation",
  title: "Website",
  amountCents: 1000_00,
  config: {},
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

/** Saves a quote and marks it as sent (no mail is recorded for the send). */
async function sentQuote(input: Omit<QuoteInput, "title"> & { title?: string }): Promise<string> {
  const saved = await saveQuote(owner, { title: "Proposal", ...input }, { db });
  if (!saved.ok) throw new Error(saved.error);
  const marked = await sendQuote(owner, saved.value.id, { db, send: (async () => ({ sent: false })) as unknown as typeof sendMail });
  if (!marked.ok) throw new Error(marked.error);
  return saved.value.id;
}

async function itemIdsOf(quoteId: string): Promise<string[]> {
  const rows = await db
    .select({ id: quoteItems.id })
    .from(quoteItems)
    .where(eq(quoteItems.quoteId, quoteId))
    .orderBy(asc(quoteItems.position));
  return rows.map((r) => r.id);
}

async function makeClient(values: Partial<typeof clients.$inferInsert> = {}): Promise<Client> {
  const [c] = await db.insert(clients).values({ name: "Acme", ...values }).returning();
  return c;
}

async function makeSite(clientId: string, name: string, includedInSupport = false): Promise<string> {
  const [s] = await db.insert(sites).values({ clientId, name, includedInSupport }).returning({ id: sites.id });
  return s.id;
}

function expectNoDeadlock(results: PromiseSettledResult<unknown>[]) {
  for (const r of results) {
    if (r.status === "rejected") {
      const e = r.reason as { code?: string; cause?: { code?: string } };
      expect(e.code ?? e.cause?.code).not.toBe("40P01");
    }
  }
}

describe("executeQuote", () => {
  it("execute creates the prospect client, its portal login and invite, sites, single tickets and the support plan, and logs each", async () => {
    await db.update(agency).set({ locale: "pt" });
    const quoteId = await sentQuote({
      clientId: null,
      prospectName: "Bia Doces",
      prospectEmail: "bia@doces.com",
      items: [
        item({ kind: "site_creation", title: "New website", amountCents: 1000_00, config: { newSite: { name: "Bia Doces", url: "https://biadoces.com" } } }),
        item({ kind: "maintenance", title: "Shop setup", amountCents: 0, config: {} }),
        item({
          kind: "support",
          title: "Monthly support",
          amountCents: 200_00,
          config: { hoursMode: "package", includedMinutes: 600, extraHourCents: 150_00, newSites: [{ name: "Blog" }] },
        }),
      ],
    });
    const ids = await itemIdsOf(quoteId);

    const res = await executeQuote(owner, quoteId, ids, { db, send });
    if (!res.ok) throw new Error(res.error);

    // The client, from the prospect.
    const [client] = await db.select().from(clients);
    expect(client).toMatchObject({
      name: "Bia Doces",
      email: "bia@doces.com",
      supportActive: true,
      supportMonthlyCents: 200_00,
      hoursMode: "package",
      includedMinutes: 600,
      extraHourCents: 150_00,
      generalTicketsEnabled: false,
    });

    // Its portal login: new, pending, in the agency's language, the company's admin, with an invite token.
    const [person] = await db.select().from(clientUsers);
    expect(person).toMatchObject({ name: "Bia Doces", email: "bia@doces.com", passwordHash: null, locale: "pt" });
    const [membership] = await db.select().from(clientMemberships);
    expect(membership).toMatchObject({ clientUserId: person.id, clientId: client.id, role: "admin" });
    const tokens = await db.select().from(authTokens).where(eq(authTokens.userId, person.id));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ purpose: "invite", userType: "client", usedAt: null });

    // The sites: two for the work items (not in support), one covered by the support.
    const siteRows = await db.select().from(sites).orderBy(asc(sites.createdAt), asc(sites.name));
    const byName = Object.fromEntries(siteRows.map((s) => [s.name, s]));
    expect(siteRows).toHaveLength(3);
    expect(byName["Bia Doces"]).toMatchObject({ clientId: client.id, url: "https://biadoces.com", includedInSupport: false });
    expect(byName["Shop setup"]).toMatchObject({ clientId: client.id, url: null, includedInSupport: false });
    expect(byName["Blog"]).toMatchObject({ clientId: client.id, includedInSupport: true });

    // Single tickets, numbered in order, by the owner, without assignee nor message.
    const ticketRows = await db.select().from(tickets).orderBy(asc(tickets.number));
    expect(ticketRows.map((t) => [t.number, t.title, t.type, t.valueCents, t.siteId])).toEqual([
      [1, "New website", "single", 1000_00, byName["Bia Doces"].id],
      [2, "Shop setup", "single", null, byName["Shop setup"].id],
    ]);
    for (const t of ticketRows) {
      expect(t).toMatchObject({ clientId: client.id, createdByType: "agency", createdById: owner.user.id, status: "open" });
    }
    expect(await db.select().from(ticketAssignments)).toHaveLength(0);
    expect(await db.select().from(messages)).toHaveLength(0);
    expect((await db.select({ n: agency.ticketCounter }).from(agency))[0].n).toBe(2);

    // The quote: executed, linked to the new client, every item executed, with the log.
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote.status).toBe("executed");
    expect(quote.executedAt).toBeInstanceOf(Date);
    expect(quote.clientId).toBe(client.id);
    const itemRows = await db.select().from(quoteItems).where(eq(quoteItems.quoteId, quoteId));
    expect(itemRows.every((i) => i.executed && i.clientApproved)).toBe(true);

    expect(res.value.log).toEqual([
      { action: "client", itemId: null, label: "Bia Doces", id: client.id },
      { action: "clientUser", itemId: null, label: "bia@doces.com", id: person.id },
      { action: "site", itemId: ids[0], label: "Bia Doces", id: byName["Bia Doces"].id },
      { action: "ticket", itemId: ids[0], label: "#1 New website", id: ticketRows[0].id },
      { action: "site", itemId: ids[1], label: "Shop setup", id: byName["Shop setup"].id },
      { action: "ticket", itemId: ids[1], label: "#2 Shop setup", id: ticketRows[1].id },
      { action: "support", itemId: ids[2], label: "Bia Doces", id: client.id },
      { action: "site", itemId: ids[2], label: "Blog", id: byName["Blog"].id },
    ]);
    expect(quote.executionLog).toEqual(res.value.log);

    // The invite: e-mailed in the agency's language, and the link is returned too.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("bia@doces.com");
    expect(sent[0].subject).toBe("Seu acesso ao painel de Studio Acme");
    expect(res.value.invite).toMatchObject({ name: "Bia Doces", email: "bia@doces.com", emailed: true });
    expect(res.value.invite?.link).toMatch(/^https:\/\/painel\.acme\.com\/set-password\/[0-9a-f]{64}$/);
    expect(sent[0].html).toContain(res.value.invite!.link);
  });

  it("a quote whose currency differs from the agency's is refused and creates nothing", async () => {
    const quoteId = await sentQuote({ clientId: null, prospectName: "Moeda", prospectEmail: "m@x.com", items: [item()] });
    await db.update(agency).set({ currency: "USD" }).where(eq(agency.id, 1));
    const res = await executeQuote(owner, quoteId, await itemIdsOf(quoteId), { db, send });
    expect(res).toEqual({ ok: false, error: "currencyChanged" });
    expect(await db.select().from(clients)).toHaveLength(0);
    expect(await db.select().from(tickets)).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote.status).toBe("sent");
  });

  it("executing twice creates everything once", async () => {
    for (let round = 0; round < 20; round++) {
      const quoteId = await sentQuote({
        clientId: null,
        prospectName: `Twice ${round}`,
        prospectEmail: `twice${round}@x.com`,
        items: [item({ title: `Site ${round}`, config: { newSite: { name: `twice${round}.com` } } }), item({ kind: "support", title: "Support", amountCents: 0 })],
      });
      const ids = await itemIdsOf(quoteId);
      const results = await Promise.allSettled([
        executeQuote(owner, quoteId, ids, { db, send }),
        executeQuote(owner, quoteId, ids, { db, send }),
      ]);
      expectNoDeadlock(results);
      const values = results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) }));
      expect(values.filter((v) => v.ok)).toHaveLength(1);
      expect(values.filter((v) => !v.ok)).toEqual([{ ok: false, error: "quoteLocked" }]);

      const made = await db.select().from(clients).where(eq(clients.name, `Twice ${round}`));
      expect(made).toHaveLength(1);
      expect(await db.select().from(sites).where(eq(sites.clientId, made[0].id))).toHaveLength(1);
      expect(await db.select().from(tickets).where(eq(tickets.clientId, made[0].id))).toHaveLength(1);
      expect(await db.select().from(clientUsers).where(eq(clientUsers.email, `twice${round}@x.com`))).toHaveLength(1);
    }
    // One invite per round, sent once.
    expect(sent).toHaveLength(20);
    const numbers = (await db.select({ n: tickets.number }).from(tickets).orderBy(asc(tickets.number))).map((r) => r.n);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("execute and a portal ticket opening never deadlock and get distinct numbers", async () => {
    const acme = await makeClient({ supportActive: true, generalTicketsEnabled: true });
    const siteId = await makeSite(acme.id, "acme.com", true);
    const [person] = await db.insert(clientUsers).values({ name: "Paula", email: "paula@acme.com", passwordHash: "hash" }).returning();
    await db.insert(clientMemberships).values({ clientUserId: person.id, clientId: acme.id, role: "admin" });
    const portal = asPortal(person, acme);

    for (let round = 0; round < 20; round++) {
      const existing = await sentQuote({
        clientId: acme.id,
        items: [
          item({ kind: "maintenance", title: `Fix ${round}`, config: { siteId } }),
          item({ kind: "support", title: "Support", amountCents: 100_00, config: { siteIds: [siteId] } }),
        ],
      });
      const prospect = await sentQuote({
        clientId: null,
        prospectName: `Lead ${round}`,
        prospectEmail: `lead${round}@x.com`,
        items: [item({ title: `Build ${round}` })],
      });
      const results = await Promise.allSettled([
        executeQuote(owner, existing, await itemIdsOf(existing), { db, send }),
        openPortalTicket(portal, { title: `Help ${round}`, siteId }, { db }),
        executeQuote(owner, prospect, await itemIdsOf(prospect), { db, send }),
      ]);
      expectNoDeadlock(results);
      for (const r of results) {
        expect(r.status).toBe("fulfilled");
        if (r.status === "fulfilled") expect(r.value.ok).toBe(true);
      }
    }
    const numbers = (await db.select({ n: tickets.number }).from(tickets).orderBy(asc(tickets.number))).map((r) => r.n);
    expect(numbers).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("execute never touches another client's sites", async () => {
    const acme = await makeClient({ name: "Acme" });
    const beta = await makeClient({ name: "Beta" });
    const acmeSite = await makeSite(acme.id, "acme.com");
    const betaSite = await makeSite(beta.id, "beta.com");

    // A config forged after the save (or left stale) points at Beta's site.
    const quoteId = await sentQuote({
      clientId: acme.id,
      items: [
        item({ kind: "maintenance", title: "Fix", config: { siteId: acmeSite } }),
        item({ kind: "support", title: "Support", amountCents: 0, config: { siteIds: [acmeSite] } }),
      ],
    });
    const ids = await itemIdsOf(quoteId);
    const forged: QuoteItemConfig[] = [{ siteId: betaSite }, { siteIds: [betaSite, acmeSite] }];
    for (const [i, config] of forged.entries()) {
      await db.update(quoteItems).set({ config }).where(eq(quoteItems.id, ids[i]));
    }

    const res = await executeQuote(owner, quoteId, ids, { db, send });
    if (!res.ok) throw new Error(res.error);

    const [betaRow] = await db.select().from(sites).where(eq(sites.id, betaSite));
    expect(betaRow.includedInSupport).toBe(false);
    expect(await db.select().from(tickets).where(eq(tickets.clientId, beta.id))).toHaveLength(0);
    expect(await db.select().from(tickets).where(eq(tickets.siteId, betaSite))).toHaveLength(0);
    // The maintenance ticket went to a new site of Acme instead; Acme's own site joined the support.
    const [ticket] = await db.select().from(tickets);
    expect(ticket.clientId).toBe(acme.id);
    const [ticketSite] = await db.select().from(sites).where(eq(sites.id, ticket.siteId!));
    expect(ticketSite).toMatchObject({ clientId: acme.id, name: "Fix", includedInSupport: false });
    const [acmeRow] = await db.select().from(sites).where(eq(sites.id, acmeSite));
    expect(acmeRow.includedInSupport).toBe(true);

    // The quote switched to another client after the sites were picked: the old client's sites stay untouched.
    const other = await sentQuote({
      clientId: acme.id,
      items: [item({ kind: "maintenance", title: "Again", config: { siteId: acmeSite } })],
    });
    await db.update(quotes).set({ clientId: beta.id }).where(eq(quotes.id, other));
    const again = await executeQuote(owner, other, await itemIdsOf(other), { db, send });
    if (!again.ok) throw new Error(again.error);
    expect(await db.select().from(tickets).where(eq(tickets.siteId, acmeSite))).toHaveLength(0);
    const betaTickets = await db.select().from(tickets).where(eq(tickets.clientId, beta.id));
    expect(betaTickets).toHaveLength(1);
    const [newBetaSite] = await db.select().from(sites).where(eq(sites.id, betaTickets[0].siteId!));
    expect(newBetaSite.clientId).toBe(beta.id);
  });

  it("a prospect with a known e-mail is linked without an invite", async () => {
    const other = await makeClient({ name: "Old Co" });
    const [known] = await db
      .insert(clientUsers)
      .values({ name: "Zed", email: "zed@x.com", passwordHash: null, locale: "es" })
      .returning();
    await db.insert(clientMemberships).values({ clientUserId: known.id, clientId: other.id, role: "admin" });
    // Its earlier invite link is pending.
    await db.insert(authTokens).values({
      tokenHash: "old",
      purpose: "invite",
      userType: "client",
      userId: known.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const quoteId = await sentQuote({ clientId: null, prospectName: "Zed Co", prospectEmail: "ZED@x.com", items: [item()] });
    const res = await executeQuote(owner, quoteId, await itemIdsOf(quoteId), { db, send });
    if (!res.ok) throw new Error(res.error);

    const [client] = await db.select().from(clients).where(eq(clients.name, "Zed Co"));
    expect(await db.select().from(clientUsers)).toHaveLength(1);
    const memberships = await db.select().from(clientMemberships).where(eq(clientMemberships.clientUserId, known.id));
    expect(memberships.map((m) => [m.clientId, m.role]).sort()).toEqual(
      [
        [other.id, "admin"],
        [client.id, "admin"],
      ].sort(),
    );
    expect(sent).toHaveLength(0);
    expect(res.value.invite).toBeNull();
    expect(res.value.log).toContainEqual({ action: "clientUser", itemId: null, label: "zed@x.com", id: known.id, note: "linked" });
    // No new invite token was issued.
    expect(await db.select().from(authTokens).where(eq(authTokens.userId, known.id))).toHaveLength(0);
  });

  it("an active login linked by execute is told after the commit; a pending one and a failed run send nothing", async () => {
    const other = await makeClient({ name: "Old Co" });
    const [active, pending] = await db
      .insert(clientUsers)
      .values([
        { name: "Ada", email: "ada@x.com", passwordHash: "x", locale: "en" },
        { name: "Pen", email: "pen@x.com", passwordHash: null, locale: "en" },
      ])
      .returning();
    await db.insert(clientMemberships).values([
      { clientUserId: active.id, clientId: other.id, role: "admin" },
      { clientUserId: pending.id, clientId: other.id, role: "collaborator" },
    ]);

    // A failed run (the agency currency changed) sends nothing and links nothing.
    const failing = await sentQuote({ clientId: null, prospectName: "Fail Co", prospectEmail: "ada@x.com", items: [item()] });
    await db.update(agency).set({ currency: "USD" }).where(eq(agency.id, 1));
    expect((await executeQuote(owner, failing, await itemIdsOf(failing), { db, send })).ok).toBe(false);
    await db.update(agency).set({ currency: "BRL" }).where(eq(agency.id, 1));
    expect(sent).toHaveLength(0);
    expect(await db.select().from(clientMemberships).where(eq(clientMemberships.clientUserId, active.id))).toHaveLength(1);

    const [res1, res2] = [
      await executeQuote(owner, failing, await itemIdsOf(failing), { db, send }),
      await (async () => {
        const q = await sentQuote({ clientId: null, prospectName: "Pen Co", prospectEmail: "pen@x.com", items: [item()] });
        return executeQuote(owner, q, await itemIdsOf(q), { db, send });
      })(),
    ];
    if (!res1.ok || !res2.ok) throw new Error("execute failed");
    expect(res1.value.invite).toBeNull();
    // Only the active login got the "linked" notice, naming the new company.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ada@x.com");
    expect(sent[0].subject + (sent[0].text ?? "")).toContain("Fail Co");
  });

  it("execute links the prospect's e-mail when another company invites it at the same moment", async () => {
    const other = await makeClient({ name: "Other" });
    for (let round = 0; round < 20; round++) {
      const email = `race${round}@x.com`;
      const quoteId = await sentQuote({ clientId: null, prospectName: `Race ${round}`, prospectEmail: email, items: [item()] });
      const results = await Promise.allSettled([
        executeQuote(owner, quoteId, await itemIdsOf(quoteId), { db, send }),
        invitePortalUser(owner, other.id, { name: "Inv", email, role: "collaborator" }, { db, send }),
      ]);
      expectNoDeadlock(results);
      const [executed] = results;
      expect(executed.status).toBe("fulfilled");
      if (executed.status === "fulfilled") expect(executed.value.ok).toBe(true);
      // One login for the e-mail, a member of the new client.
      const logins = await db.select().from(clientUsers).where(eq(clientUsers.email, email));
      expect(logins).toHaveLength(1);
      const [client] = await db.select().from(clients).where(eq(clients.name, `Race ${round}`));
      const member = await db
        .select()
        .from(clientMemberships)
        .where(and(eq(clientMemberships.clientUserId, logins[0].id), eq(clientMemberships.clientId, client.id)));
      expect(member).toHaveLength(1);
    }
  });

  it("the company's first login from execute is an admin", async () => {
    const quoteId = await sentQuote({ clientId: null, prospectName: "First", prospectEmail: "first@x.com", items: [item()] });
    const res = await executeQuote(owner, quoteId, await itemIdsOf(quoteId), { db, send });
    if (!res.ok) throw new Error(res.error);
    const [person] = await db.select().from(clientUsers).where(eq(clientUsers.email, "first@x.com"));
    const [membership] = await db.select().from(clientMemberships).where(eq(clientMemberships.clientUserId, person.id));
    expect(membership.role).toBe("admin");

    // A prospect without an e-mail becomes a client with no login at all.
    const bare = await sentQuote({ clientId: null, prospectName: "No Mail", items: [item()] });
    const done = await executeQuote(owner, bare, await itemIdsOf(bare), { db, send });
    if (!done.ok) throw new Error(done.error);
    const [noMail] = await db.select().from(clients).where(eq(clients.name, "No Mail"));
    expect(noMail.email).toBeNull();
    expect(await db.select().from(clientMemberships).where(eq(clientMemberships.clientId, noMail.id))).toHaveLength(0);
    expect(done.value.invite).toBeNull();

    // An existing client's quote never creates or invites a login.
    const acme = await makeClient({ name: "Acme", email: "hello@acme.com" });
    const existing = await sentQuote({ clientId: acme.id, items: [item()] });
    const ran = await executeQuote(owner, existing, await itemIdsOf(existing), { db, send });
    if (!ran.ok) throw new Error(ran.error);
    expect(await db.select().from(clientMemberships).where(eq(clientMemberships.clientId, acme.id))).toHaveLength(0);
    expect(ran.value.log.some((e) => e.action === "client" || e.action === "clientUser")).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("the support item replaces the client's plan with the item's hours mode", async () => {
    const acme = await makeClient({
      name: "Acme",
      supportActive: true,
      supportMonthlyCents: 50_00,
      generalTicketsEnabled: true,
      hoursMode: "package",
      includedMinutes: 600,
      extraHourCents: 100_00,
    });
    const covered = await makeSite(acme.id, "acme.com");
    const quoteId = await sentQuote({
      clientId: acme.id,
      items: [
        item({
          kind: "support",
          title: "Support",
          amountCents: 300_00,
          config: { hoursMode: "internal", siteIds: [covered], newSites: [{ name: "shop.acme.com", url: "https://shop.acme.com" }] },
        }),
      ],
    });
    const [supportId] = await itemIdsOf(quoteId);
    const res = await executeQuote(owner, quoteId, [supportId], { db, send });
    if (!res.ok) throw new Error(res.error);

    const [row] = await db.select().from(clients).where(eq(clients.id, acme.id));
    expect(row).toMatchObject({
      supportActive: true,
      supportMonthlyCents: 300_00,
      generalTicketsEnabled: true,
      hoursMode: "internal",
      includedMinutes: 0,
      extraHourCents: null,
    });
    const siteRows = await db.select().from(sites).where(eq(sites.clientId, acme.id));
    expect(siteRows.every((s) => s.includedInSupport)).toBe(true);
    expect(siteRows.map((s) => s.url).sort()).toEqual(["https://shop.acme.com", null].sort());
    // No ticket for a support item; the log says the plan was replaced.
    expect(await db.select().from(tickets)).toHaveLength(0);
    expect(res.value.log[0]).toEqual({ action: "support", itemId: supportId, label: "Acme", id: acme.id, note: "replaced" });

    // A free support item turns the support on without a monthly value and with the package mode.
    const beta = await makeClient({ name: "Beta" });
    const free = await sentQuote({
      clientId: beta.id,
      items: [item({ kind: "support", title: "Support", amountCents: 0, config: { hoursMode: "package", includedMinutes: 120, extraHourCents: null } })],
    });
    const freeRes = await executeQuote(owner, free, await itemIdsOf(free), { db, send });
    if (!freeRes.ok) throw new Error(freeRes.error);
    const [betaRow] = await db.select().from(clients).where(eq(clients.id, beta.id));
    expect(betaRow).toMatchObject({ supportActive: true, supportMonthlyCents: null, hoursMode: "package", includedMinutes: 120, extraHourCents: null });
    expect(freeRes.value.log[0]).toEqual({ action: "support", itemId: expect.any(String), label: "Beta", id: beta.id });
  });

  it("only sent or accepted quotes execute; unselected items stay unexecuted", async () => {
    const input = { clientId: null, prospectName: "Status", items: [item({ title: "A" }), item({ title: "B" }), item({ title: "C" })] };

    // Owner only.
    const q = await sentQuote(input);
    const qIds = await itemIdsOf(q);
    for (const actor of [manager, collab]) {
      expect(await executeQuote(actor, q, qIds, { db, send })).toEqual({ ok: false, error: "forbidden" });
    }
    // Missing or malformed quote.
    expect(await executeQuote(owner, "00000000-0000-4000-8000-000000000000", qIds, { db, send })).toEqual({ ok: false, error: "notFound" });
    expect(await executeQuote(owner, "nope", qIds, { db, send })).toEqual({ ok: false, error: "notFound" });
    // Nothing selected, or only items of another quote.
    const otherQuote = await sentQuote(input);
    expect(await executeQuote(owner, q, [], { db, send })).toEqual({ ok: false, error: "nothingSelected" });
    expect(await executeQuote(owner, q, await itemIdsOf(otherQuote), { db, send })).toEqual({ ok: false, error: "nothingSelected" });
    expect(await executeQuote(owner, q, ["junk"], { db, send })).toEqual({ ok: false, error: "nothingSelected" });

    // Draft and archived quotes are locked.
    const draft = await saveQuote(owner, { title: "Draft", ...input }, { db });
    if (!draft.ok) throw new Error(draft.error);
    expect(await executeQuote(owner, draft.value.id, await itemIdsOf(draft.value.id), { db, send })).toEqual({ ok: false, error: "quoteLocked" });
    await db.update(quotes).set({ status: "archived" }).where(eq(quotes.id, otherQuote));
    expect(await executeQuote(owner, otherQuote, await itemIdsOf(otherQuote), { db, send })).toEqual({ ok: false, error: "quoteLocked" });
    expect(await db.select().from(clients)).toHaveLength(0);
    expect(await db.select().from(tickets)).toHaveLength(0);

    // An accepted quote executes only the ticked items, even one the client did not approve.
    await db.update(quotes).set({ status: "accepted", acceptedAt: new Date() }).where(eq(quotes.id, q));
    await db.update(quoteItems).set({ clientApproved: true }).where(inArray(quoteItems.id, [qIds[0], qIds[1]]));
    const res = await executeQuote(owner, q, [qIds[1], qIds[2], qIds[1]], { db, send });
    if (!res.ok) throw new Error(res.error);
    const rows = await db.select().from(quoteItems).where(eq(quoteItems.quoteId, q)).orderBy(asc(quoteItems.position));
    expect(rows.map((r) => [r.title, r.executed, r.clientApproved])).toEqual([
      ["A", false, true],
      ["B", true, true],
      ["C", true, true],
    ]);
    expect((await db.select({ title: tickets.title }).from(tickets).orderBy(asc(tickets.number))).map((t) => t.title)).toEqual(["B", "C"]);
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, q));
    expect(quote.status).toBe("executed");

    // An executed quote is locked: the leftover item can never run.
    expect(await executeQuote(owner, q, [qIds[0]], { db, send })).toEqual({ ok: false, error: "quoteLocked" });
    expect(await db.select().from(tickets)).toHaveLength(2);
  });

  it("the invite e-mail goes out once, after commit", async () => {
    // The mail sender looks at the database: by then the execution must be committed.
    const seen: string[] = [];
    const checking = (async (m: MailMessage) => {
      const [row] = await db.select({ status: quotes.status }).from(quotes);
      seen.push(`${m.to}:${row.status}`);
      return { sent: false };
    }) as typeof sendMail;
    const quoteId = await sentQuote({ clientId: null, prospectName: "Late", prospectEmail: "late@x.com", items: [item()] });
    const res = await executeQuote(owner, quoteId, await itemIdsOf(quoteId), { db, send: checking });
    if (!res.ok) throw new Error(res.error);
    expect(seen).toEqual(["late@x.com:executed"]);
    // Without SMTP the link is returned for the screen.
    expect(res.value.invite).toMatchObject({ email: "late@x.com", emailed: false });
    expect(res.value.invite?.link).toMatch(/\/set-password\/[0-9a-f]{64}$/);

    // A failing transaction rolls everything back and sends nothing.
    await db.delete(quotes);
    await db.delete(clientMemberships);
    await db.delete(authTokens);
    await db.delete(clientUsers);
    await db.delete(sites);
    await db.delete(tickets);
    await db.delete(clients);
    await db.execute(sql`
      CREATE FUNCTION refuse_ticket() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$ LANGUAGE plpgsql;
    `);
    await db.execute(sql`CREATE TRIGGER refuse_ticket BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION refuse_ticket()`);
    const failing = await sentQuote({ clientId: null, prospectName: "Boom", prospectEmail: "boom@x.com", items: [item()] });
    await expect(executeQuote(owner, failing, await itemIdsOf(failing), { db, send })).rejects.toThrow();
    expect(sent).toHaveLength(0);
    expect(await db.select().from(clients)).toHaveLength(0);
    expect(await db.select().from(clientUsers)).toHaveLength(0);
    const [row] = await db.select().from(quotes).where(and(eq(quotes.id, failing)));
    expect(row.status).toBe("sent");
  });
});
