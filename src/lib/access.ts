import "server-only";
import { and, asc, eq, exists, inArray, notExists, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { TeamSession } from "@/lib/auth/session";
import {
  agency,
  clientAssignments,
  clients,
  db as appDb,
  ticketAssignments,
  tickets,
  users,
  type CollabScope,
  type Db,
  type Ticket,
  type User,
} from "@/lib/db";

/**
 * The one place that answers "may this team member see this?". Pages, actions
 * and later stages (tickets, hours, quotes, charges) ask here instead of
 * reading roles or scopes themselves.
 */

/** What collaborators may see. Owner and manager always see everything. */
export type Visibility = { clientScope: CollabScope; ticketScope: CollabScope; seesUnassigned: boolean };

const uuid = z.uuid();

/** Owners and managers run the agency; collaborators work what they are given. */
export function isStaff(user: Pick<User, "role">): boolean {
  return user.role === "owner" || user.role === "manager";
}

/** The agency's visibility rules for collaborators. */
export async function getVisibility(db: Db = appDb): Promise<Visibility> {
  const [row] = await db
    .select({
      clientScope: agency.collabClientScope,
      ticketScope: agency.collabTicketScope,
      seesUnassigned: agency.collabSeesUnassigned,
    })
    .from(agency)
    .limit(1);
  // Before the install there is no row; fall back to the column defaults.
  return row ?? { clientScope: "assigned", ticketScope: "all", seesUnassigned: true };
}

export async function assignedClientIds(userId: string, db: Db = appDb): Promise<string[]> {
  const rows = await db
    .select({ clientId: clientAssignments.clientId })
    .from(clientAssignments)
    .where(eq(clientAssignments.userId, userId));
  return rows.map((r) => r.clientId);
}

/** Condition on `clients` for what this member may see: undefined means everything. */
export async function visibleClientsWhere(session: TeamSession, db: Db = appDb): Promise<SQL | undefined> {
  if (isStaff(session.user)) return undefined;
  if ((await getVisibility(db)).clientScope === "all") return undefined;
  return inArray(
    clients.id,
    db.select({ id: clientAssignments.clientId }).from(clientAssignments).where(eq(clientAssignments.userId, session.user.id)),
  );
}

/** Never throws: an id that is not a uuid is simply not accessible. */
export async function canAccessClient(session: TeamSession, clientId: string, db: Db = appDb): Promise<boolean> {
  if (!uuid.safeParse(clientId).success) return false;
  if (isStaff(session.user)) return true;
  if ((await getVisibility(db)).clientScope === "all") return true;
  const [row] = await db
    .select({ userId: clientAssignments.userId })
    .from(clientAssignments)
    .where(and(eq(clientAssignments.userId, session.user.id), eq(clientAssignments.clientId, clientId)));
  return Boolean(row);
}

/** Idempotent: taking part in a client is recorded once. */
export async function assignUserToClient(clientId: string, userId: string, db: Db = appDb): Promise<void> {
  await db.insert(clientAssignments).values({ clientId, userId }).onConflictDoNothing();
}

/** Who may be assigned to this client: staff always; collaborators per scope or assignment. By name. */
export async function assignableUsersFor(clientId: string, db: Db = appDb): Promise<User[]> {
  const all = await db.select().from(users).orderBy(asc(users.name), asc(users.id));
  if ((await getVisibility(db)).clientScope === "all") return all;
  // A non-uuid id names no client, so nobody is assigned to it: only staff qualify (and the query is skipped).
  if (!uuid.safeParse(clientId).success) return all.filter((u) => isStaff(u));
  const assigned = new Set(
    (
      await db
        .select({ userId: clientAssignments.userId })
        .from(clientAssignments)
        .where(eq(clientAssignments.clientId, clientId))
    ).map((r) => r.userId),
  );
  return all.filter((u) => isStaff(u) || assigned.has(u.id));
}

type TicketRef = Pick<Ticket, "id" | "clientId">;

/**
 * Condition on `tickets` for what this member may see: undefined means everything.
 * Only subqueries, so it works the same with or without joins around `tickets`.
 */
export async function visibleTicketsWhere(session: TeamSession, db: Db = appDb): Promise<SQL | undefined> {
  if (isStaff(session.user)) return undefined;
  const userId = session.user.id;
  const vis = await getVisibility(db);
  const parts: SQL[] = [];
  if (vis.clientScope === "assigned") {
    parts.push(
      inArray(
        tickets.clientId,
        db.select({ id: clientAssignments.clientId }).from(clientAssignments).where(eq(clientAssignments.userId, userId)),
      ),
    );
  }
  if (vis.ticketScope === "assigned") {
    const mine = exists(
      db
        .select({ one: ticketAssignments.ticketId })
        .from(ticketAssignments)
        .where(and(eq(ticketAssignments.ticketId, tickets.id), eq(ticketAssignments.userId, userId))),
    );
    const nobody = notExists(
      db.select({ one: ticketAssignments.ticketId }).from(ticketAssignments).where(eq(ticketAssignments.ticketId, tickets.id)),
    );
    parts.push((vis.seesUnassigned ? or(mine, nobody) : mine) as SQL);
  }
  return parts.length ? and(...parts) : undefined;
}

/** Never throws: ids that are not uuids are simply not accessible. Mirrors visibleTicketsWhere. */
export async function canAccessTicket(session: TeamSession, ticket: TicketRef, db: Db = appDb): Promise<boolean> {
  if (!uuid.safeParse(ticket.id).success || !uuid.safeParse(ticket.clientId).success) return false;
  if (isStaff(session.user)) return true;
  const vis = await getVisibility(db);
  if (vis.clientScope === "assigned" && !(await canAccessClient(session, ticket.clientId, db))) return false;
  if (vis.ticketScope === "all") return true;
  const rows = await db
    .select({ userId: ticketAssignments.userId })
    .from(ticketAssignments)
    .where(eq(ticketAssignments.ticketId, ticket.id));
  if (rows.some((r) => r.userId === session.user.id)) return true;
  return vis.seesUnassigned && rows.length === 0;
}

/** Staff: any ticket they see. Collaborator: a visible ticket nobody is assigned to. */
export async function canAssumeTicket(session: TeamSession, ticket: TicketRef, db: Db = appDb): Promise<boolean> {
  if (!(await canAccessTicket(session, ticket, db))) return false;
  if (isStaff(session.user)) return true;
  const [row] = await db
    .select({ userId: ticketAssignments.userId })
    .from(ticketAssignments)
    .where(eq(ticketAssignments.ticketId, ticket.id))
    .limit(1);
  return !row;
}

/**
 * Idempotent; the person also takes part in the ticket's client. Callers that need
 * both writes to be atomic pass a transaction as `db`.
 */
export async function assignUserToTicket(ticket: TicketRef, userId: string, db: Db = appDb): Promise<void> {
  // Client first: the global lock order is clients before users, and the ticket insert locks the users row.
  await assignUserToClient(ticket.clientId, userId, db);
  await db.insert(ticketAssignments).values({ ticketId: ticket.id, userId }).onConflictDoNothing();
}

/** Assignees per ticket, in assignment order. Tickets without any are absent from the map. */
export async function ticketAssignees(
  ticketIds: string[],
  db: Db = appDb,
): Promise<Map<string, Pick<User, "id" | "name">[]>> {
  const map = new Map<string, Pick<User, "id" | "name">[]>();
  if (ticketIds.length === 0) return map;
  const rows = await db
    .select({ ticketId: ticketAssignments.ticketId, id: users.id, name: users.name })
    .from(ticketAssignments)
    .innerJoin(users, eq(users.id, ticketAssignments.userId))
    .where(inArray(ticketAssignments.ticketId, ticketIds))
    .orderBy(asc(ticketAssignments.createdAt), asc(users.id));
  for (const r of rows) {
    const list = map.get(r.ticketId) ?? [];
    list.push({ id: r.id, name: r.name });
    map.set(r.ticketId, list);
  }
  return map;
}
