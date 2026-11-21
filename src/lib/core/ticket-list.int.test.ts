import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientAssignments,
  clients,
  labels,
  messages,
  ticketAssignments,
  ticketLabels,
  tickets,
  users,
  type Client,
  type Db,
  type User,
} from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { updateCollabVisibility } from "./assignments";
import { markTicketRead } from "./messages";
import { listTickets, parseTicketFilters, TICKETS_PER_PAGE } from "./ticket-list";
import { addTicketAssignee, createTicket } from "./tickets";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let owner: TeamSession;
let collab: TeamSession;
let acme: Client;
let beta: Client;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

async function makeUser(name: string, role: User["role"]): Promise<User> {
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
  return u;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  owner = asTeam(await makeUser("Ana", "owner"));
  collab = asTeam(await makeUser("Cy", "collaborator"));
  [acme] = await db.insert(clients).values({ name: "Acme Corp", supportActive: true }).returning();
  [beta] = await db.insert(clients).values({ name: "Beta Ltd", supportActive: true }).returning();
  await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
});

afterAll(async () => {
  await db?.$client.end();
});

async function open(actor: TeamSession, client: Client, title: string, body = "") {
  const res = await createTicket(actor, { clientId: client.id, type: "single", title, bodyHtml: body }, { db });
  if (!res.ok) throw new Error(res.error);
  return res.value;
}
const titles = async (actor: TeamSession, filters = {}, page = 1) =>
  (await listTickets(actor, filters, page, db)).rows.map((r) => r.ticket.title);

describe("listTickets", () => {
  it("does not widen visibility: a collaborator filtering by a client they do not take part in sees nothing", async () => {
    await open(owner, acme, "A1");
    await open(owner, beta, "B1");
    expect(await titles(collab, {})).toEqual(["A1"]);
    expect(await titles(collab, { clientId: beta.id })).toEqual([]);
    expect((await listTickets(collab, { clientId: beta.id }, 1, db)).total).toBe(0);
    expect(await titles(owner, { clientId: beta.id })).toEqual(["B1"]);
  });

  it("a ticket scope of assigned also holds with a label or assignee filter", async () => {
    await updateCollabVisibility(owner, { clientScope: "all", ticketScope: "assigned", seesUnassigned: false }, { db });
    const mine = await open(owner, acme, "Mine");
    const theirs = await open(owner, acme, "Theirs");
    await addTicketAssignee(owner, mine.ticketId, collab.user.id, { db });
    const [label] = await db.insert(labels).values({ name: "Hot", color: "#ff0000" }).returning();
    await db.insert(ticketLabels).values([
      { ticketId: mine.ticketId, labelId: label.id },
      { ticketId: theirs.ticketId, labelId: label.id },
    ]);
    expect(await titles(collab, { labelId: label.id })).toEqual(["Mine"]);
    expect(await titles(collab, { who: "unassigned" })).toEqual([]);
  });

  it("unread only brings tickets with unread messages of other people, for this reader", async () => {
    const a = await open(owner, acme, "Read by Cy", "<p>hello</p>");
    const b = await open(owner, acme, "Unread by Cy", "<p>hello</p>");
    await open(collab, acme, "Cy wrote it", "<p>mine</p>");
    // the person was created before the messages: make them visible as unread
    await db.update(users).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(users.id, collab.user.id));
    await markTicketRead(collab, a.ticketId, undefined, { db });
    const res = await listTickets(collab, { unread: true }, 1, db);
    expect(res.rows.map((r) => r.ticket.title)).toEqual(["Unread by Cy"]);
    expect(res.rows[0].unread).toBe(1);
    expect(b.number).toBeGreaterThan(a.number);
    // for the owner, only the ticket Cy wrote is unread
    expect(await titles(owner, { unread: true })).toEqual(["Cy wrote it"]);
  });

  it("filters by label, assignee, status", async () => {
    const t1 = await open(owner, acme, "One");
    const t2 = await open(owner, acme, "Two");
    await open(owner, beta, "Three");
    const [label] = await db.insert(labels).values({ name: "Waiting", color: "#00ff00" }).returning();
    await db.insert(ticketLabels).values({ ticketId: t1.ticketId, labelId: label.id });
    await db.update(tickets).set({ status: "closed", closedAt: new Date() }).where(eq(tickets.id, t2.ticketId));
    await addTicketAssignee(owner, t2.ticketId, collab.user.id, { db });

    expect(await titles(owner, { labelId: label.id })).toEqual(["One"]);
    // the opener becomes an assignee, so all three are Ana's
    expect((await titles(owner, { who: "mine" })).sort()).toEqual(["One", "Three", "Two"]);
    expect(await titles(collab, { who: "mine" })).toEqual(["Two"]);
    expect(await titles(owner, { status: "closed" })).toEqual(["Two"]);
    expect((await titles(owner, { status: "open" })).sort()).toEqual(["One", "Three"]);
    const nobody = await open(owner, acme, "Nobody");
    await db.delete(ticketAssignments).where(eq(ticketAssignments.ticketId, nobody.ticketId));
    expect(await titles(owner, { who: "unassigned" })).toEqual(["Nobody"]);
  });

  it("searches by number, #number, title and client name", async () => {
    await open(owner, acme, "Fix the header");
    const second = await open(owner, beta, "Other thing");
    expect(second.number).toBe(2);
    expect(await titles(owner, { q: "#2" })).toEqual(["Other thing"]);
    expect(await titles(owner, { q: "2" })).toEqual(["Other thing"]);
    expect(await titles(owner, { q: "acme" })).toEqual(["Fix the header"]);
    expect(await titles(owner, { q: "HEADER" })).toEqual(["Fix the header"]);
    expect(await titles(owner, { q: "%" })).toEqual([]);
  });

  it("a malformed client or label id is an empty list", async () => {
    await open(owner, acme, "A1");
    expect(await listTickets(owner, { labelId: "x" }, 1, db)).toEqual({ rows: [], total: 0 });
    expect(await listTickets(owner, { clientId: "nope" }, 1, db)).toEqual({ rows: [], total: 0 });
  });

  it("orders by last activity and pages", async () => {
    const old = await open(owner, acme, "Old");
    await open(owner, acme, "Newer");
    // activity on the oldest ticket moves it to the top
    await db.update(tickets).set({ lastMessageAt: new Date(Date.now() + 60_000) }).where(eq(tickets.id, old.ticketId));
    expect(await titles(owner)).toEqual(["Old", "Newer"]);

    const many = Array.from({ length: TICKETS_PER_PAGE }, (_, i) => ({
      number: 100 + i,
      clientId: acme.id,
      type: "single" as const,
      title: `Bulk ${i}`,
      createdByType: "agency" as const,
      createdById: owner.user.id,
    }));
    await db.insert(tickets).values(many);
    const p1 = await listTickets(owner, {}, 1, db);
    const p2 = await listTickets(owner, {}, 2, db);
    expect(p1.total).toBe(TICKETS_PER_PAGE + 2);
    expect(p1.rows).toHaveLength(TICKETS_PER_PAGE);
    expect(p2.rows).toHaveLength(2);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("reports the last author, assignees, site and labels", async () => {
    const t = await open(owner, acme, "Row", "<p>hi</p>");
    const [label] = await db.insert(labels).values({ name: "L", color: "#111111" }).returning();
    await db.insert(ticketLabels).values({ ticketId: t.ticketId, labelId: label.id });
    const [row] = (await listTickets(owner, {}, 1, db)).rows;
    expect(row.lastAuthor).toBe("agency");
    expect(row.assignees.map((a) => a.name)).toEqual(["Ana"]);
    expect(row.labels.map((l) => l.name)).toEqual(["L"]);
    expect(row.site).toBeNull();
    expect(row.client.name).toBe("Acme Corp");
  });
});

describe("listTickets columns", () => {
  it("filters by whose move it is, as whoseTurn says, on open tickets only", async () => {
    await open(owner, acme, "Agency opened");
    const answered = await open(owner, acme, "Client answered");
    await db.insert(messages).values({
      ticketId: answered.ticketId,
      authorType: "client",
      authorId: crypto.randomUUID(),
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
    });
    const [clientOpened] = await db
      .insert(tickets)
      .values({ number: 900, clientId: acme.id, type: "support", title: "Client opened", createdByType: "client", createdById: crypto.randomUUID() })
      .returning();
    await db
      .insert(tickets)
      .values({ number: 901, clientId: acme.id, type: "support", title: "Closed", status: "closed", closedAt: new Date(), createdByType: "client", createdById: crypto.randomUUID() });
    expect((await titles(owner, { turn: "agency" })).sort()).toEqual(["Client answered", "Client opened"]);
    expect(await titles(owner, { turn: "client" })).toEqual(["Agency opened"]);
    const row = (await listTickets(owner, { turn: "agency" }, 1, db)).rows.find((r) => r.ticket.id === clientOpened.id);
    expect(row?.ticket.createdByType).toBe("client");
  });

  it("never carries the agreed value, for staff or collaborators", async () => {
    const res = await createTicket(owner, { clientId: acme.id, type: "single", title: "Priced", bodyHtml: "", valueCents: 120_000 }, { db });
    if (!res.ok) throw new Error(res.error);
    await addTicketAssignee(owner, res.value.ticketId, collab.user.id);
    for (const actor of [owner, collab]) {
      const { rows } = await listTickets(actor, {}, 1, db);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0].ticket).sort()).toEqual([
        "createdAt",
        "createdByType",
        "id",
        "lastMessageAt",
        "number",
        "status",
        "title",
        "type",
      ]);
      expect(JSON.stringify(rows[0])).not.toContain("120000");
    }
  });
});

describe("parseTicketFilters", () => {
  it("drops unknown values", () => {
    expect(parseTicketFilters({ status: "x", who: "all", unread: "1" })).toEqual({ unread: true });
  });
  it("keeps the known ones and trims q to 100", () => {
    const q = "a".repeat(150);
    expect(parseTicketFilters({ status: "open", who: "mine", client: "c", label: "l", q: `  ${q}  `, unread: "0" })).toEqual({
      status: "open",
      who: "mine",
      clientId: "c",
      labelId: "l",
      q: q.slice(0, 100),
    });
    expect(parseTicketFilters({})).toEqual({});
    expect(parseTicketFilters({ status: ["closed", "open"] })).toEqual({ status: "closed" });
  });
});
