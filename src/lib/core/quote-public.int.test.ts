import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import { agency, clients, quoteItems, quotes, users, type Db, type Quote, type QuoteStatus } from "@/lib/db";
import type { MailMessage, sendMail } from "@/lib/mail/send";
import { approveQuote, getPublicQuote } from "./quote-public";

/** Collects what approveQuote schedules, so a test can run it when it wants. */
let scheduled: (() => Promise<void>)[];
const schedule = (task: () => Promise<void>) => void scheduled.push(task);
const runScheduled = async () => {
  for (const task of scheduled.splice(0)) await task();
};

// getConfig() is lazy: a database URL and a fixed public address.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";

let db: Db;
let sent: MailMessage[];
let send: typeof sendMail;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  sent = [];
  scheduled = [];
  send = (async (m: MailMessage) => {
    sent.push(m);
    return { sent: true };
  }) as typeof sendMail;
});

afterAll(async () => {
  await db?.$client.end();
});

/** A quote with three items (the second is monthly), in the given status. */
async function makeQuote(
  status: QuoteStatus,
  over: Partial<typeof quotes.$inferInsert> = {},
): Promise<{ quote: Quote; itemIds: string[] }> {
  const [quote] = await db
    .insert(quotes)
    .values({
      title: "New site",
      status,
      token: `tok-${Math.random().toString(36).slice(2)}`,
      currency: "BRL",
      prospectName: "Bia",
      prospectEmail: "bia@secret.com",
      executionLog: [{ action: "site", itemId: null, label: "Secret site", id: "x" }],
      ...over,
    })
    .returning();
  const rows = await db
    .insert(quoteItems)
    .values([
      { quoteId: quote.id, kind: "site_creation", title: "Website", amountCents: 1000_00, monthly: false, position: 0, config: { newSite: { name: "Hidden" } } },
      { quoteId: quote.id, kind: "support", title: "Support", amountCents: 200_00, monthly: true, position: 1, config: { hoursMode: "off" } },
      { quoteId: quote.id, kind: "maintenance", title: "Setup", amountCents: 300_00, monthly: false, position: 2, config: {} },
    ])
    .returning({ id: quoteItems.id, position: quoteItems.position });
  return { quote, itemIds: rows.sort((a, b) => a.position - b.position).map((r) => r.id) };
}

async function approvedFlags(quoteId: string): Promise<boolean[]> {
  const rows = await db.select().from(quoteItems).where(eq(quoteItems.quoteId, quoteId)).orderBy(quoteItems.position);
  return rows.map((r) => r.clientApproved);
}

async function statusOf(quoteId: string) {
  const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
  return row;
}

describe("getPublicQuote", () => {
  it("draft and archived quotes are not found by token", async () => {
    const draft = await makeQuote("draft");
    const archived = await makeQuote("archived");
    expect(await getPublicQuote(draft.quote.token, { db })).toBeNull();
    expect(await getPublicQuote(archived.quote.token, { db })).toBeNull();
    expect(await getPublicQuote("nope", { db })).toBeNull();
    const live = await makeQuote("sent");
    expect(await getPublicQuote(live.quote.token, { db })).not.toBeNull();
  });

  it("the public view exposes no prospect e-mail, config or log", async () => {
    const { quote } = await makeQuote("sent");
    const view = await getPublicQuote(quote.token, { db });
    expect(view).not.toBeNull();
    expect(Object.keys(view!).sort()).toEqual(
      ["acceptedAt", "agencyName", "charge", "currency", "forName", "items", "notes", "status", "title", "totals"].sort(),
    );
    for (const it of view!.items) {
      expect(Object.keys(it).sort()).toEqual(
        ["amountCents", "clientApproved", "description", "id", "kind", "monthly", "title"].sort(),
      );
    }
    expect(JSON.stringify(view)).not.toMatch(/bia@secret|Hidden|Secret site|clientId|tok-/);
    expect(view!.forName).toBe("Bia");
    expect(view!.agencyName).toBe("Studio Acme");
    expect(view!.totals).toEqual({ oneTimeCents: 1300_00, monthlyCents: 200_00 });
    expect(view!.items.map((i) => i.title)).toEqual(["Website", "Support", "Setup"]);
  });

  it("totals count only the approved items once the quote is accepted", async () => {
    const { quote, itemIds } = await makeQuote("accepted");
    await db.update(quoteItems).set({ clientApproved: true }).where(eq(quoteItems.id, itemIds[1]));
    const view = await getPublicQuote(quote.token, { db });
    expect(view!.totals).toEqual({ oneTimeCents: 0, monthlyCents: 200_00 });
    const sentView = await getPublicQuote((await makeQuote("sent")).quote.token, { db });
    expect(sentView!.totals).toEqual({ oneTimeCents: 1300_00, monthlyCents: 200_00 });
  });

  it("names the client when the quote is for one", async () => {
    const [client] = await db.insert(clients).values({ name: "Casa Verde" }).returning();
    const { quote } = await makeQuote("sent", { clientId: client.id, prospectName: null, prospectEmail: null });
    expect((await getPublicQuote(quote.token, { db }))!.forName).toBe("Casa Verde");
  });
});

describe("approveQuote", () => {
  it("approves the chosen items and accepts the quote", async () => {
    const { quote, itemIds } = await makeQuote("sent");
    const res = await approveQuote(quote.token, [itemIds[0], itemIds[2]], { db, send, schedule });
    expect(res.ok).toBe(true);
    expect(await approvedFlags(quote.id)).toEqual([true, false, true]);
    const row = await statusOf(quote.id);
    expect(row.status).toBe("accepted");
    expect(row.acceptedAt).toBeInstanceOf(Date);
  });

  it("approving twice keeps the first decision", async () => {
    const { quote, itemIds } = await makeQuote("sent");
    await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner", passwordHash: "h" });
    expect((await approveQuote(quote.token, [itemIds[0]], { db, send, schedule })).ok).toBe(true);
    const first = await statusOf(quote.id);
    const again = await approveQuote(quote.token, itemIds, { db, send, schedule });
    expect(again).toEqual({ ok: false, error: "alreadyDecided" });
    expect(await approvedFlags(quote.id)).toEqual([true, false, false]);
    expect((await statusOf(quote.id)).acceptedAt).toEqual(first.acceptedAt);
    await runScheduled();
    expect(sent).toHaveLength(1);
  });

  it("an executed quote is already decided; draft, archived and unknown are not found", async () => {
    const executed = await makeQuote("executed");
    expect(await approveQuote(executed.quote.token, executed.itemIds, { db, send, schedule })).toEqual({ ok: false, error: "alreadyDecided" });
    for (const status of ["draft", "archived"] as const) {
      const q = await makeQuote(status);
      expect(await approveQuote(q.quote.token, q.itemIds, { db, send, schedule })).toEqual({ ok: false, error: "notFound" });
      expect((await statusOf(q.quote.id)).status).toBe(status);
    }
    expect(await approveQuote("nope", [], { db, send, schedule })).toEqual({ ok: false, error: "notFound" });
  });

  it("foreign item ids are ignored", async () => {
    const a = await makeQuote("sent");
    const b = await makeQuote("sent");
    const res = await approveQuote(a.quote.token, [a.itemIds[1], b.itemIds[0], "not-a-uuid"], { db, send, schedule });
    expect(res.ok).toBe(true);
    expect(await approvedFlags(a.quote.id)).toEqual([false, true, false]);
    expect(await approvedFlags(b.quote.id)).toEqual([false, false, false]);
    expect((await statusOf(b.quote.id)).status).toBe("sent");
  });

  it("only foreign or empty ids give nothingSelected and change nothing", async () => {
    const a = await makeQuote("sent");
    const b = await makeQuote("sent");
    expect(await approveQuote(a.quote.token, [b.itemIds[0]], { db, send, schedule })).toEqual({ ok: false, error: "nothingSelected" });
    expect(await approveQuote(a.quote.token, [], { db, send, schedule })).toEqual({ ok: false, error: "nothingSelected" });
    expect((await statusOf(a.quote.id)).status).toBe("sent");
    expect(await approvedFlags(a.quote.id)).toEqual([false, false, false]);
    expect(sent).toHaveLength(0);
  });

  it("two simultaneous approvals decide once", async () => {
    const { quote, itemIds } = await makeQuote("sent");
    await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner", passwordHash: "h" });
    const results = await Promise.all([
      approveQuote(quote.token, [itemIds[0]], { db, send, schedule }),
      approveQuote(quote.token, [itemIds[1]], { db, send, schedule }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    await runScheduled();
    expect(sent).toHaveLength(1);
  });

  it("approval e-mails every owner with a password in their language, naming the client or prospect", async () => {
    await db.insert(users).values([
      { name: "Ana", email: "ana@x.com", role: "owner", passwordHash: "h", locale: "pt" },
      { name: "Eva", email: "eva@x.com", role: "owner", passwordHash: "h" },
      { name: "Leo", email: "leo@x.com", role: "owner", passwordHash: "h", locale: "es" },
      { name: "Pending", email: "pending@x.com", role: "owner", passwordHash: null },
      { name: "Mo", email: "mo@x.com", role: "manager", passwordHash: "h" },
    ]);
    const { quote, itemIds } = await makeQuote("sent", { title: "Site <new>", prospectName: "Bia <b>" });
    expect((await approveQuote(quote.token, [itemIds[0]], { db, send, schedule })).ok).toBe(true);

    await runScheduled();
    const byTo = new Map(sent.map((m) => [m.to, m]));
    expect([...byTo.keys()].sort()).toEqual(["ana@x.com", "eva@x.com", "leo@x.com"]);
    expect(byTo.get("ana@x.com")!.subject).toBe("Proposta aprovada: Site <new>");
    expect(byTo.get("eva@x.com")!.subject).toBe("Proposal approved: Site <new>"); // the agency's language (en)
    expect(byTo.get("leo@x.com")!.subject).toBe("Propuesta aprobada: Site <new>");
    const html = byTo.get("ana@x.com")!.html;
    expect(html).toContain("Bia &lt;b&gt;");
    expect(html).not.toContain("Bia <b>");
    expect(html).toContain(`https://painel.acme.com/admin/quotes/${quote.id}`);
    expect(html).toContain("Studio Acme");
  });

  it("names the client in the e-mail when the quote is for one", async () => {
    await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner", passwordHash: "h" });
    const [client] = await db.insert(clients).values({ name: "Casa Verde" }).returning();
    const { quote, itemIds } = await makeQuote("sent", { clientId: client.id, prospectName: null, prospectEmail: null });
    await approveQuote(quote.token, itemIds, { db, send, schedule });
    await runScheduled();
    expect(sent[0].html).toContain("Casa Verde approved items");
  });

  it("a failing mail does not undo the approval", async () => {
    await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner", passwordHash: "h" });
    const { quote, itemIds } = await makeQuote("sent");
    const boom = (async () => {
      throw new Error("smtp down");
    }) as unknown as typeof sendMail;
    const res = await approveQuote(quote.token, itemIds, { db, send: boom, schedule });
    expect(res.ok).toBe(true);
    await runScheduled();
    expect((await statusOf(quote.id)).status).toBe("accepted");
  });

  it("approving returns before owner notices are sent", async () => {
    await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner", passwordHash: "h" });
    const { quote, itemIds } = await makeQuote("sent");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = (async (m: MailMessage) => {
      await gate;
      sent.push(m);
      return { sent: true };
    }) as typeof sendMail;

    const res = await approveQuote(quote.token, [itemIds[0]], { db, send: slow, schedule });
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(0);
    expect(scheduled).toHaveLength(1);

    const running = runScheduled();
    release();
    await running;
    expect(sent).toHaveLength(1);
  });
});
