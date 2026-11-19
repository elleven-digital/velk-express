import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientAssignments,
  clientMemberships,
  clientUsers,
  clients,
  files,
  messages,
  sites,
  ticketAssignments,
  tickets,
  users,
  type Client,
  type ClientUser,
  type Db,
  type User,
} from "@/lib/db";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { updateAutoAssign, updateClientAutoAssign, updateCollabVisibility } from "./assignments";
import { actorKey, resolveActorNames } from "./messages";
import { removeMember } from "./team";
import {
  addTicketAssignee,
  assumeTicket,
  createTicket,
  insertTicket,
  findTicket,
  openPortalTicket,
  removeTicketAssignee,
  setTicketStatus,
} from "./tickets";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let collab2: TeamSession;
let userA: User;
let userB: User;
let acme: Client;
let beta: Client;
let acmeSite: { id: string };
let acmeExcluded: { id: string };
let betaSite: { id: string };
let acmePerson: ClientUser;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
const asPortal = (user: ClientUser, client: Client): PortalSession => ({ userType: "client", user, client, role: "admin" });

async function makeUser(name: string, role: User["role"]): Promise<User> {
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
  return u;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  const o = await makeUser("Ana", "owner");
  const m = await makeUser("Beto", "manager");
  const c = await makeUser("Cy", "collaborator");
  const d = await makeUser("Dai", "collaborator");
  userA = c;
  userB = d;
  owner = asTeam(o);
  manager = asTeam(m);
  collab = asTeam(c);
  collab2 = asTeam(d);
  [acme] = await db.insert(clients).values({ name: "Acme", supportActive: true, generalTicketsEnabled: true }).returning();
  [beta] = await db.insert(clients).values({ name: "Beta", supportActive: true, generalTicketsEnabled: true }).returning();
  [acmeSite] = await db.insert(sites).values({ clientId: acme.id, name: "acme.test", includedInSupport: true }).returning({ id: sites.id });
  [acmeExcluded] = await db.insert(sites).values({ clientId: acme.id, name: "old.test", includedInSupport: false }).returning({ id: sites.id });
  [betaSite] = await db.insert(sites).values({ clientId: beta.id, name: "beta.test", includedInSupport: true }).returning({ id: sites.id });
  [acmePerson] = await db.insert(clientUsers).values({ name: "Paula", email: "paula@acme.test" }).returning();
  await db.insert(clientMemberships).values([
    { clientUserId: acmePerson.id, clientId: acme.id, role: "admin" },
    { clientUserId: acmePerson.id, clientId: beta.id, role: "admin" },
  ]);
});

afterAll(async () => {
  await db?.$client.end();
});

const counter = async () => (await db.select({ n: agency.ticketCounter }).from(agency))[0].n;
const assigneesOf = async (ticketId: string) =>
  (await db.select({ id: ticketAssignments.userId }).from(ticketAssignments).where(eq(ticketAssignments.ticketId, ticketId))).map((r) => r.id);
const inClient = async (clientId: string, userId: string) =>
  (await db.select().from(clientAssignments).where(and(eq(clientAssignments.clientId, clientId), eq(clientAssignments.userId, userId)))).length > 0;
const portal = () => asPortal(acmePerson, acme);

async function ticketOf(clientId: string, type: "single" | "support" = "support", title = "T") {
  const r = await createTicket(owner, { clientId, type, title }, { db });
  if (!r.ok) throw new Error(r.error);
  return r.value.ticketId;
}

async function expectNoDeadlock(results: PromiseSettledResult<unknown>[]) {
  for (const r of results) {
    if (r.status === "rejected") {
      const e = r.reason as { code?: string; cause?: { code?: string } };
      expect(e.code ?? e.cause?.code).not.toBe("40P01");
    }
  }
}

describe("insertTicket", () => {
  it("createTicket and openPortalTicket still number from the agency counter", async () => {
    const a = await createTicket(owner, { clientId: acme.id, type: "single", title: "One" }, { db });
    const b = await openPortalTicket(portal(), { title: "Two" }, { db });
    const c = await createTicket(owner, { clientId: beta.id, type: "single", title: "Three" }, { db });
    expect([a, b, c].map((r) => (r.ok ? r.value.number : null))).toEqual([1, 2, 3]);
    expect(await counter()).toBe(3);
  });

  it("insertTicket numbers inside the caller's transaction and rolls back with it", async () => {
    const made = await db.transaction(async (tx) => {
      const t = await insertTicket(tx as unknown as Db, {
        clientId: acme.id,
        siteId: acmeSite.id,
        type: "single",
        title: "Quoted",
        valueCents: 1234,
        createdBy: { type: "agency", id: owner.user.id },
      });
      const u = await insertTicket(tx as unknown as Db, {
        clientId: acme.id,
        siteId: null,
        type: "single",
        title: "Quoted 2",
        valueCents: null,
        createdBy: { type: "agency", id: owner.user.id },
      });
      return [t, u];
    });
    expect(made.map((t) => t.number)).toEqual([1, 2]);
    const [row] = await db.select().from(tickets).where(eq(tickets.id, made[0].id));
    expect(row).toMatchObject({ number: 1, clientId: acme.id, siteId: acmeSite.id, type: "single", valueCents: 1234, createdByType: "agency", createdById: owner.user.id });
    expect(await counter()).toBe(2);

    await expect(
      db.transaction(async (tx) => {
        await insertTicket(tx as unknown as Db, { clientId: acme.id, siteId: null, type: "single", title: "Gone", valueCents: null, createdBy: { type: "agency", id: owner.user.id } });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await counter()).toBe(2);
    expect(await db.select().from(tickets)).toHaveLength(2);
  });
});

describe("createTicket (team)", () => {
  it("numbers tickets one after the other, and the opener becomes assignee and joins the client", async () => {
    await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
    const a = await createTicket(collab, { clientId: acme.id, type: "single", title: "One" }, { db });
    const b = await createTicket(owner, { clientId: acme.id, type: "single", title: "Two" }, { db });
    expect(a).toMatchObject({ ok: true, value: { number: 1 } });
    expect(b).toMatchObject({ ok: true, value: { number: 2 } });
    if (!b.ok) return;
    expect(await assigneesOf(b.value.ticketId)).toEqual([owner.user.id]);
    expect(await inClient(acme.id, owner.user.id)).toBe(true);
  });

  it("refuses a support ticket on a client without support", async () => {
    await db.update(clients).set({ supportActive: false }).where(eq(clients.id, acme.id));
    expect(await createTicket(owner, { clientId: acme.id, type: "support", title: "x" }, { db })).toEqual({ ok: false, error: "supportNeedsPlan" });
    expect(await counter()).toBe(0);
  });

  it("refuses another client's site and a hidden client", async () => {
    expect(await createTicket(owner, { clientId: acme.id, siteId: betaSite.id, type: "single", title: "x" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await createTicket(owner, { clientId: acme.id, siteId: "nope", type: "single", title: "x" }, { db })).toEqual({ ok: false, error: "notFound" });
    // A collaborator outside the client (default scope: assigned) cannot see it.
    expect(await createTicket(collab, { clientId: acme.id, type: "single", title: "x" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await createTicket(owner, { clientId: "nope", type: "single", title: "x" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await counter()).toBe(0);
  });

  it("treats an empty site id as no site", async () => {
    const r = await createTicket(owner, { clientId: acme.id, siteId: "", type: "single", title: "x" }, { db });
    if (!r.ok) throw new Error(r.error);
    const [t] = await db.select().from(tickets).where(eq(tickets.id, r.value.ticketId));
    expect(t.siteId).toBeNull();
  });

  it("collapses whitespace and control characters in the title", async () => {
    const r = await createTicket(owner, { clientId: acme.id, type: "single", title: " a\n\tb\u0000  c " }, { db });
    if (!r.ok) throw new Error(r.error);
    const [t] = await db.select().from(tickets).where(eq(tickets.id, r.value.ticketId));
    expect(t.title).toBe("a b c");
  });

  it("keeps the value only for a single ticket", async () => {
    const s = await createTicket(owner, { clientId: acme.id, type: "single", title: "s", valueCents: 15000 }, { db });
    const p = await createTicket(owner, { clientId: acme.id, type: "support", title: "p", valueCents: 15000 }, { db });
    if (!s.ok || !p.ok) throw new Error("expected ok");
    const [rs] = await db.select().from(tickets).where(eq(tickets.id, s.value.ticketId));
    const [rp] = await db.select().from(tickets).where(eq(tickets.id, p.value.ticketId));
    expect(rs.valueCents).toBe(15000);
    expect(rp.valueCents).toBeNull();
    expect(await createTicket(owner, { clientId: acme.id, type: "single", title: "s", valueCents: -1 }, { db })).toEqual({ ok: false, error: "invalid" });
  });

  it("takes the agreed value only from staff: a collaborator's value is dropped, not an error", async () => {
    await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
    const byCollab = await createTicket(collab, { clientId: acme.id, type: "single", title: "c", valueCents: 15000 }, { db });
    const byManager = await createTicket(manager, { clientId: acme.id, type: "single", title: "m", valueCents: 15000 }, { db });
    if (!byCollab.ok || !byManager.ok) throw new Error("expected ok");
    const [rc] = await db.select().from(tickets).where(eq(tickets.id, byCollab.value.ticketId));
    const [rm] = await db.select().from(tickets).where(eq(tickets.id, byManager.value.ticketId));
    expect(rc.valueCents).toBeNull();
    expect(rm.valueCents).toBe(15000);
  });

  it("rejects empty and over-long titles and over-long bodies", async () => {
    expect(await createTicket(owner, { clientId: acme.id, type: "single", title: "   " }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await createTicket(owner, { clientId: acme.id, type: "single", title: "x".repeat(201) }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await createTicket(owner, { clientId: acme.id, type: "single", title: "x".repeat(200) }, { db })).toMatchObject({ ok: true });
    expect(await createTicket(owner, { clientId: acme.id, type: "single", title: "x", bodyHtml: "a".repeat(100_001) }, { db })).toEqual({ ok: false, error: "tooLong" });
  });

  it("stores a sanitized body, and claims only the author's own loose inline images", async () => {
    const [mine] = await db.insert(files).values({ storageKey: "k1", name: "a.png", mime: "image/png", sizeBytes: 1, uploadedByType: "agency", uploadedById: owner.user.id, inline: true }).returning();
    const [theirs] = await db.insert(files).values({ storageKey: "k2", name: "b.png", mime: "image/png", sizeBytes: 1, uploadedByType: "agency", uploadedById: manager.user.id, inline: true }).returning();
    const r = await createTicket(
      owner,
      {
        clientId: acme.id,
        type: "single",
        title: "x",
        bodyHtml: `<p onclick="x()">hi<script>alert(1)</script></p><img src="/api/files/${mine.id}"><img src="/api/files/${theirs.id}"><img src="https://evil.test/a.png">`,
      },
      { db },
    );
    if (!r.ok) throw new Error(r.error);
    const [msg] = await db.select().from(messages).where(eq(messages.ticketId, r.value.ticketId));
    expect(msg.bodyHtml).toBe(`<p>hi</p><img src="/api/files/${mine.id}" /><img src="/api/files/${theirs.id}" />`);
    expect(msg.bodyText).toBe("hi");
    const [m1] = await db.select().from(files).where(eq(files.id, mine.id));
    const [m2] = await db.select().from(files).where(eq(files.id, theirs.id));
    expect(m1).toMatchObject({ ticketId: r.value.ticketId, messageId: msg.id });
    expect(m2).toMatchObject({ ticketId: null, messageId: null });
    const [t] = await db.select().from(tickets).where(eq(tickets.id, r.value.ticketId));
    expect(t.lastMessageAt).not.toBeNull();
  });

  it("opens without a message when the body is empty", async () => {
    const r = await createTicket(owner, { clientId: acme.id, type: "single", title: "x", bodyHtml: "<p> </p>" }, { db });
    if (!r.ok) throw new Error(r.error);
    expect(await db.select().from(messages).where(eq(messages.ticketId, r.value.ticketId))).toHaveLength(0);
  });

  it("claims the opener's uploaded files on the first message, even without text", async () => {
    const [mine] = await db
      .insert(files)
      .values({ storageKey: "attachments/a", name: "brief.pdf", mime: "application/pdf", sizeBytes: 2_000_000, uploadedByType: "agency", uploadedById: owner.user.id, inline: false })
      .returning();
    const r = await createTicket(owner, { clientId: acme.id, type: "single", title: "with file", attachmentIds: [mine.id] }, { db });
    if (!r.ok) throw new Error(r.error);
    const [msg] = await db.select().from(messages).where(eq(messages.ticketId, r.value.ticketId));
    expect(msg.bodyText).toBe("");
    const [claimed] = await db.select().from(files).where(eq(files.id, mine.id));
    expect(claimed).toMatchObject({ ticketId: r.value.ticketId, messageId: msg.id });
  });

  it("a file that is not the opener's refuses the whole ticket", async () => {
    const [theirs] = await db
      .insert(files)
      .values({ storageKey: "attachments/b", name: "x.pdf", mime: "application/pdf", sizeBytes: 10, uploadedByType: "agency", uploadedById: manager.user.id, inline: false })
      .returning();
    const r = await createTicket(owner, { clientId: acme.id, type: "single", title: "x", bodyHtml: "<p>hi</p>", attachmentIds: [theirs.id] }, { db });
    expect(r).toEqual({ ok: false, error: "notFound" });
    expect(await db.select().from(tickets)).toHaveLength(0);
    expect(await counter()).toBe(0);
  });

  it("a failed insert advances neither the counter nor anything else", async () => {
    // A team member who no longer exists: the assignment fails after the number was taken.
    const ghost = asTeam({ ...owner.user, id: "99999999-9999-4999-8999-999999999999" });
    await expect(createTicket(ghost, { clientId: acme.id, type: "single", title: "x" }, { db })).rejects.toBeTruthy();
    expect(await counter()).toBe(0);
    expect(await db.select().from(tickets)).toHaveLength(0);
    expect(await createTicket(owner, { clientId: acme.id, type: "single", title: "x" }, { db })).toMatchObject({ value: { number: 1 } });
  });

  it("two team tickets opened at once get distinct numbers", async () => {
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createTicket(i % 2 ? owner : manager, { clientId: acme.id, type: "single", title: `t${i}` }, { db })),
    );
    const numbers = rs.map((r) => (r.ok ? r.value.number : -1)).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("openPortalTicket", () => {
  it("is refused while support is inactive", async () => {
    await db.update(clients).set({ supportActive: false }).where(eq(clients.id, acme.id));
    expect(await openPortalTicket(portal(), { siteId: acmeSite.id, title: "x" }, { db })).toEqual({ ok: false, error: "supportInactive" });
    expect(await counter()).toBe(0);
  });

  it("is refused for a site outside support or in another company, even for a member of both", async () => {
    expect(await openPortalTicket(portal(), { siteId: acmeExcluded.id, title: "x" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await openPortalTicket(portal(), { siteId: betaSite.id, title: "x" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await openPortalTicket(portal(), { siteId: "nope", title: "x" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await counter()).toBe(0);
  });

  it("refuses a general ticket when they are off, and accepts it when on", async () => {
    await db.update(clients).set({ generalTicketsEnabled: false }).where(eq(clients.id, acme.id));
    expect(await openPortalTicket(portal(), { title: "x" }, { db })).toEqual({ ok: false, error: "generalDisabled" });
    // The session's client row is stale on purpose: the live row decides.
    await db.update(clients).set({ generalTicketsEnabled: true }).where(eq(clients.id, acme.id));
    expect(await openPortalTicket(portal(), { title: "x" }, { db })).toMatchObject({ ok: true });
  });

  it("opens in the session's company, as a support ticket created by the client", async () => {
    const r = await openPortalTicket(asPortal(acmePerson, beta), { siteId: betaSite.id, title: " Help ", bodyHtml: "<p>hi</p>" }, { db });
    if (!r.ok) throw new Error(r.error);
    const [t] = await db.select().from(tickets).where(eq(tickets.id, r.value.ticketId));
    expect(t).toMatchObject({ clientId: beta.id, type: "support", title: "Help", createdByType: "client", createdById: acmePerson.id, valueCents: null });
    const [msg] = await db.select().from(messages).where(eq(messages.ticketId, t.id));
    expect(msg).toMatchObject({ authorType: "client", authorId: acmePerson.id });
  });

  it("assigns the client rotation's pick, and nobody without a rotation", async () => {
    const none = await openPortalTicket(portal(), { title: "x" }, { db });
    expect(none).toMatchObject({ ok: true, value: { assigneeId: null } });
    if (none.ok) expect(await assigneesOf(none.value.ticketId)).toEqual([]);

    await db.insert(clientAssignments).values({ clientId: acme.id, userId: userA.id });
    expect((await updateClientAutoAssign(owner, acme.id, { enabled: true, userIds: [userA.id] }, { db })).ok).toBe(true);
    const r = await openPortalTicket(portal(), { title: "y" }, { db });
    expect(r).toMatchObject({ ok: true, value: { assigneeId: userA.id } });
    if (r.ok) expect(await assigneesOf(r.value.ticketId)).toEqual([userA.id]);
  });

  it("the general rotation's pick joins the client and the ticket", async () => {
    expect((await updateAutoAssign(owner, { enabled: true, userIds: [userB.id] }, { db })).ok).toBe(true);
    expect(await inClient(acme.id, userB.id)).toBe(false);
    const r = await openPortalTicket(portal(), { title: "x" }, { db });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.assigneeId).toBe(userB.id);
    expect(await inClient(acme.id, userB.id)).toBe(true);
    expect(await assigneesOf(r.value.ticketId)).toEqual([userB.id]);
  });

  it("concurrent portal openings get distinct numbers and alternate assignees", async () => {
    expect((await updateAutoAssign(owner, { enabled: true, userIds: [userA.id, userB.id] }, { db })).ok).toBe(true);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => openPortalTicket(portal(), { title: `t${i}` }, { db })));
    const values = rs.map((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.value;
    });
    expect(values.map((v) => v.number).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(values.filter((v) => v.assigneeId === userA.id)).toHaveLength(3);
    expect(values.filter((v) => v.assigneeId === userB.id)).toHaveLength(3);
    expect(await counter()).toBe(6);
  });

  it("removeMember while a client opens a ticket never deadlocks", async () => {
    for (let round = 0; round < 20; round++) {
      const extra = await makeUser(`Extra${round}`, "collaborator");
      expect((await updateAutoAssign(owner, { enabled: true, userIds: [userA.id, extra.id] }, { db })).ok).toBe(true);
      const results = await Promise.allSettled([
        openPortalTicket(portal(), { title: `r${round}` }, { db }),
        removeMember(owner, extra.id, { db }),
      ]);
      await expectNoDeadlock(results);
      for (const r of results) expect(r.status).toBe("fulfilled");
    }
  });
});

describe("findTicket", () => {
  it("is notFound for another company's ticket, even for a member of both", async () => {
    const betaTicket = await ticketOf(beta.id);
    const mine = await ticketOf(acme.id);
    expect(await findTicket(asPortal(acmePerson, acme), betaTicket, db)).toEqual({ ok: false, error: "notFound" });
    expect(await findTicket(asPortal(acmePerson, acme), mine, db)).toMatchObject({ ok: true });
    expect(await findTicket(asPortal(acmePerson, beta), betaTicket, db)).toMatchObject({ ok: true });
  });

  it("is notFound for a team member outside their scope, a non-uuid and a missing id", async () => {
    const id = await ticketOf(acme.id);
    expect(await findTicket(collab, id, db)).toEqual({ ok: false, error: "notFound" });
    await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
    expect(await findTicket(collab, id, db)).toMatchObject({ ok: true });
    expect(await findTicket(owner, "x", db)).toEqual({ ok: false, error: "notFound" });
    expect(await findTicket(owner, "99999999-9999-4999-8999-999999999999", db)).toEqual({ ok: false, error: "notFound" });
    expect(await findTicket(asPortal(acmePerson, acme), "x", db)).toEqual({ ok: false, error: "notFound" });
  });
});

describe("setTicketStatus", () => {
  it("closing records closed_at, reopening clears it, repeating changes nothing", async () => {
    const id = await ticketOf(acme.id);
    expect(await setTicketStatus(owner, id, "open", { db })).toEqual({ ok: true, value: { changed: false } });
    expect(await setTicketStatus(owner, id, "closed", { db })).toEqual({ ok: true, value: { changed: true } });
    const [closed] = await db.select().from(tickets).where(eq(tickets.id, id));
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();
    expect(await setTicketStatus(owner, id, "closed", { db })).toEqual({ ok: true, value: { changed: false } });
    expect(await setTicketStatus(owner, id, "open", { db })).toEqual({ ok: true, value: { changed: true } });
    const [reopened] = await db.select().from(tickets).where(eq(tickets.id, id));
    expect(reopened).toMatchObject({ status: "open", closedAt: null });
  });

  it("is notFound outside the member's scope and invalid for an unknown status", async () => {
    const id = await ticketOf(acme.id);
    expect(await setTicketStatus(collab, id, "closed", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await setTicketStatus(owner, id, "nope" as never, { db })).toEqual({ ok: false, error: "invalid" });
  });
});

describe("assignees", () => {
  it("a collaborator assumes a visible unassigned ticket; one that has an assignee is forbidden", async () => {
    await db.insert(clientAssignments).values([
      { clientId: acme.id, userId: collab.user.id },
      { clientId: acme.id, userId: collab2.user.id },
    ]);
    const id = await ticketOf(acme.id);
    await db.delete(ticketAssignments).where(eq(ticketAssignments.ticketId, id));
    expect((await assumeTicket(collab, id, { db })).ok).toBe(true);
    expect(await assigneesOf(id)).toEqual([collab.user.id]);
    expect(await assumeTicket(collab2, id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await assumeTicket(collab2, "x", { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("assuming a ticket outside the scope is notFound, and it joins the client", async () => {
    const id = await ticketOf(acme.id);
    await db.delete(ticketAssignments).where(eq(ticketAssignments.ticketId, id));
    expect(await assumeTicket(collab, id, { db })).toEqual({ ok: false, error: "notFound" });
    expect((await updateCollabVisibility(owner, { clientScope: "all", ticketScope: "all", seesUnassigned: true }, { db })).ok).toBe(true);
    expect((await assumeTicket(collab, id, { db })).ok).toBe(true);
    expect(await inClient(acme.id, collab.user.id)).toBe(true);
  });

  it("two collaborators assuming the same ticket at once: exactly one wins", async () => {
    await db.insert(clientAssignments).values([
      { clientId: acme.id, userId: collab.user.id },
      { clientId: acme.id, userId: collab2.user.id },
    ]);
    for (let round = 0; round < 10; round++) {
      const id = await ticketOf(acme.id);
      await db.delete(ticketAssignments).where(eq(ticketAssignments.ticketId, id));
      const results = await Promise.allSettled([assumeTicket(collab, id, { db }), assumeTicket(collab2, id, { db })]);
      await expectNoDeadlock(results);
      const values = results.map((r) => (r.status === "fulfilled" ? r.value : null));
      expect(values.filter((v) => v?.ok)).toHaveLength(1);
      expect(values.filter((v) => v && !v.ok)).toEqual([{ ok: false, error: "forbidden" }]);
      expect(await assigneesOf(id)).toHaveLength(1);
    }
  });

  it("only staff add and remove assignees; the added person joins the client", async () => {
    const id = await ticketOf(acme.id);
    await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
    expect(await addTicketAssignee(collab, id, collab2.user.id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await removeTicketAssignee(collab, id, owner.user.id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect((await addTicketAssignee(manager, id, collab2.user.id, { db })).ok).toBe(true);
    expect(await assigneesOf(id)).toContain(collab2.user.id);
    expect(await inClient(acme.id, collab2.user.id)).toBe(true);
    expect((await addTicketAssignee(manager, id, collab2.user.id, { db })).ok).toBe(true);
    expect((await removeTicketAssignee(manager, id, collab2.user.id, { db })).ok).toBe(true);
    expect(await assigneesOf(id)).not.toContain(collab2.user.id);
  });

  it("add and remove refuse unknown users, bad ids and tickets", async () => {
    const id = await ticketOf(acme.id);
    expect(await addTicketAssignee(owner, id, "99999999-9999-4999-8999-999999999999", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await addTicketAssignee(owner, id, "x", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await addTicketAssignee(owner, "x", owner.user.id, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await removeTicketAssignee(owner, "x", owner.user.id, { db })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("resolveActorNames", () => {
  it("maps names by type and gives null for a removed author (no inner join)", async () => {
    const [ghostTeam, ghostClient] = ["99999999-9999-4999-8999-999999999991", "99999999-9999-4999-8999-999999999992"];
    // The same uuid as a team member must not resolve to a portal person, and the other way around.
    const names = await resolveActorNames(
      [
        { type: "agency", id: owner.user.id },
        { type: "client", id: acmePerson.id },
        { type: "client", id: owner.user.id },
        { type: "agency", id: ghostTeam },
        { type: "client", id: ghostClient },
        { type: "agency", id: owner.user.id },
      ],
      db,
    );
    expect(names.get(actorKey({ type: "agency", id: owner.user.id }))).toBe("Ana");
    expect(names.get(actorKey({ type: "client", id: acmePerson.id }))).toBe("Paula");
    expect(names.get(actorKey({ type: "client", id: owner.user.id }))).toBeNull();
    expect(names.get(actorKey({ type: "agency", id: ghostTeam }))).toBeNull();
    expect(names.get(actorKey({ type: "client", id: ghostClient }))).toBeNull();
    expect(names.size).toBe(5);
    expect((await resolveActorNames([], db)).size).toBe(0);
  });
});

