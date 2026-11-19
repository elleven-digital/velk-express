import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyTestDb, resetTestDb } from "@/test/db";
import {
  agency,
  autoAssignUsers,
  charges,
  clientAssignments,
  clientMemberships,
  clients,
  clientUsers,
  files,
  hourPurchases,
  instance,
  labels,
  messages,
  paymentEvents,
  quoteItems,
  quotes,
  sessions,
  sites,
  ticketAssignments,
  ticketLabels,
  ticketReads,
  tickets,
  timeEntries,
  users,
} from "./schema";

let db: Awaited<ReturnType<typeof resetTestDb>>;

beforeAll(async () => {
  db = await resetTestDb();
});

afterAll(async () => {
  await db.$client.end();
});

describe("base schema", () => {
  it("allows a single instance row", async () => {
    await db.insert(instance).values({ id: 1, secretKey: "k" });
    await expect(db.insert(instance).values({ id: 2, secretKey: "k" })).rejects.toThrow();
  });

  it("allows a single agency row", async () => {
    await db.insert(agency).values({ id: 1, name: "A" });
    await expect(db.insert(agency).values({ id: 2, name: "B" })).rejects.toThrow();
  });

  it("rejects duplicate user emails", async () => {
    await db.insert(users).values({ name: "Ana", email: "ana@x.com" });
    await expect(db.insert(users).values({ name: "Ana 2", email: "ana@x.com" })).rejects.toThrow();
  });

  it("rejects non-lowercase emails", async () => {
    await expect(db.insert(users).values({ name: "Bob", email: "Bob@x.com" })).rejects.toThrow();
  });
});

async function newClient(name = "Acme") {
  const [c] = await db.insert(clients).values({ name }).returning();
  return c;
}

async function newUser(email: string) {
  const [u] = await db.insert(users).values({ name: email, email }).returning();
  return u;
}

describe("clients, sites and portal schema", () => {
  it("rejects non-lowercase and duplicate client_users emails", async () => {
    await expect(db.insert(clientUsers).values({ name: "P", email: "P@x.com" })).rejects.toThrow();
    await db.insert(clientUsers).values({ name: "P", email: "p@x.com" });
    await expect(db.insert(clientUsers).values({ name: "P2", email: "p@x.com" })).rejects.toThrow();
  });

  it("lets a client user and a team user share an email", async () => {
    await db.insert(users).values({ name: "Both", email: "both@x.com" });
    await db.insert(clientUsers).values({ name: "Both", email: "both@x.com" });
  });

  it("rejects a duplicate membership", async () => {
    const c = await newClient();
    const [p] = await db.insert(clientUsers).values({ name: "M", email: "m@x.com" }).returning();
    await db.insert(clientMemberships).values({ clientUserId: p.id, clientId: c.id });
    await expect(
      db.insert(clientMemberships).values({ clientUserId: p.id, clientId: c.id }),
    ).rejects.toThrow();
  });

  it("keeps the general round robin unique per user but allows one per client", async () => {
    const u = await newUser("rr@x.com");
    const c1 = await newClient("C1");
    const c2 = await newClient("C2");
    await db.insert(autoAssignUsers).values({ userId: u.id });
    await expect(db.insert(autoAssignUsers).values({ userId: u.id })).rejects.toThrow();
    await db.insert(autoAssignUsers).values({ userId: u.id, clientId: c1.id });
    await db.insert(autoAssignUsers).values({ userId: u.id, clientId: c2.id });
    await expect(
      db.insert(autoAssignUsers).values({ userId: u.id, clientId: c1.id }),
    ).rejects.toThrow();
  });

  it("cascades a client deletion and nulls sessions.client_id", async () => {
    const u = await newUser("own@x.com");
    const c = await newClient("Gone");
    const [p] = await db.insert(clientUsers).values({ name: "G", email: "g@x.com" }).returning();
    await db.insert(sites).values({ clientId: c.id, name: "Site" });
    await db.insert(clientMemberships).values({ clientUserId: p.id, clientId: c.id });
    await db.insert(clientAssignments).values({ clientId: c.id, userId: u.id });
    await db.insert(autoAssignUsers).values({ clientId: c.id, userId: u.id });
    await db.insert(sessions).values({
      tokenHash: "h-client",
      userType: "client",
      userId: p.id,
      clientId: c.id,
      expiresAt: new Date(Date.now() + 1000),
    });

    await db.delete(clients).where(eq(clients.id, c.id));

    for (const t of [sites, clientMemberships, clientAssignments, autoAssignUsers]) {
      expect(await db.select().from(t).where(eq(t.clientId, c.id))).toHaveLength(0);
    }
    const [s] = await db.select().from(sessions).where(eq(sessions.tokenHash, "h-client"));
    expect(s.clientId).toBeNull();
  });

  it("cascades a team user deletion and clears last-assigned pointers", async () => {
    const u = await newUser("leaving@x.com");
    const c = await newClient("Ptr");
    await db.update(clients).set({ autoAssignLastUserId: u.id }).where(eq(clients.id, c.id));
    await db.update(agency).set({ autoAssignLastUserId: u.id });
    await db.insert(clientAssignments).values({ clientId: c.id, userId: u.id });
    await db.insert(autoAssignUsers).values({ clientId: c.id, userId: u.id });

    await db.delete(users).where(eq(users.id, u.id));

    expect(await db.select().from(clientAssignments).where(eq(clientAssignments.userId, u.id))).toHaveLength(0);
    expect(await db.select().from(autoAssignUsers).where(eq(autoAssignUsers.userId, u.id))).toHaveLength(0);
    const [cc] = await db.select().from(clients).where(eq(clients.id, c.id));
    expect(cc.autoAssignLastUserId).toBeNull();
    const [a] = await db.select().from(agency);
    expect(a.autoAssignLastUserId).toBeNull();
  });

  it("rejects negative monthly support values", async () => {
    await expect(
      db.insert(clients).values({ name: "Neg", supportMonthlyCents: -1 }),
    ).rejects.toThrow();
    await db.insert(clients).values({ name: "Zero", supportMonthlyCents: 0 });
  });

  it("applies the documented defaults", async () => {
    const [a] = await db.select().from(agency);
    expect(a).toMatchObject({
      collabClientScope: "assigned",
      collabTicketScope: "all",
      collabSeesUnassigned: true,
      autoAssign: false,
    });
    const c = await newClient("Defaults");
    expect(c).toMatchObject({ supportActive: false, generalTicketsEnabled: false, autoAssign: false });
  });
});

let ticketSeq = 0;

async function newTicket(
  clientId: string,
  over: Partial<typeof tickets.$inferInsert> = {},
) {
  const [t] = await db
    .insert(tickets)
    .values({
      number: ++ticketSeq,
      clientId,
      type: "single",
      title: "Title",
      createdByType: "agency",
      createdById: crypto.randomUUID(),
      ...over,
    })
    .returning();
  return t;
}

describe("tickets schema", () => {
  it("starts the agency ticket counter at 0", async () => {
    const [a] = await db.select().from(agency);
    expect(a.ticketCounter).toBe(0);
  });

  it("applies ticket defaults", async () => {
    const c = await newClient("TDefaults");
    const t = await newTicket(c.id);
    expect(t).toMatchObject({ status: "open", closedAt: null, lastMessageAt: null, valueCents: null, siteId: null });
  });

  it("rejects two tickets with the same number", async () => {
    const c = await newClient("Dup");
    const t = await newTicket(c.id);
    await expect(newTicket(c.id, { number: t.number })).rejects.toThrow();
  });

  it("rejects a value on a support ticket and a negative value", async () => {
    const c = await newClient("Val");
    await expect(newTicket(c.id, { type: "support", valueCents: 100 })).rejects.toThrow();
    await expect(newTicket(c.id, { type: "single", valueCents: -1 })).rejects.toThrow();
    await newTicket(c.id, { type: "single", valueCents: 0 });
    await newTicket(c.id, { type: "support" });
  });

  it("keeps a site's tickets as general when the site is deleted", async () => {
    const c = await newClient("SiteDel");
    const [s] = await db.insert(sites).values({ clientId: c.id, name: "S" }).returning();
    const t = await newTicket(c.id, { siteId: s.id });
    await db.delete(sites).where(eq(sites.id, s.id));
    const [after] = await db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(after.siteId).toBeNull();
  });

  it("cascades a ticket deletion to its dependent rows", async () => {
    const c = await newClient("TktDel");
    const u = await newUser("tktdel@x.com");
    const t = await newTicket(c.id);
    const [m] = await db
      .insert(messages)
      .values({ ticketId: t.id, authorType: "agency", authorId: u.id, bodyHtml: "<p>x</p>", bodyText: "x" })
      .returning();
    await db.insert(files).values({
      storageKey: "k-tktdel",
      name: "a.png",
      mime: "image/png",
      sizeBytes: 1,
      uploadedByType: "agency",
      uploadedById: u.id,
      ticketId: t.id,
      messageId: m.id,
    });
    const [l] = await db.insert(labels).values({ name: "TktDelLabel" }).returning();
    await db.insert(ticketAssignments).values({ ticketId: t.id, userId: u.id });
    await db.insert(ticketLabels).values({ ticketId: t.id, labelId: l.id });
    await db.insert(ticketReads).values({ ticketId: t.id, userId: u.id, lastReadAt: new Date() });

    await db.delete(tickets).where(eq(tickets.id, t.id));

    expect(await db.select().from(messages).where(eq(messages.ticketId, t.id))).toHaveLength(0);
    expect(await db.select().from(files).where(eq(files.ticketId, t.id))).toHaveLength(0);
    expect(await db.select().from(ticketAssignments).where(eq(ticketAssignments.ticketId, t.id))).toHaveLength(0);
    expect(await db.select().from(ticketLabels).where(eq(ticketLabels.ticketId, t.id))).toHaveLength(0);
    expect(await db.select().from(ticketReads).where(eq(ticketReads.ticketId, t.id))).toHaveLength(0);
    expect(await db.select().from(labels).where(eq(labels.id, l.id))).toHaveLength(1);
  });

  it("cascades a team user deletion to assignments and reads but keeps their messages", async () => {
    const c = await newClient("UserDel");
    const u = await newUser("userdel@x.com");
    const t = await newTicket(c.id);
    await db
      .insert(messages)
      .values({ ticketId: t.id, authorType: "agency", authorId: u.id, bodyHtml: "<p>x</p>", bodyText: "x" });
    await db.insert(ticketAssignments).values({ ticketId: t.id, userId: u.id });
    await db.insert(ticketReads).values({ ticketId: t.id, userId: u.id, lastReadAt: new Date() });

    await db.delete(users).where(eq(users.id, u.id));

    expect(await db.select().from(ticketAssignments).where(eq(ticketAssignments.ticketId, t.id))).toHaveLength(0);
    expect(await db.select().from(ticketReads).where(eq(ticketReads.ticketId, t.id))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.ticketId, t.id))).toHaveLength(1);
  });

  it("nulls reply_to_id when the replied message is deleted", async () => {
    const c = await newClient("Reply");
    const t = await newTicket(c.id);
    const base = { ticketId: t.id, authorType: "agency" as const, authorId: crypto.randomUUID(), bodyHtml: "<p>x</p>", bodyText: "x" };
    const [first] = await db.insert(messages).values(base).returning();
    const [second] = await db.insert(messages).values({ ...base, replyToId: first.id }).returning();
    await db.delete(messages).where(eq(messages.id, first.id));
    const [after] = await db.select().from(messages).where(eq(messages.id, second.id));
    expect(after.replyToId).toBeNull();
  });

  it("rejects invalid label colors and case-insensitive duplicate names", async () => {
    await expect(db.insert(labels).values({ name: "Red", color: "red" })).rejects.toThrow();
    await expect(db.insert(labels).values({ name: "Short", color: "#FFF" })).rejects.toThrow();
    await expect(db.insert(labels).values({ name: "Upper", color: "#FFFFFF" })).rejects.toThrow();
    await db.insert(labels).values({ name: "Urgent" });
    await expect(db.insert(labels).values({ name: "urgent" })).rejects.toThrow();
    const [l] = await db.insert(labels).values({ name: "Default color" }).returning();
    expect(l.color).toBe("#8f8f8f");
  });

  it("rejects a file tied to a message but not to a ticket", async () => {
    const base = {
      name: "a.png",
      mime: "image/png",
      sizeBytes: 1,
      uploadedByType: "agency" as const,
      uploadedById: crypto.randomUUID(),
    };
    const c = await newClient("FileChk");
    const t = await newTicket(c.id);
    const [m] = await db
      .insert(messages)
      .values({ ticketId: t.id, authorType: "agency", authorId: base.uploadedById, bodyHtml: "<p>x</p>", bodyText: "x" })
      .returning();
    await expect(
      db.insert(files).values({ ...base, storageKey: "k-bad", messageId: m.id }),
    ).rejects.toThrow();
    const [ok] = await db.insert(files).values({ ...base, storageKey: "k-ok" }).returning();
    expect(ok).toMatchObject({ ticketId: null, messageId: null, inline: false });
  });
});

describe("upgrade from the Stage 1 schema", () => {
  it("keeps existing agency and users when the new migration applies", async () => {
    const stage1 = await mkdtemp(path.join(os.tmpdir(), "velk-stage1-"));
    const journal = JSON.parse(await readFile(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"));
    expect(journal.entries.length).toBeGreaterThan(1);
    await cp(path.join(process.cwd(), "drizzle"), stage1, { recursive: true });
    journal.entries = journal.entries.slice(0, 1);
    await writeFile(path.join(stage1, "meta/_journal.json"), JSON.stringify(journal));

    const old = await emptyTestDb();
    try {
      await migrate(old, { migrationsFolder: stage1 });
      await old.execute(sql`insert into agency (id, name) values (1, 'Studio')`);
      await old.execute(sql`insert into users (name, email, role) values ('Owner', 'o@x.com', 'owner')`);
      await old.execute(sql`insert into sessions (token_hash, user_type, user_id, expires_at)
        values ('h', 'agency', gen_random_uuid(), now() + interval '1 day')`);

      await migrate(old, { migrationsFolder: path.join(process.cwd(), "drizzle") });

      const [a] = await old.select().from(agency);
      expect(a.name).toBe("Studio");
      expect(a.collabClientScope).toBe("assigned");
      expect(a.collabSeesUnassigned).toBe(true);
      expect(await old.select().from(users)).toHaveLength(1);
      expect(await old.select().from(sessions)).toHaveLength(1);
    } finally {
      await old.$client.end();
    }
  });
});

describe("upgrade from the Stage 2 schema", () => {
  it("keeps clients, sites and members when the tickets migration applies", async () => {
    const stage2 = await mkdtemp(path.join(os.tmpdir(), "velk-stage2-"));
    const journal = JSON.parse(await readFile(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"));
    expect(journal.entries.length).toBeGreaterThan(2);
    await cp(path.join(process.cwd(), "drizzle"), stage2, { recursive: true });
    journal.entries = journal.entries.slice(0, 2);
    await writeFile(path.join(stage2, "meta/_journal.json"), JSON.stringify(journal));

    const old = await emptyTestDb();
    try {
      await migrate(old, { migrationsFolder: stage2 });
      await old.execute(sql`insert into agency (id, name) values (1, 'Studio')`);
      await old.execute(sql`insert into users (name, email, role) values ('Owner', 'o@x.com', 'owner')`);
      await old.execute(sql`insert into clients (name) values ('Acme')`);
      await old.execute(sql`insert into sites (client_id, name) select id, 'Main' from clients`);
      await old.execute(sql`insert into client_users (name, email) values ('P', 'p@x.com')`);
      await old.execute(sql`insert into client_memberships (client_user_id, client_id, role)
        select cu.id, c.id, 'admin' from client_users cu, clients c`);
      await old.execute(sql`insert into files (storage_key, name, mime, size_bytes, uploaded_by_type, uploaded_by_id)
        values ('k', 'logo.png', 'image/png', 10, 'agency', gen_random_uuid())`);

      await migrate(old, { migrationsFolder: path.join(process.cwd(), "drizzle") });

      const [a] = await old.select().from(agency);
      expect(a.name).toBe("Studio");
      expect(a.ticketCounter).toBe(0);
      expect(await old.select().from(clients)).toHaveLength(1);
      expect(await old.select().from(sites)).toHaveLength(1);
      expect(await old.select().from(clientUsers)).toHaveLength(1);
      expect(await old.select().from(clientMemberships)).toHaveLength(1);
      const [f] = await old.select().from(files);
      expect(f).toMatchObject({ name: "logo.png", ticketId: null, messageId: null, inline: false });
      expect(await old.select().from(tickets)).toHaveLength(0);
    } finally {
      await old.$client.end();
    }
  });
});

describe("hours schema", () => {
  it("time entry minutes must be 1..1440", async () => {
    const c = await newClient("Mins");
    const t = await newTicket(c.id);
    const entry = (minutes: number) =>
      db.insert(timeEntries).values({ ticketId: t.id, clientId: c.id, minutes, workedOn: "2026-11-18" });
    await expect(entry(0)).rejects.toThrow();
    await expect(entry(-5)).rejects.toThrow();
    await expect(entry(1441)).rejects.toThrow();
    await entry(1);
    await entry(1440);
  });

  it("hour purchase cycle must be YYYY-MM with a real month", async () => {
    const c = await newClient("Cycle");
    const purchase = (cycle: string, minutes = 60) =>
      db.insert(hourPurchases).values({ clientId: c.id, minutes, cycle });
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", "abcd-ef"]) {
      await expect(purchase(bad)).rejects.toThrow();
    }
    await expect(purchase("2026-11", 0)).rejects.toThrow();
    await purchase("2026-01");
    await purchase("2026-12");
  });

  it("a closed ticket needs closed_at and an open one must not have it", async () => {
    const c = await newClient("Closed");
    await expect(newTicket(c.id, { status: "closed" })).rejects.toThrow();
    await expect(newTicket(c.id, { status: "open", closedAt: new Date() })).rejects.toThrow();
    await newTicket(c.id, { status: "closed", closedAt: new Date() });
    await newTicket(c.id, { status: "open" });
  });

  it("deleting a ticket deletes its time entries; deleting a user keeps them with no author", async () => {
    const c = await newClient("Cascade");
    const u = await newUser("logger@x.com");
    const t1 = await newTicket(c.id);
    const t2 = await newTicket(c.id);
    const values = (ticketId: string) => ({
      ticketId,
      clientId: c.id,
      minutes: 30,
      workedOn: "2026-11-18",
      createdById: u.id,
    });
    await db.insert(timeEntries).values([values(t1.id), values(t2.id)]);

    await db.delete(tickets).where(eq(tickets.id, t1.id));
    expect(await db.select().from(timeEntries).where(eq(timeEntries.ticketId, t1.id))).toHaveLength(0);

    await db.delete(users).where(eq(users.id, u.id));
    const [kept] = await db.select().from(timeEntries).where(eq(timeEntries.ticketId, t2.id));
    expect(kept.createdById).toBeNull();
    expect(kept.workedOn).toBe("2026-11-18");
  });
});

describe("quotes schema", () => {
  const newQuote = (token: string, extra: Partial<typeof quotes.$inferInsert> = {}) =>
    db
      .insert(quotes)
      .values({ title: "Quote", token, currency: "BRL", ...extra })
      .returning()
      .then((r) => r[0]);

  it("a quote token is unique", async () => {
    await newQuote("tok-unique");
    await expect(newQuote("tok-unique")).rejects.toThrow();
  });

  it("deleting a quote deletes its items", async () => {
    const q = await newQuote("tok-items");
    await db.insert(quoteItems).values([
      { quoteId: q.id, kind: "site_creation", title: "Site", monthly: false, amountCents: 1000, position: 0 },
      { quoteId: q.id, kind: "support", title: "Support", monthly: true, amountCents: 500, position: 1 },
    ]);
    await expect(
      db.insert(quoteItems).values({ quoteId: q.id, kind: "maintenance", title: "Bad", monthly: false, amountCents: -1 }),
    ).rejects.toThrow();
    await db.delete(quotes).where(eq(quotes.id, q.id));
    expect(await db.select().from(quoteItems).where(eq(quoteItems.quoteId, q.id))).toHaveLength(0);
  });

  it("deleting a client keeps its quotes without the client", async () => {
    const c = await newClient("Quoted");
    const q = await newQuote("tok-client", { clientId: c.id });
    await db.delete(clients).where(eq(clients.id, c.id));
    const [kept] = await db.select().from(quotes).where(eq(quotes.id, q.id));
    expect(kept.clientId).toBeNull();
    expect(kept.status).toBe("draft");
  });

  it("clients refuse hours without support and package fields outside the package", async () => {
    const c = await newClient("Hours");
    const update = (v: Partial<typeof clients.$inferInsert>) =>
      db.update(clients).set(v).where(eq(clients.id, c.id));
    await expect(update({ hoursMode: "internal" })).rejects.toThrow();
    await expect(update({ supportActive: true, hoursMode: "internal", includedMinutes: 60 })).rejects.toThrow();
    await expect(update({ supportActive: true, hoursMode: "internal", extraHourCents: 100 })).rejects.toThrow();
    await update({ supportActive: true, hoursMode: "package", includedMinutes: 600, extraHourCents: 100 });
    await update({ supportActive: false, hoursMode: "off", includedMinutes: 0, extraHourCents: null });
  });
});

describe("charges schema", () => {
  let n = 0;
  const newCharge = (extra: Partial<typeof charges.$inferInsert> = {}) =>
    db
      .insert(charges)
      .values({
        source: "none",
        kind: "one_time",
        label: "Charge",
        amountCents: 1000,
        currency: "BRL",
        payToken: `pay-token-${++n}`,
        ...extra,
      })
      .returning()
      .then((r) => r[0]);

  const pgCode = (e: unknown) => {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code;
  };

  it("one live charge per source is enforced by the database", async () => {
    const c = await newClient("Charged");
    const t = await newTicket(c.id);
    const first = await newCharge({ clientId: c.id, source: "ticket", ticketId: t.id });
    const second = newCharge({ clientId: c.id, source: "ticket", ticketId: t.id });
    await expect(second).rejects.toThrow();
    await second.catch((e) => expect(pgCode(e)).toBe("23505"));

    await db.update(charges).set({ status: "canceled" }).where(eq(charges.id, first.id));
    await newCharge({ clientId: c.id, source: "ticket", ticketId: t.id });

    const [purchase] = await db.insert(hourPurchases).values({ clientId: c.id, minutes: 60, cycle: "2026-11" }).returning();
    await newCharge({ clientId: c.id, source: "hours", hourPurchaseId: purchase.id });
    await expect(newCharge({ clientId: c.id, source: "hours", hourPurchaseId: purchase.id })).rejects.toThrow();

    const q = await db.insert(quotes).values({ title: "Q", token: "tok-charge-q", currency: "BRL" }).returning();
    await newCharge({ source: "quote", quoteId: q[0].id });
    await expect(newCharge({ source: "quote", quoteId: q[0].id })).rejects.toThrow();

    await newCharge({ clientId: c.id, source: "support", kind: "subscription" });
    await expect(newCharge({ clientId: c.id, source: "support", kind: "subscription" })).rejects.toThrow();
  });

  it("keeps the source and subscription rules in the database, except the ones set null would break", async () => {
    const c = await newClient("Rules");
    const t = await newTicket(c.id);
    await expect(newCharge({ clientId: c.id, source: "none", ticketId: t.id })).rejects.toThrow();
    await expect(newCharge({ clientId: c.id, source: "support", hourPurchaseId: crypto.randomUUID() })).rejects.toThrow();
    await expect(newCharge({ clientId: c.id, source: "ticket", ticketId: t.id, kind: "subscription" })).rejects.toThrow();
    await expect(newCharge({ amountCents: 0 })).rejects.toThrow();
    const row = await newCharge({ payToken: "pay-token-fixed" });
    await expect(newCharge({ payToken: "pay-token-fixed" })).rejects.toThrow();
    expect(row.status).toBe("pending");
    expect(row.provider).toBeNull();
  });

  it("keeps a charge without its ticket when the ticket is deleted", async () => {
    const c = await newClient("Orphaned");
    const t = await newTicket(c.id);
    const ch = await newCharge({ clientId: c.id, source: "ticket", ticketId: t.id });
    await db.delete(tickets).where(eq(tickets.id, t.id));
    const [kept] = await db.select().from(charges).where(eq(charges.id, ch.id));
    expect(kept.ticketId).toBeNull();
  });

  it("a payment event is recorded once per provider", async () => {
    await db.insert(paymentEvents).values({ provider: "stripe", eventId: "evt_1" });
    await expect(db.insert(paymentEvents).values({ provider: "stripe", eventId: "evt_1" })).rejects.toThrow();
    await db.insert(paymentEvents).values({ provider: "mercadopago", eventId: "evt_1" });
  });

  it("deleting a quote item keeps its tickets without the link", async () => {
    const c = await newClient("Linked");
    const q = await db.insert(quotes).values({ title: "Q", token: "tok-link", currency: "BRL" }).returning();
    const [item] = await db
      .insert(quoteItems)
      .values({ quoteId: q[0].id, kind: "site_creation", title: "Site", monthly: false, amountCents: 100 })
      .returning();
    const t = await newTicket(c.id, { quoteItemId: item.id });
    expect(t.quoteItemId).toBe(item.id);
    await db.delete(quoteItems).where(eq(quoteItems.id, item.id));
    const [kept] = await db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(kept.quoteItemId).toBeNull();
  });
});

describe("upgrade from the Stage 5 schema", () => {
  it("the backfill links tickets created by executed quotes", async () => {
    const stage5 = await mkdtemp(path.join(os.tmpdir(), "velk-stage5-"));
    const journal = JSON.parse(await readFile(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"));
    expect(journal.entries.length).toBeGreaterThan(5);
    await cp(path.join(process.cwd(), "drizzle"), stage5, { recursive: true });
    journal.entries = journal.entries.slice(0, 5);
    await writeFile(path.join(stage5, "meta/_journal.json"), JSON.stringify(journal));

    const old = await emptyTestDb();
    try {
      await migrate(old, { migrationsFolder: stage5 });
      const id = async (q: ReturnType<typeof sql>) => ((await old.execute(q))[0] as { id: string }).id;
      await old.execute(sql`insert into agency (id, name) values (1, 'Studio')`);
      const clientId = await id(sql`insert into clients (name) values ('Acme') returning id`);
      const quoteId = await id(
        sql`insert into quotes (title, token, currency, status, client_id) values ('Q', 'tok-bf', 'BRL', 'executed', ${clientId}) returning id`,
      );
      const draftQuoteId = await id(
        sql`insert into quotes (title, token, currency, status) values ('D', 'tok-bf-draft', 'BRL', 'draft') returning id`,
      );
      const itemId = await id(
        sql`insert into quote_items (quote_id, kind, title, monthly, amount_cents) values (${quoteId}, 'site_creation', 'Site', false, 100) returning id`,
      );
      const removedItemId = crypto.randomUUID();
      const draftItemId = await id(
        sql`insert into quote_items (quote_id, kind, title, monthly, amount_cents) values (${draftQuoteId}, 'site_creation', 'Site', false, 100) returning id`,
      );
      const mkTicket = (n: number) =>
        id(sql`insert into tickets (number, client_id, type, title, created_by_type, created_by_id)
          values (${n}, ${clientId}, 'single', ${"T" + n}, 'agency', gen_random_uuid()) returning id`);
      const linked = await mkTicket(1);
      const removedItem = await mkTicket(2);
      const noItem = await mkTicket(3);
      const draftTicket = await mkTicket(4);
      const manual = await mkTicket(5);
      const log = [
        { action: "ticket", itemId, label: "T1", id: linked },
        { action: "ticket", itemId: removedItemId, label: "T2", id: removedItem },
        { action: "ticket", itemId: null, label: "T3", id: noItem },
        { action: "site", itemId, label: "Site", id: crypto.randomUUID() },
      ];
      await old.execute(sql`update quotes set execution_log = ${JSON.stringify(log)}::jsonb where id = ${quoteId}`);
      await old.execute(
        sql`update quotes set execution_log = ${JSON.stringify([{ action: "ticket", itemId: draftItemId, label: "T4", id: draftTicket }])}::jsonb where id = ${draftQuoteId}`,
      );

      await migrate(old, { migrationsFolder: path.join(process.cwd(), "drizzle") });

      const rows = await old.select().from(tickets);
      const link = (tid: string) => rows.find((r) => r.id === tid)?.quoteItemId;
      expect(link(linked)).toBe(itemId);
      expect(link(removedItem)).toBeNull();
      expect(link(noItem)).toBeNull();
      expect(link(draftTicket)).toBeNull();
      expect(link(manual)).toBeNull();
    } finally {
      await old.$client.end();
    }
  });
});
