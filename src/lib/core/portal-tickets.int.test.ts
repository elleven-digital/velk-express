import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientMemberships,
  clientUsers,
  clients,
  files,
  messages,
  sites,
  tickets,
  timeEntries,
  users,
  type Client,
  type ClientUser,
  type Db,
  type User,
} from "@/lib/db";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { postMessage, editMessage, deleteMessage } from "./messages";
import { getPortalTicketView, listPortalTickets, markPortalTicketRead, portalNewTicketOptions, portalTicketUnread } from "./portal-tickets";
import { openPortalTicket } from "./tickets";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let A: Client;
let B: Client;
let person: ClientUser;
let teamUser: User;
let team: TeamSession;
let siteA: { id: string };
let siteLoose: { id: string };
let siteB: { id: string };

const asPortal = (client: Client): PortalSession => ({ userType: "client", user: person, client, role: "admin" });

async function refreshed(client: Client): Promise<Client> {
  const [row] = await db.select().from(clients).where(eq(clients.id, client.id));
  return row;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  [A, B] = await db
    .insert(clients)
    .values([
      { name: "Alpha", supportActive: true, generalTicketsEnabled: true },
      { name: "Beta", supportActive: true, generalTicketsEnabled: false },
    ])
    .returning();
  [person] = await db.insert(clientUsers).values({ name: "Pat", email: "pat@x.com", passwordHash: "x" }).returning();
  await db.insert(clientMemberships).values([
    { clientUserId: person.id, clientId: A.id, role: "admin" },
    { clientUserId: person.id, clientId: B.id, role: "admin" },
  ]);
  [teamUser] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner" }).returning();
  team = { userType: "agency", user: teamUser };
  [siteA] = await db
    .insert(sites)
    .values({ clientId: A.id, name: "alpha.com", includedInSupport: true })
    .returning({ id: sites.id });
  [siteLoose] = await db
    .insert(sites)
    .values({ clientId: A.id, name: "loose.com", includedInSupport: false })
    .returning({ id: sites.id });
  [siteB] = await db.insert(sites).values({ clientId: B.id, name: "beta.com", includedInSupport: true }).returning({ id: sites.id });
});

afterAll(async () => {
  await db?.$client.end();
});

async function open(client: Client, title: string, siteId: string | null = null) {
  const res = await openPortalTicket(asPortal(client), { title, siteId, bodyHtml: "<p>Hello</p>" }, { db });
  if (!res.ok) throw new Error(res.error);
  return res.value.ticketId;
}

describe("listPortalTickets", () => {
  it("only lists the active company's tickets, newest activity first", async () => {
    const first = await open(A, "First", siteA.id);
    const second = await open(A, "Second");
    await open(B, "Other company", siteB.id);
    // activity on the first one moves it to the top
    await postMessage(team, first, { bodyHtml: "<p>Hi</p>" }, { db });
    const rows = await listPortalTickets(asPortal(A), db);
    expect(rows.map((r) => r.id)).toEqual([first, second]);
    expect(rows[0]).toMatchObject({ title: "First", siteName: "alpha.com", status: "open" });
    expect(rows[1].siteName).toBeNull();
    // after switching company, only the new one
    const inB = await listPortalTickets(asPortal(B), db);
    expect(inB.map((r) => r.title)).toEqual(["Other company"]);
  });

  it("carries no money or internal fields", async () => {
    await open(A, "Plain");
    const [row] = await listPortalTickets(asPortal(A), db);
    expect(Object.keys(row).sort()).toEqual([
      "closedAt",
      "createdAt",
      "id",
      "isProject",
      "lastActivity",
      "number",
      "siteName",
      "status",
      "title",
      "unread",
    ]);
  });
});

describe("getPortalTicketView", () => {
  it("returns null for another company's ticket, even for a member of both", async () => {
    const inB = await open(B, "Beta secret", siteB.id);
    expect(await getPortalTicketView(asPortal(A), inB, "en", db)).toBeNull();
    expect(await getPortalTicketView(asPortal(B), inB, "en", db)).not.toBeNull();
    expect(await getPortalTicketView(asPortal(A), "not-a-uuid", "en", db)).toBeNull();
  });

  it("has no labels, assignees or value, and no who-edited", async () => {
    const id = await open(A, "Plain", siteA.id);
    await db.update(tickets).set({ type: "single", valueCents: 50_000 }).where(eq(tickets.id, id));
    await postMessage(team, id, { bodyHtml: "<p>Team reply</p>" }, { db });
    const mine = await postMessage(asPortal(A), id, { bodyHtml: "<p>Mine</p>" }, { db });
    if (!mine.ok) throw new Error(mine.error);
    await editMessage(asPortal(A), id, mine.value.messageId, "<p>Mine, edited</p>", { db });
    const gone = await postMessage(asPortal(A), id, { bodyHtml: "<p>Oops</p>" }, { db });
    if (!gone.ok) throw new Error(gone.error);
    await deleteMessage(asPortal(A), id, gone.value.messageId, { db });

    const view = (await getPortalTicketView(asPortal(A), id, "en", db))!;
    expect(view).not.toBeNull();
    const keys = Object.keys(view);
    for (const forbidden of ["labels", "assignees", "valueCents"]) expect(keys).not.toContain(forbidden);
    expect(Object.keys(view.ticket).sort()).toEqual(["closedAt", "createdAt", "id", "isProject", "number", "status", "title"]);
    expect(view.siteName).toBe("alpha.com");
    expect(view.messages.length).toBe(4);
    expect(view.messages.every((m) => m.changedBy === null)).toBe(true);
    expect(view.messages.some((m) => m.edited)).toBe(true);
    expect(view.messages.some((m) => m.deleted)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("50000");
  });
});

describe("unread messages", () => {
  const unreadOf = async (session: PortalSession, id: string) =>
    (await listPortalTickets(session, db)).find((r) => r.id === id)!.unread;

  it("counts the team's messages until the person opens the ticket; their own never count", async () => {
    const id = await open(A, "Needs help");
    expect(await unreadOf(asPortal(A), id)).toBe(0);
    await postMessage(team, id, { bodyHtml: "<p>On it</p>" }, { db });
    await postMessage(team, id, { bodyHtml: "<p>Done, please check</p>" }, { db });
    expect(await unreadOf(asPortal(A), id)).toBe(2);
    expect(await portalTicketUnread(asPortal(A), id, db)).toBe(2);

    const view = (await getPortalTicketView(asPortal(A), id, "en", db))!;
    expect(await markPortalTicketRead(asPortal(A), id, new Date(view.renderedAt), db)).toEqual({ ok: true, value: undefined });
    expect(await unreadOf(asPortal(A), id)).toBe(0);
  });

  it("counts a colleague's messages, and a read mark is per person", async () => {
    const id = await open(A, "Shared");
    const [colleague] = await db.insert(clientUsers).values({ name: "Bo", email: "bo@x.com", passwordHash: "x" }).returning();
    await db.insert(clientMemberships).values({ clientUserId: colleague.id, clientId: A.id, role: "collaborator" });
    const asColleague: PortalSession = { userType: "client", user: colleague, client: A, role: "collaborator" };
    await postMessage(asColleague, id, { bodyHtml: "<p>Any news?</p>" }, { db });
    expect(await unreadOf(asPortal(A), id)).toBe(1);
    expect(await unreadOf(asColleague, id)).toBe(0);
    await markPortalTicketRead(asPortal(A), id, undefined, db);
    expect(await unreadOf(asPortal(A), id)).toBe(0);
  });

  it("refuses to mark a ticket of another company", async () => {
    const [{ id }] = await db
      .insert(tickets)
      .values({ number: 99, clientId: B.id, type: "single", title: "Other", createdByType: "agency", createdById: teamUser.id })
      .returning({ id: tickets.id });
    expect(await markPortalTicketRead(asPortal(A), id, undefined, db)).toEqual({ ok: false, error: "notFound" });
    expect(await portalTicketUnread(asPortal(A), id, db)).toBe(0);
  });
});

describe("portalNewTicketOptions", () => {
  it("cannot open without active support", async () => {
    await db.update(clients).set({ supportActive: false }).where(eq(clients.id, A.id));
    const options = await portalNewTicketOptions(asPortal(await refreshed(A)), db);
    expect(options.canOpen).toBe(false);
    expect(options.sites).toEqual([]);
  });

  it("lists only the sites included in support, by name", async () => {
    await db.insert(sites).values({ clientId: A.id, name: "aaa.com", includedInSupport: true });
    const options = await portalNewTicketOptions(asPortal(A), db);
    expect(options.canOpen).toBe(true);
    expect(options.sites.map((s) => s.name)).toEqual(["aaa.com", "alpha.com"]);
    expect(options.sites.map((s) => s.id)).not.toContain(siteLoose.id);
    expect(Object.keys(options.sites[0]).sort()).toEqual(["id", "name"]);
  });

  it("follows general_tickets_enabled", async () => {
    expect((await portalNewTicketOptions(asPortal(A), db)).generalAllowed).toBe(true);
    expect((await portalNewTicketOptions(asPortal(B), db)).generalAllowed).toBe(false);
  });

  it("reads the plan fresh, not from the session snapshot", async () => {
    const stale = asPortal(A);
    await db.update(clients).set({ supportActive: false }).where(eq(clients.id, A.id));
    expect((await portalNewTicketOptions(stale, db)).canOpen).toBe(false);
  });
});

describe("openPortalTicket attachments", () => {
  async function upload(by: { type: "agency" | "client"; id: string }) {
    const [f] = await db
      .insert(files)
      .values({
        storageKey: `attachments/${randomUUID()}`,
        name: "a.pdf",
        mime: "application/pdf",
        sizeBytes: 10,
        uploadedByType: by.type,
        uploadedById: by.id,
      })
      .returning({ id: files.id });
    return f.id;
  }

  it("openPortalTicket claims the client's own uploads as attachments of the first message", async () => {
    const mine = await upload({ type: "client", id: person.id });
    const res = await openPortalTicket(asPortal(A), { title: "With file", siteId: siteA.id, bodyHtml: "<p>See</p>", attachmentIds: [mine] }, { db });
    if (!res.ok) throw new Error(res.error);
    const [msg] = await db.select().from(messages).where(eq(messages.ticketId, res.value.ticketId));
    const [row] = await db.select().from(files).where(eq(files.id, mine));
    expect(row).toMatchObject({ ticketId: res.value.ticketId, messageId: msg.id });

    // files alone, with no text, also make a first message
    const solo = await upload({ type: "client", id: person.id });
    const res2 = await openPortalTicket(asPortal(A), { title: "Only file", siteId: siteA.id, attachmentIds: [solo] }, { db });
    expect(res2.ok).toBe(true);
  });

  it("refuses files of someone else or already claimed, and claims nothing", async () => {
    const theirs = await upload({ type: "agency", id: teamUser.id });
    const mine = await upload({ type: "client", id: person.id });
    const before = (await db.select().from(tickets)).length;
    expect(await openPortalTicket(asPortal(A), { title: "x", siteId: siteA.id, bodyHtml: "<p>x</p>", attachmentIds: [mine, theirs] }, { db })).toEqual({
      ok: false,
      error: "notFound",
    });
    expect((await db.select().from(tickets)).length).toBe(before);
    expect((await db.select().from(files).where(eq(files.id, mine)))[0].ticketId).toBeNull();

    const first = await openPortalTicket(asPortal(A), { title: "ok", siteId: siteA.id, bodyHtml: "<p>x</p>", attachmentIds: [mine] }, { db });
    expect(first.ok).toBe(true);
    expect(await openPortalTicket(asPortal(A), { title: "again", siteId: siteA.id, bodyHtml: "<p>x</p>", attachmentIds: [mine] }, { db })).toEqual({
      ok: false,
      error: "notFound",
    });
  });
});

describe("getPortalTicketView time", () => {
  const logTime = async (ticketId: string, client: Client, minutes: number, note: string) =>
    db.insert(timeEntries).values({ ticketId, clientId: client.id, minutes, workedOn: "2026-11-10", note, createdById: teamUser.id });

  it("portal ticket view exposes only the total, never entries", async () => {
    await db.update(clients).set({ hoursTracked: true, hoursVisible: true, hoursLimited: true, includedMinutes: 600 }).where(eq(clients.id, A.id));
    const id = await open(A, "Timed", siteA.id);
    expect((await getPortalTicketView(asPortal(A), id, "en", db))!.timeLoggedMinutes).toBeNull();
    await logTime(id, A, 45, "private note");
    await logTime(id, A, 30, "another note");
    await db.update(tickets).set({ type: "single" }).where(eq(tickets.id, id));
    const view = (await getPortalTicketView(asPortal(A), id, "en", db))!;
    expect(view.timeLoggedMinutes).toBe(75);
    const json = JSON.stringify(view);
    for (const leak of ["private note", "another note", "2026-11-10", teamUser.id, "workedOn", "createdById"]) expect(json).not.toContain(leak);
    expect(Object.keys(view).sort()).toEqual(["charge", "files", "messages", "renderedAt", "siteName", "ticket", "timeLoggedMinutes"]);
  });

  it("has no time total while the client does not see hours", async () => {
    const id = await open(A, "Timed");
    await logTime(id, A, 45, "n");
    expect((await getPortalTicketView(asPortal(A), id, "en", db))!.timeLoggedMinutes).toBeNull();
    await db.update(clients).set({ hoursTracked: true, hoursVisible: false, hoursLimited: false, includedMinutes: 0 }).where(eq(clients.id, A.id));
    expect((await getPortalTicketView(asPortal(A), id, "en", db))!.timeLoggedMinutes).toBeNull();
  });
});
