import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { agency, clientAssignments, clients, sites, ticketAssignments, tickets, users, type User } from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import {
  assignableUsersFor,
  assignUserToClient,
  assignUserToTicket,
  canAccessTicket,
  canAssumeTicket,
  ticketAssignees,
  visibleTicketsWhere,
  assignedClientIds,
  canAccessClient,
  getVisibility,
  isStaff,
  visibleClientsWhere,
} from "./access";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let a: { id: string };
let b: { id: string };
let owner: TeamSession;
let manager: TeamSession;
let collaborator: TeamSession;
let other: TeamSession;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  const [o] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner" }).returning();
  const [m] = await db.insert(users).values({ name: "Beto", email: "beto@x.com", role: "manager" }).returning();
  const [c] = await db.insert(users).values({ name: "Cy", email: "cy@x.com", role: "collaborator" }).returning();
  const [d] = await db.insert(users).values({ name: "Dai", email: "dai@x.com", role: "collaborator" }).returning();
  owner = asTeam(o);
  manager = asTeam(m);
  collaborator = asTeam(c);
  other = asTeam(d);
  [a] = await db.insert(clients).values({ name: "Client A" }).returning();
  [b] = await db.insert(clients).values({ name: "Client B" }).returning();
  await db.insert(clientAssignments).values({ clientId: a.id, userId: c.id });
});

afterAll(async () => {
  await db?.$client.end();
});

const setScope = (collabClientScope: "all" | "assigned") =>
  db.update(agency).set({ collabClientScope }).where(eq(agency.id, 1));

const visibleNames = async (session: TeamSession) => {
  const where = await visibleClientsWhere(session, db);
  const rows = await db.select({ name: clients.name }).from(clients).where(where).orderBy(clients.name);
  return rows.map((r) => r.name);
};

describe("isStaff", () => {
  it("is true for owner and manager only", () => {
    expect(isStaff(owner.user)).toBe(true);
    expect(isStaff(manager.user)).toBe(true);
    expect(isStaff(collaborator.user)).toBe(false);
  });
});

describe("getVisibility", () => {
  it("returns the agency defaults", async () => {
    expect(await getVisibility(db)).toEqual({ clientScope: "assigned", ticketScope: "all", seesUnassigned: true });
  });
});

describe("visibleClientsWhere / canAccessClient", () => {
  it("owner and manager see everything", async () => {
    for (const s of [owner, manager]) {
      expect(await visibleClientsWhere(s, db)).toBeUndefined();
      expect(await canAccessClient(s, b.id, db)).toBe(true);
    }
  });

  it("collaborator with assigned scope sees only assigned clients", async () => {
    expect(await visibleNames(collaborator)).toEqual(["Client A"]);
    expect(await canAccessClient(collaborator, a.id, db)).toBe(true);
    expect(await canAccessClient(collaborator, b.id, db)).toBe(false);
  });

  it("a collaborator with no assignment sees nothing", async () => {
    expect(await visibleNames(other)).toEqual([]);
    expect(await canAccessClient(other, a.id, db)).toBe(false);
  });

  it("the all scope shows every client", async () => {
    await setScope("all");
    expect(await visibleClientsWhere(other, db)).toBeUndefined();
    expect(await visibleNames(other)).toEqual(["Client A", "Client B"]);
    expect(await canAccessClient(other, b.id, db)).toBe(true);
  });

  it("canAccessClient is false, without throwing, for an id that is not a uuid", async () => {
    await expect(canAccessClient(collaborator, "x", db)).resolves.toBe(false);
    await setScope("all");
    await expect(canAccessClient(collaborator, "x", db)).resolves.toBe(false);
  });
});

describe("assignments", () => {
  it("assignUserToClient twice does not duplicate", async () => {
    await assignUserToClient(b.id, other.user.id, db);
    await assignUserToClient(b.id, other.user.id, db);
    const rows = await db.execute(sql`select 1 from client_assignments where client_id = ${b.id}`);
    expect(rows.length).toBe(1);
    expect(await assignedClientIds(other.user.id, db)).toEqual([b.id]);
  });

  it("assignableUsersFor with the assigned scope lists staff and the assigned, by name", async () => {
    expect((await assignableUsersFor(b.id, db)).map((u) => u.name)).toEqual(["Ana", "Beto"]);
    expect((await assignableUsersFor(a.id, db)).map((u) => u.name)).toEqual(["Ana", "Beto", "Cy"]);
  });

  it("assignableUsersFor with the all scope lists everyone", async () => {
    await setScope("all");
    expect((await assignableUsersFor(b.id, db)).map((u) => u.name)).toEqual(["Ana", "Beto", "Cy", "Dai"]);
  });
});

describe("tickets", () => {
  let tA1: { id: string; clientId: string };
  let tA2: typeof tA1;
  let tA3: typeof tA1;
  let tB1: typeof tA1;
  let all: { name: string; t: typeof tA1 }[];
  let seq = 0;

  const mk = async (clientId: string) => {
    const [t] = await db
      .insert(tickets)
      .values({
        number: ++seq,
        clientId,
        type: "single",
        title: "T",
        createdByType: "agency",
        createdById: crypto.randomUUID(),
      })
      .returning();
    return t;
  };

  beforeEach(async () => {
    seq = 0;
    tA1 = await mk(a.id);
    tA2 = await mk(a.id);
    tA3 = await mk(a.id);
    tB1 = await mk(b.id);
    all = [
      { name: "tA1", t: tA1 },
      { name: "tA2", t: tA2 },
      { name: "tA3", t: tA3 },
      { name: "tB1", t: tB1 },
    ];
    await db.insert(ticketAssignments).values([
      { ticketId: tA1.id, userId: collaborator.user.id },
      { ticketId: tA2.id, userId: other.user.id },
    ]);
  });

  const setScopes = (
    collabClientScope: "all" | "assigned",
    collabTicketScope: "all" | "assigned",
    collabSeesUnassigned: boolean,
  ) => db.update(agency).set({ collabClientScope, collabTicketScope, collabSeesUnassigned }).where(eq(agency.id, 1));

  /** The list, both without joins and with the joins the real queries use, must agree with each other and with canAccessTicket. */
  const visibleIds = async (session: TeamSession) => {
    const where = await visibleTicketsWhere(session, db);
    const plain = (await db.select({ id: tickets.id }).from(tickets).where(where)).map((r) => r.id).sort();
    const joined = (
      await db
        .select({ id: tickets.id })
        .from(tickets)
        .innerJoin(clients, eq(clients.id, tickets.clientId))
        .leftJoin(sites, eq(sites.id, tickets.siteId))
        .where(where)
    )
      .map((r) => r.id)
      .sort();
    expect(joined).toEqual(plain);
    for (const { t } of all) {
      expect(await canAccessTicket(session, t, db)).toBe(plain.includes(t.id));
    }
    return all.filter(({ t }) => plain.includes(t.id)).map(({ name }) => name);
  };

  it("staff see every ticket", async () => {
    for (const s of [owner, manager]) {
      expect(await visibleTicketsWhere(s, db)).toBeUndefined();
      expect(await visibleIds(s)).toEqual(["tA1", "tA2", "tA3", "tB1"]);
    }
  });

  it("assigned clients + all tickets", async () => {
    await setScopes("assigned", "all", true);
    expect(await visibleIds(collaborator)).toEqual(["tA1", "tA2", "tA3"]);
  });

  it("assigned clients + assigned tickets, with and without unassigned", async () => {
    await setScopes("assigned", "assigned", true);
    expect(await visibleIds(collaborator)).toEqual(["tA1", "tA3"]);
    await setScopes("assigned", "assigned", false);
    expect(await visibleIds(collaborator)).toEqual(["tA1"]);
  });

  it("all clients + assigned tickets + unassigned", async () => {
    await setScopes("all", "assigned", true);
    expect(await visibleIds(collaborator)).toEqual(["tA1", "tA3", "tB1"]);
  });

  it("a collaborator with no assignments sees nothing under assigned scopes", async () => {
    await setScopes("assigned", "all", true);
    expect(await visibleIds(other)).toEqual([]);
    await setScopes("assigned", "assigned", false);
    await db.delete(ticketAssignments);
    expect(await visibleIds(collaborator)).toEqual([]);
  });

  it("canAccessTicket refuses non-uuid ids without throwing", async () => {
    expect(await canAccessTicket(collaborator, { id: "nope", clientId: a.id }, db)).toBe(false);
    expect(await canAccessTicket(collaborator, { id: tA1.id, clientId: "nope" }, db)).toBe(false);
  });

  it("canAssumeTicket", async () => {
    await setScopes("assigned", "assigned", true);
    expect(await canAssumeTicket(collaborator, tA3, db)).toBe(true);
    expect(await canAssumeTicket(collaborator, tA2, db)).toBe(false);
    expect(await canAssumeTicket(collaborator, tB1, db)).toBe(false);
    await setScopes("assigned", "all", true);
    expect(await canAssumeTicket(collaborator, tA2, db)).toBe(false);
    expect(await canAssumeTicket(collaborator, tA3, db)).toBe(true);
    expect(await canAssumeTicket(owner, tA2, db)).toBe(true);
    expect(await canAssumeTicket(manager, tB1, db)).toBe(true);
  });

  it("assignUserToTicket is idempotent and also assigns the client", async () => {
    await assignUserToTicket(tB1, collaborator.user.id, db);
    await assignUserToTicket(tB1, collaborator.user.id, db);
    const rows = await db.execute(sql`select 1 from ticket_assignments where ticket_id = ${tB1.id}`);
    expect(rows.length).toBe(1);
    expect(await assignedClientIds(collaborator.user.id, db)).toContain(b.id);
  });

  it("ticketAssignees lists in assignment order", async () => {
    await db.insert(ticketAssignments).values({ ticketId: tA1.id, userId: other.user.id });
    await db.insert(ticketAssignments).values({ ticketId: tA3.id, userId: other.user.id });
    await db.insert(ticketAssignments).values({ ticketId: tA3.id, userId: collaborator.user.id });
    const map = await ticketAssignees([tA1.id, tA3.id, tB1.id], db);
    expect(map.get(tA1.id)?.map((u) => u.name)).toEqual(["Cy", "Dai"]);
    expect(map.get(tA3.id)?.map((u) => u.name)).toEqual(["Dai", "Cy"]);
    expect(map.get(tB1.id)).toBeUndefined();
    expect((await ticketAssignees([], db)).size).toBe(0);
  });
});
