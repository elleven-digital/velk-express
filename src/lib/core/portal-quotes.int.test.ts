import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import {
  PORTAL_COOKIE,
  createSession,
  resolvePortalSession,
  switchActiveCompany,
  type CookieStore,
  type PortalSession,
} from "@/lib/auth/session";
import {
  agency,
  clientMemberships,
  clientUsers,
  clients,
  quoteItems,
  quotes,
  type Client,
  type ClientRole,
  type ClientUser,
  type Db,
  type QuoteStatus,
} from "@/lib/db";
import { getPortalHome } from "./portal-home";
import { PORTAL_QUOTES_PER_PAGE, countPortalQuotes, countSentPortalQuotes, listPortalQuotes } from "./portal-quotes";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

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

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  [A, B] = await db.insert(clients).values([{ name: "Alpha" }, { name: "Beta" }]).returning();
  [boss, helper] = await db
    .insert(clientUsers)
    .values([
      { name: "Boss", email: "boss@x.com", passwordHash: "x" },
      { name: "Helper", email: "helper@x.com", passwordHash: "x" },
    ])
    .returning();
  await db.insert(clientMemberships).values([
    { clientUserId: boss.id, clientId: A.id, role: "admin" },
    { clientUserId: helper.id, clientId: A.id, role: "collaborator" },
  ]);
});

afterAll(async () => {
  await db?.$client.end();
});

async function makeQuote(clientId: string | null, status: QuoteStatus, title: string, sentAt: Date | null = null) {
  const [quote] = await db
    .insert(quotes)
    .values({
      clientId,
      title,
      status,
      sentAt,
      token: `tok-${Math.random().toString(36).slice(2)}`,
      currency: "USD",
      prospectEmail: "secret@x.com",
    })
    .returning();
  await db.insert(quoteItems).values([
    { quoteId: quote.id, kind: "site_creation", title: "Site", amountCents: 1000_00, monthly: false, position: 0 },
    { quoteId: quote.id, kind: "support", title: "Support", amountCents: 200_00, monthly: true, position: 1 },
  ]);
  return quote;
}

describe("portal quotes", () => {
  it("portal quotes are admin only and the session company's", async () => {
    await makeQuote(A.id, "sent", "Mine");
    await makeQuote(B.id, "sent", "Other company");
    await makeQuote(null, "sent", "Prospect");

    const res = await listPortalQuotes(asPortal(A, boss, "admin"), { db });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((r) => r.title)).toEqual(["Mine"]);
    expect(res.value[0]).toMatchObject({ status: "sent", currency: "USD", oneTimeCents: 1000_00, monthlyCents: 200_00 });
    expect(res.value[0].token).toBeTruthy();
    // nothing about the prospect or the quote's inside
    expect(JSON.stringify(res.value)).not.toContain("secret@x.com");

    const denied = await listPortalQuotes(asPortal(A, helper, "collaborator"), { db });
    expect(denied).toEqual({ ok: false, error: "forbidden" });
    // a forged role in the session is not enough: the membership is re-read
    const forged = await listPortalQuotes(asPortal(A, helper, "admin"), { db });
    expect(forged).toEqual({ ok: false, error: "forbidden" });
    expect(await countSentPortalQuotes(asPortal(A, helper, "collaborator"), { db })).toBe(0);
    expect(await countSentPortalQuotes(asPortal(A, boss, "admin"), { db })).toBe(1);
  });

  it("drafts and archived quotes never reach the portal", async () => {
    await makeQuote(A.id, "draft", "Draft");
    await makeQuote(A.id, "archived", "Archived");
    await makeQuote(A.id, "sent", "Sent");
    await makeQuote(A.id, "accepted", "Accepted");
    await makeQuote(A.id, "executed", "Executed");

    const res = await listPortalQuotes(asPortal(A, boss, "admin"), { db });
    expect(res.ok && res.value.map((r) => r.title).sort()).toEqual(["Accepted", "Executed", "Sent"]);
    const home = await getPortalHome(asPortal(A, boss, "admin"), db);
    expect(home.proposals.map((p) => p.title)).toEqual(["Sent"]);
  });

  it("totals of an accepted or executed quote count only approved or executed items", async () => {
    const accepted = await makeQuote(A.id, "accepted", "Accepted", new Date());
    const executed = await makeQuote(A.id, "executed", "Executed", new Date());
    const sentOne = await makeQuote(A.id, "sent", "Sent", new Date());
    const [first] = await db.select().from(quoteItems).where(eq(quoteItems.quoteId, accepted.id)).orderBy(quoteItems.position);
    await db.update(quoteItems).set({ clientApproved: true }).where(eq(quoteItems.id, first.id));
    await db.update(quoteItems).set({ executed: true }).where(eq(quoteItems.quoteId, executed.id));
    const res = await listPortalQuotes(asPortal(A, boss, "admin"), { db });
    if (!res.ok) throw new Error(res.error);
    const by = (id: string) => res.value.find((r) => r.id === id)!;
    expect([by(accepted.id).oneTimeCents, by(accepted.id).monthlyCents]).toEqual([1000_00, 0]);
    expect([by(executed.id).oneTimeCents, by(executed.id).monthlyCents]).toEqual([1000_00, 200_00]);
    expect([by(sentOne.id).oneTimeCents, by(sentOne.id).monthlyCents]).toEqual([1000_00, 200_00]);
  });

  it("a portal collaborator gets no proposal tasks", async () => {
    await makeQuote(A.id, "sent", "Sent");
    const helperHome = await getPortalHome(asPortal(A, helper, "collaborator"), db);
    expect(helperHome.proposals).toEqual([]);
    const bossHome = await getPortalHome(asPortal(A, boss, "admin"), db);
    expect(bossHome.proposals).toHaveLength(1);
  });

  it("proposal tasks come newest sent first", async () => {
    await makeQuote(A.id, "sent", "Old", new Date("2026-01-01"));
    await makeQuote(A.id, "sent", "New", new Date("2026-03-01"));
    const home = await getPortalHome(asPortal(A, boss, "admin"), db);
    expect(home.proposals.map((p) => p.title)).toEqual(["New", "Old"]);
  });

  it("portal quotes follow the role of the active company", async () => {
    // Pat is admin in A and a collaborator in B; the session decides which one counts.
    const [pat] = await db.insert(clientUsers).values({ name: "Pat", email: "pat@x.com", passwordHash: "x" }).returning();
    await db.insert(clientMemberships).values([
      { clientUserId: pat.id, clientId: A.id, role: "admin" },
      { clientUserId: pat.id, clientId: B.id, role: "collaborator" },
    ]);
    await makeQuote(A.id, "sent", "In Alpha");
    await makeQuote(B.id, "sent", "In Beta");

    const jar = new Map<string, string>();
    const store: CookieStore = {
      get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
      set: (name, value) => void jar.set(name, value),
      delete: (name) => void jar.delete(name),
    };
    await createSession("client", pat.id, { store, db, secure: false });
    const token = store.get(PORTAL_COOKIE)!.value;

    const inA = await resolvePortalSession(token, db);
    expect(inA?.client.id).toBe(A.id);
    const asAdmin = await listPortalQuotes(inA!, { db });
    expect(asAdmin.ok && asAdmin.value.map((r) => r.title)).toEqual(["In Alpha"]);
    expect(await countSentPortalQuotes(inA!, { db })).toBe(1);

    expect(await switchActiveCompany(B.id, { store, db })).toEqual({ ok: true, value: undefined });
    const inB = await resolvePortalSession(token, db);
    expect(inB?.client.id).toBe(B.id);
    expect(await listPortalQuotes(inB!, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await countSentPortalQuotes(inB!, { db })).toBe(0);
    const home = await getPortalHome(inB!, db);
    expect(home.proposals).toEqual([]);
  });

  it("the list pages at 50, newest first, and the count covers every visible quote", async () => {
    const base = new Date("2026-02-01T00:00:00Z").getTime();
    await db.insert(quotes).values(
      Array.from({ length: PORTAL_QUOTES_PER_PAGE + 2 }, (_, n) => ({
        clientId: A.id,
        title: `P${n}`,
        status: "sent" as const,
        sentAt: new Date(base + n * 60_000),
        token: `tok-page-${n}`,
        currency: "USD",
      })),
    );
    await makeQuote(A.id, "draft", "Draft");
    const boss1 = asPortal(A, boss, "admin");
    expect(await countPortalQuotes(boss1, { db })).toBe(PORTAL_QUOTES_PER_PAGE + 2);
    expect(await countPortalQuotes(asPortal(A, helper, "collaborator"), { db })).toBe(0);

    const first = await listPortalQuotes(boss1, { db });
    if (!first.ok) throw new Error(first.error);
    expect(first.value).toHaveLength(PORTAL_QUOTES_PER_PAGE);
    expect(first.value[0].title).toBe(`P${PORTAL_QUOTES_PER_PAGE + 1}`);
    const second = await listPortalQuotes(boss1, { db }, { page: 2 });
    if (!second.ok) throw new Error(second.error);
    expect(second.value.map((r) => r.title)).toEqual(["P1", "P0"]);
  });
});
