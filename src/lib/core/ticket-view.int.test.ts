import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientAssignments,
  clients,
  files,
  labels,
  ticketLabels,
  ticketAssignments,
  ticketReads,
  users,
  type Client,
  type Db,
  type User,
} from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { addTimeEntry } from "./hours";
import { deleteMessage, markTicketRead, postMessage } from "./messages";
import { getTeamTicketView, ticketUnread } from "./ticket-view";
import { addTicketAssignee, createTicket } from "./tickets";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
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
  manager = asTeam(await makeUser("Beto", "manager"));
  collab = asTeam(await makeUser("Cy", "collaborator"));
  [acme] = await db.insert(clients).values({ name: "Acme Corp", supportActive: true }).returning();
  [beta] = await db.insert(clients).values({ name: "Beta Ltd", supportActive: true }).returning();
  await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
});

afterAll(async () => {
  await db?.$client.end();
});

async function open(client: Client, valueCents?: number) {
  const res = await createTicket(owner, { clientId: client.id, type: "single", title: "T", bodyHtml: "<p>first</p>", valueCents }, { db });
  if (!res.ok) throw new Error(res.error);
  return res.value.ticketId;
}

describe("getTeamTicketView", () => {
  it("does not mark anything read", async () => {
    const id = await open(acme);
    await postMessage(owner, id, { bodyHtml: "<p>hello</p>" }, { db });
    await getTeamTicketView(collab, id, "en", db);
    expect(await db.select().from(ticketReads)).toEqual([]);
    const first = await getTeamTicketView(collab, id, "en", db);
    const second = await getTeamTicketView(collab, id, "en", db);
    expect(first!.unread).toBe(2);
    expect(second!.unread).toBe(first!.unread);
    expect(await db.select().from(ticketReads)).toEqual([]);
  });

  it("ticketUnread counts what the member has not read, and is 0 outside their scope", async () => {
    const id = await open(acme);
    const other = await open(beta);
    expect(await ticketUnread(collab, id, db)).toBe(1);
    expect(await ticketUnread(collab, other, db)).toBe(0);
    expect(await ticketUnread(collab, "x", db)).toBe(0);
    await markTicketRead(collab, id, undefined, { db });
    expect(await ticketUnread(collab, id, db)).toBe(0);
  });

  it("a collaborator gets no value and nobody to assign; staff get both", async () => {
    const id = await open(acme, 15000);
    const asCollab = await getTeamTicketView(collab, id, "en", db);
    expect(asCollab!.valueCents).toBeNull();
    expect(asCollab!.ticket.valueCents).toBeNull();
    expect(asCollab!.assignable).toEqual([]);

    const asManager = await getTeamTicketView(manager, id, "en", db);
    expect(asManager!.valueCents).toBe(15000);
    expect(asManager!.assignable.map((u) => u.name)).toEqual(expect.arrayContaining(["Beto", "Cy"]));
    // Ana opened it, so she is an assignee already and is not offered again.
    expect(asManager!.assignable.map((u) => u.name)).not.toContain("Ana");
    expect(asManager!.assignees.map((u) => u.name)).toEqual(["Ana"]);
    expect(Object.keys(asManager!.assignable[0]).sort()).toEqual(["id", "name"]);
  });

  it("is null outside the viewer's scope and for an id that is not one", async () => {
    const id = await open(beta);
    expect(await getTeamTicketView(collab, id, "en", db)).toBeNull();
    expect(await getTeamTicketView(owner, id, "en", db)).not.toBeNull();
    expect(await getTeamTicketView(owner, "x", "en", db)).toBeNull();
    expect(await getTeamTicketView(owner, "00000000-0000-4000-8000-000000000000", "en", db)).toBeNull();
  });

  it("files never include inline images; deleted messages leave tombstones", async () => {
    const id = await open(acme);
    const sent = await postMessage(owner, id, { bodyHtml: "<p>see</p>" }, { db });
    if (!sent.ok) throw new Error(sent.error);
    await db.insert(files).values([
      { storageKey: "a/1", name: "inline.png", mime: "image/png", sizeBytes: 1, uploadedByType: "agency", uploadedById: owner.user.id, ticketId: id, messageId: sent.value.messageId, inline: true },
      { storageKey: "a/2", name: "doc.pdf", mime: "application/pdf", sizeBytes: 2048, uploadedByType: "agency", uploadedById: owner.user.id, ticketId: id, messageId: null, inline: false },
    ]);
    const view = await getTeamTicketView(owner, id, "en", db);
    expect(view!.files.map((f) => f.name)).toEqual(["doc.pdf"]);
    expect(view!.files[0].canDelete).toBe(true);

    await deleteMessage(owner, id, sent.value.messageId, { db });
    const after = await getTeamTicketView(owner, id, "en", db);
    const tomb = after!.messages.find((m) => m.id === sent.value.messageId)!;
    expect(tomb).toMatchObject({ deleted: true, bodyHtml: "" });
    expect(tomb.changedBy?.name).toBe("Ana");
    expect(Number.isNaN(new Date(tomb.changedBy!.at).getTime())).toBe(false);
    expect(tomb.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a file-only message comes with an empty body and its attachment", async () => {
    const id = await open(acme);
    const [f] = await db
      .insert(files)
      .values({ storageKey: "a/3", name: "spec.pdf", mime: "application/pdf", sizeBytes: 10, uploadedByType: "agency", uploadedById: owner.user.id })
      .returning();
    const sent = await postMessage(owner, id, { bodyHtml: "", attachmentIds: [f.id] }, { db });
    expect(sent.ok).toBe(true);
    const view = await getTeamTicketView(owner, id, "en", db);
    const last = view!.messages.at(-1)!;
    expect(last.bodyHtml).toBe("");
    expect(last.attachments.map((a) => a.name)).toEqual(["spec.pdf"]);
  });

  it("canAssume: a collaborator on a visible ticket nobody has; not once someone is on it or they are", async () => {
    // Opened by the owner, so Ana is on it: a collaborator cannot take it.
    const taken = await open(acme);
    expect((await getTeamTicketView(collab, taken, "en", db))!.canAssume).toBe(false);
    // Staff can always take a ticket they are not on.
    expect((await getTeamTicketView(manager, taken, "en", db))!.canAssume).toBe(true);
    expect((await getTeamTicketView(owner, taken, "en", db))!.canAssume).toBe(false);

    const free = await open(acme);
    await db.delete(ticketAssignments).where(eq(ticketAssignments.ticketId, free));
    expect((await getTeamTicketView(collab, free, "en", db))!.canAssume).toBe(true);
    await addTicketAssignee(owner, free, collab.user.id, { db });
    expect((await getTeamTicketView(collab, free, "en", db))!.canAssume).toBe(false);
  });

  it("labels: the ticket's own and every label of the agency", async () => {
    const id = await open(acme);
    const [a, b] = await db.insert(labels).values([{ name: "Alpha", color: "#112233" }, { name: "Beta", color: "#445566" }]).returning();
    await db.insert(ticketLabels).values({ ticketId: id, labelId: a.id });
    const view = await getTeamTicketView(owner, id, "en", db);
    expect(view!.labels.map((l) => l.name)).toEqual(["Alpha"]);
    expect(view!.allLabels.map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("names the opener, and says 'Removed user' when they are gone; renderedAt is a valid ISO instant", async () => {
    const res = await createTicket(collab, { clientId: acme.id, type: "single", title: "From Cy" }, { db });
    if (!res.ok) throw new Error(res.error);
    const before = Date.now();
    const view = await getTeamTicketView(owner, res.value.ticketId, "en", db);
    expect(view!.openerName).toBe("Cy");
    expect(view!.client.name).toBe("Acme Corp");
    expect(view!.site).toBeNull();
    expect(view!.turn).toBe("client");
    const at = new Date(view!.renderedAt);
    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(Math.abs(at.getTime() - before)).toBeLessThan(5000);

    await db.delete(users).where(eq(users.id, collab.user.id));
    const gone = await getTeamTicketView(owner, res.value.ticketId, "en", db);
    expect(gone!.openerName).toBe("Removed user");
  });
});

describe("getTeamTicketView time and hours", () => {
  const now = () => new Date("2026-11-18T15:00:00Z");

  it("carries the ticket's time, quiet thread events by logging order and today in the cycle zone", async () => {
    const id = await open(acme);
    await addTimeEntry(owner, id, { duration: "1h30", workedOn: "2026-11-10" }, { db, now });
    await addTimeEntry(collab, id, { duration: "20", workedOn: "2026-11-17" }, { db, now });
    const view = await getTeamTicketView(collab, id, "en", db, { now: () => new Date("2026-11-30T01:00:00Z") });
    expect(view!.today).toBe("2026-11-29");
    expect(view!.time.totalMinutes).toBe(110);
    // the list is by work day, the events by when they were logged
    expect(view!.time.entries.map((e) => e.minutes)).toEqual([20, 90]);
    expect(view!.timeEvents.map((e) => [e.name, e.minutes, e.mine])).toEqual([
      ["Ana", 90, false],
      ["Cy", 20, true],
    ]);
  });

  it("shows hours for the current cycle only in the team-only and package modes", async () => {
    const id = await open(acme);
    await addTimeEntry(owner, id, { duration: "2h", workedOn: "2026-11-02" }, { db, now });
    await addTimeEntry(owner, id, { duration: "5h", workedOn: "2026-10-30" }, { db, now });
    const supportId = async () => {
      const res = await createTicket(owner, { clientId: acme.id, type: "support", title: "S" }, { db });
      if (!res.ok) throw new Error(res.error);
      return res.value.ticketId;
    };
    const sid = await supportId();
    await addTimeEntry(owner, sid, { duration: "2h", workedOn: "2026-11-02" }, { db, now });
    await addTimeEntry(owner, sid, { duration: "5h", workedOn: "2026-10-30" }, { db, now });

    expect((await getTeamTicketView(owner, id, "en", db, { now }))!.hours).toBeNull();

    await db.update(clients).set({ hoursMode: "internal" }).where(eq(clients.id, acme.id));
    expect((await getTeamTicketView(owner, id, "en", db, { now }))!.hours).toMatchObject({ mode: "internal", cycle: "2026-11", usedMinutes: 120 });

    await db.update(clients).set({ hoursMode: "package", includedMinutes: 60 }).where(eq(clients.id, acme.id));
    const pkg = (await getTeamTicketView(collab, id, "en", db, { now }))!.hours;
    expect(pkg).toMatchObject({ mode: "package", usedMinutes: 120, balanceMinutes: -60, totalMinutes: 60 });
  });
});
