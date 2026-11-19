import "server-only";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assignUserToClient, isStaff, type Visibility } from "@/lib/access";
import type { TeamSession } from "@/lib/auth/session";
import {
  agency,
  autoAssignUsers,
  clientAssignments,
  clients,
  db as appDb,
  users,
  type Db,
  type User,
} from "@/lib/db";
import { fail, ok, type Result } from "./result";

/** Test seam: the database. */
type Deps = { db?: Db };

const visibilitySchema = z.object({
  clientScope: z.enum(["all", "assigned"]),
  ticketScope: z.enum(["all", "assigned"]),
  seesUnassigned: z.boolean(),
});

/** What collaborators may see (owner only). Staff always see everything. */
export async function updateCollabVisibility(actor: TeamSession, input: Visibility, deps: Deps = {}): Promise<Result> {
  if (actor.user.role !== "owner") return fail("forbidden");
  const parsed = visibilitySchema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const db = deps.db ?? appDb;
  await db
    .update(agency)
    .set({
      collabClientScope: parsed.data.clientScope,
      collabTicketScope: parsed.data.ticketScope,
      collabSeesUnassigned: parsed.data.seesUnassigned,
    })
    .where(eq(agency.id, 1));
  return ok();
}

const uuid = z.uuid();

/** Only ids that are well-formed uuids and belong to a team member survive. */
async function existingUserIds(db: Db, wanted: string[]): Promise<string[]> {
  const valid = [...new Set(wanted.filter((id) => uuid.safeParse(id).success))];
  if (valid.length === 0) return [];
  const rows = await db.select({ id: users.id }).from(users).where(inArray(users.id, valid));
  return rows.map((r) => r.id);
}

async function existingClientIds(db: Db, wanted: string[]): Promise<string[]> {
  const valid = [...new Set(wanted.filter((id) => uuid.safeParse(id).success))];
  if (valid.length === 0) return [];
  const rows = await db.select({ id: clients.id }).from(clients).where(inArray(clients.id, valid));
  return rows.map((r) => r.id);
}

/**
 * Rotations (each client's and the agency's) that are on with nobody left in them turn off, pointer
 * reset. Run inside the caller's transaction, after whoever left the rotation is gone.
 */
export async function turnOffEmptyRotations(tx: Db): Promise<void> {
  await tx.execute(sql`
    update clients set auto_assign = false, auto_assign_last_user_id = null
    where auto_assign
      and not exists (select 1 from auto_assign_users a where a.client_id = clients.id)`);
  await tx.execute(sql`
    update agency set auto_assign = false, auto_assign_last_user_id = null
    where auto_assign
      and not exists (select 1 from auto_assign_users a where a.client_id is null)`);
}

/**
 * Keeps the given clients' rotations inside their team: whoever is no longer
 * assigned leaves the rotation, and a rotation left empty turns itself off
 * (pointer reset). Only the touched clients are looked at. Run in the same
 * transaction as the unassigning.
 */
async function pruneClientRotations(tx: Db, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  const ids = sql.join(clientIds.map((id) => sql`${id}::uuid`), sql`, `);
  await tx.execute(sql`
    delete from auto_assign_users a
    where a.client_id in (${ids})
      and not exists (select 1 from client_assignments c where c.client_id = a.client_id and c.user_id = a.user_id)`);
  await tx.execute(sql`
    update clients set auto_assign = false, auto_assign_last_user_id = null
    where id in (${ids}) and auto_assign
      and not exists (select 1 from auto_assign_users a where a.client_id = clients.id)`);
}

// ---------- who takes part in a client ----------

/** Replaces the team members taking part in a client (owner or manager). Unknown ids are ignored. */
export async function setClientAssignees(
  actor: TeamSession,
  clientId: string,
  userIds: string[],
  deps: Deps = {},
): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const [client] = await existingClientIds(db, [clientId]);
  if (!client) return fail("notFound");
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const wanted = await existingUserIds(txDb, userIds);
    await tx
      .delete(clientAssignments)
      .where(
        wanted.length > 0
          ? and(eq(clientAssignments.clientId, client), notInArray(clientAssignments.userId, wanted))
          : eq(clientAssignments.clientId, client),
      );
    for (const userId of wanted) await assignUserToClient(client, userId, txDb);
    await pruneClientRotations(txDb, [client]);
  });
  return ok();
}

/** Replaces the clients a team member takes part in (owner). Unknown ids are ignored. */
export async function setMemberClients(
  actor: TeamSession,
  memberId: string,
  clientIds: string[],
  deps: Deps = {},
): Promise<Result> {
  if (actor.user.role !== "owner") return fail("forbidden");
  const db = deps.db ?? appDb;
  const [member] = await existingUserIds(db, [memberId]);
  if (!member) return fail("notFound");
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const wanted = await existingClientIds(txDb, clientIds);
    const lost = await tx
      .delete(clientAssignments)
      .where(
        wanted.length > 0
          ? and(eq(clientAssignments.userId, member), notInArray(clientAssignments.clientId, wanted))
          : eq(clientAssignments.userId, member),
      )
      .returning({ clientId: clientAssignments.clientId });
    for (const clientId of wanted) await assignUserToClient(clientId, member, txDb);
    await pruneClientRotations(txDb, lost.map((r) => r.clientId));
  });
  return ok();
}

// ---------- automatic assignment (round robin) ----------

type RotationInput = { enabled: boolean; userIds: string[] };

/** Agency-wide rotation (owner or manager). It is only on while someone is in it; saving resets the pointer. */
export async function updateAutoAssign(
  actor: TeamSession,
  input: RotationInput,
  deps: Deps = {},
): Promise<Result<{ enabled: boolean }>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const enabled = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const wanted = await existingUserIds(txDb, input.userIds);
    await tx.delete(autoAssignUsers).where(isNull(autoAssignUsers.clientId));
    if (wanted.length > 0) await tx.insert(autoAssignUsers).values(wanted.map((userId) => ({ clientId: null, userId })));
    const on = input.enabled && wanted.length > 0;
    await tx.update(agency).set({ autoAssign: on, autoAssignLastUserId: null }).where(eq(agency.id, 1));
    return on;
  });
  return ok({ enabled });
}

/** One client's rotation, overriding the agency's (owner or manager). Everyone in it takes part in the client. */
export async function updateClientAutoAssign(
  actor: TeamSession,
  clientId: string,
  input: RotationInput,
  deps: Deps = {},
): Promise<Result<{ enabled: boolean }>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const [client] = await existingClientIds(db, [clientId]);
  if (!client) return fail("notFound");
  const enabled = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const wanted = await existingUserIds(txDb, input.userIds);
    await tx.delete(autoAssignUsers).where(eq(autoAssignUsers.clientId, client));
    if (wanted.length > 0) {
      await tx.insert(autoAssignUsers).values(wanted.map((userId) => ({ clientId: client, userId })));
      for (const userId of wanted) await assignUserToClient(client, userId, txDb);
    }
    const on = input.enabled && wanted.length > 0;
    await tx.update(clients).set({ autoAssign: on, autoAssignLastUserId: null }).where(eq(clients.id, client));
    return on;
  });
  return ok({ enabled });
}

/** Who takes part in a client and how its rotation is set. A non-uuid id has neither. */
export async function getClientTeam(
  clientId: string,
  db: Db = appDb,
): Promise<{ assignees: User[]; rotation: { enabled: boolean; userIds: string[] } }> {
  if (!uuid.safeParse(clientId).success) return { assignees: [], rotation: { enabled: false, userIds: [] } };
  const assignees = (
    await db
      .select({ user: users })
      .from(clientAssignments)
      .innerJoin(users, eq(users.id, clientAssignments.userId))
      .where(eq(clientAssignments.clientId, clientId))
      .orderBy(asc(users.name), asc(users.id))
  ).map((r) => r.user);
  const [row] = await db.select({ enabled: clients.autoAssign }).from(clients).where(eq(clients.id, clientId));
  const members = await db
    .select({ id: users.id })
    .from(autoAssignUsers)
    .innerJoin(users, eq(users.id, autoAssignUsers.userId))
    .where(eq(autoAssignUsers.clientId, clientId))
    .orderBy(asc(users.createdAt), asc(users.id));
  return { assignees, rotation: { enabled: row?.enabled ?? false, userIds: members.map((m) => m.id) } };
}

/** The agency-wide rotation (null client id). */
export async function getAgencyRotation(db: Db = appDb): Promise<{ enabled: boolean; userIds: string[] }> {
  const [row] = await db.select({ enabled: agency.autoAssign }).from(agency).limit(1);
  const members = await db
    .select({ id: users.id })
    .from(autoAssignUsers)
    .innerJoin(users, eq(users.id, autoAssignUsers.userId))
    .where(isNull(autoAssignUsers.clientId))
    .orderBy(asc(users.createdAt), asc(users.id));
  return { enabled: row?.enabled ?? false, userIds: members.map((m) => m.id) };
}

/** The candidate after `last`; the first one when `last` is null or no longer a candidate; null with no candidates. */
export function pickNext(candidates: string[], last: string | null): string | null {
  if (candidates.length === 0) return null;
  const at = last === null ? -1 : candidates.indexOf(last);
  return candidates[(at + 1) % candidates.length];
}

/**
 * Who gets the next ticket a client opens: the client's own rotation when it
 * is on, otherwise the agency's, otherwise nobody. Candidates are ordered by
 * when they joined the team. The agency row, then the client row, are locked for the
 * transaction (the global lock order), so two tickets opened at once never pick the same
 * person. A pick from the general rotation also joins the client.
 */
export async function takeNextAssignee(clientId: string, db: Db = appDb): Promise<string | null> {
  if (!uuid.safeParse(clientId).success) return null;
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Global lock order: the agency row first, then the client row.
    const [general] = await tx
      .select({ autoAssign: agency.autoAssign, last: agency.autoAssignLastUserId })
      .from(agency)
      .where(eq(agency.id, 1))
      .for("update");
    const [client] = await tx
      .select({ autoAssign: clients.autoAssign, last: clients.autoAssignLastUserId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .for("update");
    if (!client) return null;

    if (client.autoAssign) {
      const members = await tx
        .select({ id: users.id })
        .from(autoAssignUsers)
        .innerJoin(users, eq(users.id, autoAssignUsers.userId))
        .innerJoin(
          clientAssignments,
          and(eq(clientAssignments.clientId, clientId), eq(clientAssignments.userId, autoAssignUsers.userId)),
        )
        .where(eq(autoAssignUsers.clientId, clientId))
        .orderBy(asc(users.createdAt), asc(users.id));
      const next = pickNext(members.map((m) => m.id), client.last);
      if (next) {
        await tx.update(clients).set({ autoAssignLastUserId: next }).where(eq(clients.id, clientId));
        return next;
      }
    }

    if (!general?.autoAssign) return null;
    const members = await tx
      .select({ id: users.id })
      .from(autoAssignUsers)
      .innerJoin(users, eq(users.id, autoAssignUsers.userId))
      .where(isNull(autoAssignUsers.clientId))
      .orderBy(asc(users.createdAt), asc(users.id));
    const next = pickNext(members.map((m) => m.id), general.last);
    if (next) {
      await tx.update(agency).set({ autoAssignLastUserId: next }).where(eq(agency.id, 1));
      // Whoever the general rotation picks takes part in the client from now on.
      await assignUserToClient(clientId, next, txDb);
    }
    return next;
  });
}
