import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import {
  agency,
  autoAssignUsers,
  clientAssignments,
  clients,
  users,
  type User,
} from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { assignableUsersFor, assignedClientIds, getVisibility } from "@/lib/access";
import {
  getClientTeam,
  setClientAssignees,
  setMemberClients,
  takeNextAssignee,
  updateAutoAssign,
  updateClientAutoAssign,
  updateCollabVisibility,
} from "./assignments";
import { getClient } from "./clients";
import { removeMember } from "./team";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let collab2: TeamSession;
let client: { id: string };
let client2: { id: string };

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  const [o] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner" }).returning();
  const [m] = await db.insert(users).values({ name: "Beto", email: "beto@x.com", role: "manager" }).returning();
  const [c] = await db.insert(users).values({ name: "Cy", email: "cy@x.com", role: "collaborator" }).returning();
  const [d] = await db.insert(users).values({ name: "Dai", email: "dai@x.com", role: "collaborator" }).returning();
  [client] = await db.insert(clients).values({ name: "Acme" }).returning({ id: clients.id });
  [client2] = await db.insert(clients).values({ name: "Beta" }).returning({ id: clients.id });
  owner = asTeam(o);
  manager = asTeam(m);
  collab = asTeam(c);
  collab2 = asTeam(d);
});

afterAll(async () => {
  await db?.$client.end();
});

const input = { clientScope: "all", ticketScope: "assigned", seesUnassigned: false } as const;

describe("updateCollabVisibility", () => {
  it("is forbidden for a manager and changes nothing", async () => {
    expect(await updateCollabVisibility(manager, input, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await getVisibility(db)).toEqual({ clientScope: "assigned", ticketScope: "all", seesUnassigned: true });
  });

  it("rejects an unknown scope", async () => {
    const bad = { ...input, clientScope: "x" } as never;
    expect(await updateCollabVisibility(owner, bad, { db })).toEqual({ ok: false, error: "invalid" });
    const bad2 = { ...input, ticketScope: "x" } as never;
    expect(await updateCollabVisibility(owner, bad2, { db })).toEqual({ ok: false, error: "invalid" });
  });

  it("lets the owner save and reads back what was saved", async () => {
    expect((await updateCollabVisibility(owner, input, { db })).ok).toBe(true);
    expect(await getVisibility(db)).toEqual({ clientScope: "all", ticketScope: "assigned", seesUnassigned: false });
  });
});

const assigneeIds = async (clientId: string) =>
  (await getClientTeam(clientId, db)).assignees.map((u) => u.id).sort();

describe("setClientAssignees", () => {
  it("is forbidden for a collaborator", async () => {
    expect(await setClientAssignees(collab, client.id, [collab.user.id], { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await assigneeIds(client.id)).toEqual([]);
  });

  it("lets a manager replace the set and ignores unknown or non-uuid ids", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await setClientAssignees(manager, client.id, [collab.user.id, collab2.user.id], { db })).ok).toBe(true);
    expect(await assigneeIds(client.id)).toEqual([collab.user.id, collab2.user.id].sort());
    expect((await setClientAssignees(manager, client.id, [collab2.user.id, unknown, "nope"], { db })).ok).toBe(true);
    expect(await assigneeIds(client.id)).toEqual([collab2.user.id]);
    expect((await setClientAssignees(manager, client.id, [], { db })).ok).toBe(true);
    expect(await assigneeIds(client.id)).toEqual([]);
  });

  it("lets a manager assign a collaborator who is not assigned yet, who then sees the client in the assigned scope", async () => {
    await updateCollabVisibility(owner, { clientScope: "assigned", ticketScope: "assigned", seesUnassigned: false }, { db });
    // Not assigned anywhere: hidden, yet still a team member the box must offer.
    expect(await assignedClientIds(collab2.user.id, db)).toEqual([]);
    expect(await getClient(collab2, client.id, { db })).toEqual({ ok: false, error: "notFound" });
    expect((await setClientAssignees(manager, client.id, [collab2.user.id], { db })).ok).toBe(true);
    expect(await assignedClientIds(collab2.user.id, db)).toEqual([client.id]);
    const seen = await getClient(collab2, client.id, { db });
    expect(seen.ok && seen.value.id).toBe(client.id);
    expect(await getClient(collab2, client2.id, { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("reports an unknown or non-uuid client", async () => {
    expect(await setClientAssignees(manager, "nope", [], { db })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("setMemberClients", () => {
  it("is forbidden for a manager", async () => {
    expect(await setMemberClients(manager, collab.user.id, [client.id], { db })).toEqual({ ok: false, error: "forbidden" });
  });

  it("lets the owner replace the member's clients", async () => {
    expect((await setMemberClients(owner, collab.user.id, [client.id, client2.id, "nope"], { db })).ok).toBe(true);
    expect((await assignedClientIds(collab.user.id, db)).sort()).toEqual([client.id, client2.id].sort());
    expect((await setMemberClients(owner, collab.user.id, [client2.id], { db })).ok).toBe(true);
    expect(await assignedClientIds(collab.user.id, db)).toEqual([client2.id]);
  });

  it("reports an unknown member", async () => {
    expect(await setMemberClients(owner, "nope", [], { db })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("updateClientAutoAssign", () => {
  const a = () => collab.user.id;
  const b = () => collab2.user.id;

  it("is forbidden for a collaborator", async () => {
    expect(await updateClientAutoAssign(collab, client.id, { enabled: true, userIds: [a()] }, { db })).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("makes everyone in the rotation a responsible of the client", async () => {
    const res = await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a(), b()] }, { db });
    expect(res).toEqual({ ok: true, value: { enabled: true } });
    expect(await assigneeIds(client.id)).toEqual([a(), b()].sort());
    expect((await getClientTeam(client.id, db)).rotation).toEqual({ enabled: true, userIds: [a(), b()] });
  });

  it("stays off with an empty list", async () => {
    const res = await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [] }, { db });
    expect(res).toEqual({ ok: true, value: { enabled: false } });
    expect((await getClientTeam(client.id, db)).rotation.enabled).toBe(false);
  });

  it("clears the pointer when the rotation is saved again", async () => {
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a(), b()] }, { db });
    expect(await takeNextAssignee(client.id, db)).toBe(a());
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a(), b()] }, { db });
    expect(await takeNextAssignee(client.id, db)).toBe(a());
  });
});

describe("takeNextAssignee", () => {
  const a = () => collab.user.id;
  const b = () => collab2.user.id;
  const c = () => manager.user.id;

  it("rotates through the client's list", async () => {
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a(), b()] }, { db });
    expect(await takeNextAssignee(client.id, db)).toBe(a());
    expect(await takeNextAssignee(client.id, db)).toBe(b());
    expect(await takeNextAssignee(client.id, db)).toBe(a());
  });

  it("uses the agency-wide rotation when the client has none", async () => {
    expect(await updateAutoAssign(manager, { enabled: true, userIds: [c()] }, { db })).toEqual({
      ok: true,
      value: { enabled: true },
    });
    expect(await takeNextAssignee(client.id, db)).toBe(c());
    expect(await takeNextAssignee(client.id, db)).toBe(c());
  });

  it("prefers the client's rotation over the agency's", async () => {
    await updateAutoAssign(manager, { enabled: true, userIds: [c()] }, { db });
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a()] }, { db });
    expect(await takeNextAssignee(client.id, db)).toBe(a());
    expect(await takeNextAssignee(client2.id, db)).toBe(c());
  });

  it("returns null when both are off, or the client does not exist", async () => {
    expect(await takeNextAssignee(client.id, db)).toBeNull();
    expect(await takeNextAssignee("nope", db)).toBeNull();
    expect(await takeNextAssignee("00000000-0000-4000-8000-000000000000", db)).toBeNull();
  });

  it("only turns the general rotation on with someone in it", async () => {
    expect(await updateAutoAssign(manager, { enabled: true, userIds: [] }, { db })).toEqual({
      ok: true,
      value: { enabled: false },
    });
    expect(await updateAutoAssign(collab, { enabled: true, userIds: [a()] }, { db })).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("takeNextAssignee from the general rotation makes the pick take part in the client", async () => {
    await updateAutoAssign(manager, { enabled: true, userIds: [c()] }, { db });
    expect(await takeNextAssignee(client.id, db)).toBe(c());
    expect(
      (await db.select().from(clientAssignments).where(eq(clientAssignments.clientId, client.id))).map((r) => r.userId),
    ).toEqual([c()]);
  });

  it("removeMember and takeNextAssignee at the same time never deadlock", async () => {
    for (let round = 0; round < 20; round++) {
      const [x] = await db.insert(users).values({ name: `X${round}`, email: `x${round}@x.com` }).returning();
      await updateAutoAssign(manager, { enabled: true, userIds: [a(), x.id] }, { db });
      const results = await Promise.allSettled([removeMember(owner, x.id, { db }), takeNextAssignee(client.id, db)]);
      const deadlocked = results.filter(
        (r) =>
          r.status === "rejected" &&
          ((r.reason as { code?: string })?.code === "40P01" || (r.reason as { cause?: { code?: string } })?.cause?.code === "40P01"),
      );
      expect(deadlocked).toEqual([]);
    }
  });

  it("gives two simultaneous callers different people", async () => {
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a(), b()] }, { db });
    const picked = await Promise.all([takeNextAssignee(client.id, db), takeNextAssignee(client.id, db)]);
    expect([...picked].sort()).toEqual([a(), b()].sort());
  });

  it("gives simultaneous callers different people on the agency-wide rotation too", async () => {
    await updateAutoAssign(manager, { enabled: true, userIds: [a(), b()] }, { db });
    const picked = await Promise.all([takeNextAssignee(client.id, db), takeNextAssignee(client2.id, db)]);
    expect([...picked].sort()).toEqual([a(), b()].sort());
  });
});

describe("unassigning leaves the client's rotation", () => {
  const a = () => collab.user.id;
  const b = () => collab2.user.id;
  const rotationOf = async () =>
    (await db.select().from(autoAssignUsers).where(eq(autoAssignUsers.clientId, client.id))).map((r) => r.userId);

  it("setClientAssignees drops the removed person from the rotation", async () => {
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a(), b()] }, { db });
    await setClientAssignees(manager, client.id, [b()], { db });
    expect(await rotationOf()).toEqual([b()]);
    expect(await takeNextAssignee(client.id, db)).toBe(b());
    expect(await takeNextAssignee(client.id, db)).toBe(b());
  });

  it("setMemberClients drops the removed person from the rotation", async () => {
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a(), b()] }, { db });
    await setMemberClients(owner, a(), [], { db });
    expect(await rotationOf()).toEqual([b()]);
    expect(await takeNextAssignee(client.id, db)).toBe(b());
  });

  it("turns the rotation off when it ends up empty", async () => {
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a()] }, { db });
    await setClientAssignees(manager, client.id, [], { db });
    expect(await rotationOf()).toEqual([]);
    expect((await getClientTeam(client.id, db)).rotation).toEqual({ enabled: false, userIds: [] });
    expect(await takeNextAssignee(client.id, db)).toBeNull();
  });
});

describe("pruning only touches the clients of the call", () => {
  it("leaves other clients' rotations alone, even an enabled-but-empty one", async () => {
    const [client3] = await db.insert(clients).values({ name: "Gamma" }).returning({ id: clients.id });
    const a = collab.user.id;
    const b = collab2.user.id;
    await updateClientAutoAssign(manager, client2.id, { enabled: true, userIds: [a] }, { db });
    await db.update(clients).set({ autoAssign: true, autoAssignLastUserId: b }).where(eq(clients.id, client3.id));
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [b] }, { db });

    await setClientAssignees(manager, client.id, [b], { db });
    await setMemberClients(owner, b, [client.id], { db });

    const team2 = await getClientTeam(client2.id, db);
    expect(team2.rotation).toEqual({ enabled: true, userIds: [a] });
    const [c3] = await db.select().from(clients).where(eq(clients.id, client3.id));
    expect(c3.autoAssign).toBe(true);
    expect(c3.autoAssignLastUserId).toBe(b);
  });
});

describe("assignableUsersFor", () => {
  it("does not throw on an id that is not a uuid and offers only staff", async () => {
    const list = await assignableUsersFor("nope", db);
    expect(list.map((u) => u.id).sort()).toEqual([owner.user.id, manager.user.id].sort());
  });
});

describe("removeMember with assignments and rotations", () => {
  it("leaves no rows or pointers for the removed member", async () => {
    const a = collab.user.id;
    const b = collab2.user.id;
    await updateClientAutoAssign(manager, client.id, { enabled: true, userIds: [a, b] }, { db });
    await updateAutoAssign(manager, { enabled: true, userIds: [a, b] }, { db });
    expect(await takeNextAssignee(client.id, db)).toBe(a);
    expect(await takeNextAssignee(client2.id, db)).toBe(a);

    expect((await removeMember(owner, a, { db })).ok).toBe(true);

    expect(await db.select().from(clientAssignments).where(eq(clientAssignments.userId, a))).toEqual([]);
    expect(await db.select().from(autoAssignUsers).where(eq(autoAssignUsers.userId, a))).toEqual([]);
    const [c1] = await db.select().from(clients).where(eq(clients.id, client.id));
    const [ag] = await db.select().from(agency);
    expect(c1.autoAssignLastUserId).toBeNull();
    expect(ag.autoAssignLastUserId).toBeNull();
    expect(await takeNextAssignee(client.id, db)).toBe(b);
  });
});
