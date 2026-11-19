import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { assignUserToTicket, canAccessTicket, canAssumeTicket, isStaff } from "@/lib/access";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import {
  agency,
  charges,
  clients,
  db as appDb,
  sites,
  ticketAssignments,
  tickets,
  users,
  type Client,
  type Db,
  type Ticket,
  type TicketStatus,
  type TicketType,
} from "@/lib/db";
import { MESSAGE_MAX_CHARS, messageBody } from "@/lib/sanitize";
import { takeNextAssignee } from "./assignments";
import { claimFiles } from "./attachments";
import { getClient } from "./clients";
import { insertMessage, type ActorRef } from "./messages";
import { fail, ok, type Result } from "./result";
import { Abort, transact } from "./tx";

/**
 * Tickets: opening (team and portal), numbers, rotation, assignees and status.
 *
 * Lock order (global): agency row, then client rows, then users rows. Opening a ticket starts by
 * locking the agency row and `insertTicket` increments `agency.ticket_counter`, so the number, the
 * rotation pick and the insert all live in one transaction: when anything fails, the transaction rolls
 * back and neither the counter nor the rotation pointer moves.
 */

/** Test seam: the database. */
type Deps = { db?: Db };

export type TicketActor = TeamSession | PortalSession;
export type NewTeamTicket = {
  clientId: string;
  siteId?: string | null;
  type: TicketType;
  title: string;
  bodyHtml?: string;
  valueCents?: number | null;
  /** Uploaded files (by the opener, tied to nothing yet) that go with the first message. */
  attachmentIds?: string[];
};
export type NewPortalTicket = {
  siteId?: string | null;
  title: string;
  bodyHtml?: string;
  /** Uploaded files (by the person, tied to nothing yet) that go with the first message. */
  attachmentIds?: string[];
};

const TITLE_MAX = 200;
const MAX_CENTS = 2_147_483_647;
const uuid = z.uuid();

/** Locks the agency row first, the head of the global lock order, so the checks that follow cannot deadlock. */
async function lockAgency(tx: Db): Promise<void> {
  await tx.select({ id: agency.id }).from(agency).where(eq(agency.id, 1)).for("update");
}

/** Takes the next ticket number (also locks the agency row). Only `insertTicket` calls it. */
async function nextTicketNumber(tx: Db): Promise<number> {
  const [row] = await tx
    .update(agency)
    .set({ ticketCounter: sql`${agency.ticketCounter} + 1` })
    .where(eq(agency.id, 1))
    .returning({ n: agency.ticketCounter });
  if (!row) throw new Error("The agency is not installed.");
  return row.n;
}

/**
 * Numbers and inserts a ticket inside the caller's transaction (the counter update locks the agency
 * row, so this comes first in the global lock order). It creates no message and no assignee: the
 * caller does the rest of the opening and checks what it needs before.
 */
export async function insertTicket(
  tx: Db,
  input: {
    clientId: string;
    siteId: string | null;
    type: "single" | "support";
    title: string;
    valueCents: number | null;
    /** The quote item that made this ticket (quote execution only). */
    quoteItemId?: string | null;
    createdBy: ActorRef;
  },
): Promise<{ id: string; number: number }> {
  const number = await nextTicketNumber(tx);
  const [ticket] = await tx
    .insert(tickets)
    .values({
      number,
      clientId: input.clientId,
      siteId: input.siteId,
      type: input.type,
      title: input.title,
      valueCents: input.valueCents,
      quoteItemId: input.quoteItemId ?? null,
      createdByType: input.createdBy.type,
      createdById: input.createdBy.id,
    })
    .returning({ id: tickets.id });
  return { id: ticket.id, number };
}

type Body = { bodyHtml: string; bodyText: string } | null;

/** Validates the title and body shared by both sides. `body` is null when the message would be empty. */
function checkContent(title: string, bodyHtml: string | undefined): Result<{ title: string; body: Body }> {
  // Control characters and runs of whitespace (newlines, tabs) collapse to single spaces.
  const clean = (title ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (!clean || clean.length > TITLE_MAX) return fail("invalid");
  if ((bodyHtml ?? "").length > MESSAGE_MAX_CHARS) return fail("tooLong");
  return ok({ title: clean, body: bodyHtml ? messageBody(bodyHtml) : null });
}

/** The site, only when it belongs to the client. */
async function siteOf(db: Db, clientId: string, siteId: string) {
  if (!uuid.safeParse(siteId).success) return null;
  const [site] = await db
    .select()
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.clientId, clientId)));
  return site ?? null;
}

async function loadClient(db: Db, clientId: string, lock: boolean): Promise<Client | null> {
  const query = db.select().from(clients).where(eq(clients.id, clientId));
  const [client] = await (lock ? query.for("update") : query);
  return client ?? null;
}

async function checkTeamTarget(
  db: Db,
  clientId: string,
  input: NewTeamTicket,
  lock: boolean,
): Promise<Result<{ client: Client }>> {
  const client = await loadClient(db, clientId, lock);
  if (!client) return fail("notFound");
  if (input.siteId && !(await siteOf(db, client.id, input.siteId))) return fail("notFound");
  if (input.type === "support" && !client.supportActive) return fail("supportNeedsPlan");
  return ok({ client });
}

/**
 * A ticket opened by the team on a client they may see. The opener becomes its assignee. Files go
 * with the first message (an empty one when there is no text); a refused file leaves no ticket.
 */
export async function createTicket(
  actor: TeamSession,
  input: NewTeamTicket,
  deps: Deps = {},
): Promise<Result<{ ticketId: string; number: number }>> {
  const db = deps.db ?? appDb;
  if (input.type !== "single" && input.type !== "support") return fail("invalid");
  const content = checkContent(input.title, input.bodyHtml);
  if (!content.ok) return content;
  // The agreed value is staff business: for anyone else it is dropped (not an error), so a forged
  // field cannot set it; the form does not even show it to them.
  const valueCents = isStaff(actor.user) ? (input.valueCents ?? null) : null;
  if (valueCents !== null && (!Number.isSafeInteger(valueCents) || valueCents < 0 || valueCents > MAX_CENTS)) {
    return fail("invalid");
  }
  // An unselected <select> sends "": that means no site.
  const siteId = input.siteId || null;
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  const found = await getClient(actor, input.clientId, { db });
  if (!found.ok) return found;
  const clientId = found.value.id;

  return transact(db, async (tx) => {
    // The agency row first (insertTicket takes the number), then the client: the global lock order.
    await lockAgency(tx);
    // Lock the client and read it again: what was checked outside may have changed.
    const target = await checkTeamTarget(tx, clientId, { ...input, siteId }, true);
    if (!target.ok) throw new Abort(target.error);
    const ticket = await insertTicket(tx, {
      clientId,
      siteId,
      type: input.type,
      title: content.value.title,
      // Only a single ticket carries a value; a support ticket is covered by the monthly fee.
      valueCents: input.type === "single" ? valueCents : null,
      createdBy: { type: "agency", id: actor.user.id },
    });
    await assignUserToTicket({ id: ticket.id, clientId }, actor.user.id, tx);
    const author = { type: "agency" as const, id: actor.user.id };
    if (content.value.body || attachmentIds.length > 0) {
      const messageId = await insertMessage(tx, {
        ticketId: ticket.id,
        author,
        body: content.value.body ?? { bodyHtml: "", bodyText: "" },
      });
      const claimed = await claimFiles(tx, { ticketId: ticket.id, messageId, uploader: author, fileIds: attachmentIds });
      if (!claimed.ok) throw new Abort(claimed.error);
    }
    return { ticketId: ticket.id, number: ticket.number };
  });
}

async function checkPortalTarget(db: Db, clientId: string, siteId: string | null, lock: boolean): Promise<Result> {
  const client = await loadClient(db, clientId, lock);
  if (!client) return fail("notFound");
  if (!client.supportActive) return fail("supportInactive");
  if (siteId) {
    const site = await siteOf(db, client.id, siteId);
    if (!site?.includedInSupport) return fail("notFound");
  } else if (!client.generalTicketsEnabled) {
    return fail("generalDisabled");
  }
  return ok();
}

/**
 * A support ticket opened from the portal. The company is always the session's active one, never
 * anything the form says. The rotation picks the assignee inside the same transaction.
 */
export async function openPortalTicket(
  actor: PortalSession,
  input: NewPortalTicket,
  deps: Deps = {},
): Promise<Result<{ ticketId: string; number: number; assigneeId: string | null }>> {
  const db = deps.db ?? appDb;
  const content = checkContent(input.title, input.bodyHtml);
  if (!content.ok) return content;
  const clientId = actor.client.id;
  const siteId = input.siteId || null;
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];

  // Cheap refusal before the agency row is locked; the real check is under the lock below.
  const early = await checkPortalTarget(db, clientId, siteId, false);
  if (!early.ok) return early;

  return transact(db, async (tx) => {
    await lockAgency(tx);
    // Lock and re-read the client (agency, then client: the global order) before picking.
    const target = await checkPortalTarget(tx, clientId, siteId, true);
    if (!target.ok) throw new Abort(target.error);
    const assigneeId = await takeNextAssignee(clientId, tx);
    const ticket = await insertTicket(tx, {
      clientId,
      siteId,
      type: "support",
      title: content.value.title,
      valueCents: null,
      createdBy: { type: "client", id: actor.user.id },
    });
    if (assigneeId) await assignUserToTicket({ id: ticket.id, clientId }, assigneeId, tx);
    if (content.value.body || attachmentIds.length > 0) {
      const author = { type: "client" as const, id: actor.user.id };
      const messageId = await insertMessage(tx, {
        ticketId: ticket.id,
        author,
        body: content.value.body ?? { bodyHtml: "", bodyText: "" },
      });
      const claimed = await claimFiles(tx, { ticketId: ticket.id, messageId, uploader: author, fileIds: attachmentIds });
      if (!claimed.ok) throw new Abort(claimed.error);
    }
    return { ticketId: ticket.id, number: ticket.number, assigneeId };
  });
}

/**
 * "notFound" for a non-uuid, a missing ticket, a team member outside their scope, or a ticket of
 * another company than the portal session's (even for someone who belongs to both).
 */
export async function findTicket(actor: TicketActor, ticketId: string, db: Db = appDb): Promise<Result<Ticket>> {
  if (!uuid.safeParse(ticketId).success) return fail("notFound");
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!ticket) return fail("notFound");
  if (actor.userType === "client") {
    return ticket.clientId === actor.client.id ? ok(ticket) : fail("notFound");
  }
  return (await canAccessTicket(actor, ticket, db)) ? ok(ticket) : fail("notFound");
}

const statusSchema = z.enum(["open", "closed"]);

/** Closing records `closed_at`, reopening clears it; the same status again changes nothing. */
export async function setTicketStatus(
  actor: TeamSession,
  ticketId: string,
  status: TicketStatus,
  deps: Deps = {},
): Promise<Result<{ changed: boolean }>> {
  const db = deps.db ?? appDb;
  if (!statusSchema.safeParse(status).success) return fail("invalid");
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  // The condition makes two simultaneous changes to the same status count once.
  const rows = await db
    .update(tickets)
    .set({ status, closedAt: status === "closed" ? sql`now()` : null })
    .where(and(eq(tickets.id, found.value.id), sql`${tickets.status} <> ${status}`))
    .returning({ id: tickets.id });
  return ok({ changed: rows.length > 0 });
}

/**
 * Takes a ticket for the actor. The client row is read-locked (global order: client before
 * ticket) and the ticket row is locked, so two collaborators cannot both assume the same ticket.
 */
export async function assumeTicket(actor: TeamSession, ticketId: string, deps: Deps = {}): Promise<Result> {
  const db = deps.db ?? appDb;
  if (!uuid.safeParse(ticketId).success) return fail("notFound");
  return transact(db, async (tx) => {
    const [plain] = await tx.select({ clientId: tickets.clientId }).from(tickets).where(eq(tickets.id, ticketId));
    if (!plain) throw new Abort("notFound");
    await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, plain.clientId)).for("share");
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, ticketId)).for("update");
    if (!ticket) throw new Abort("notFound");
    if (!(await canAccessTicket(actor, ticket, tx))) throw new Abort("notFound");
    if (!(await canAssumeTicket(actor, ticket, tx))) throw new Abort("forbidden");
    await assignUserToTicket(ticket, actor.user.id, tx);
  });
}

/** Staff adds a team member to a ticket; the person also takes part in its client. */
export async function addTicketAssignee(
  actor: TeamSession,
  ticketId: string,
  userId: string,
  deps: Deps = {},
): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  if (!uuid.safeParse(userId).success) return fail("notFound");
  return transact(db, async (tx) => {
    // Client before user (global order); the ticket's client cannot disappear while it is share-locked.
    const locked = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, found.value.clientId))
      .for("share");
    if (locked.length === 0) throw new Abort("notFound");
    // Read the ticket again under the lock: a concurrent delete is notFound, not an FK error.
    const [still] = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, found.value.id)).for("share");
    if (!still) throw new Abort("notFound");
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("share");
    if (!user) throw new Abort("notFound");
    await assignUserToTicket(found.value, user.id, tx);
  });
}

/** Staff takes a team member off a ticket they can see. They stay in the client. */
export async function removeTicketAssignee(
  actor: TeamSession,
  ticketId: string,
  userId: string,
  deps: Deps = {},
): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  if (!uuid.safeParse(userId).success) return ok();
  await db
    .delete(ticketAssignments)
    .where(and(eq(ticketAssignments.ticketId, found.value.id), eq(ticketAssignments.userId, userId)));
  return ok();
}

/**
 * Sets or clears the agreed value of a single ticket. Staff only. Refused with `chargeExists` while
 * the ticket has a live or paid charge: its amount is a snapshot, so cancel it first.
 */
export async function updateTicketValue(
  actor: TeamSession,
  ticketId: string,
  valueCents: number | null,
  deps: Deps = {},
): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  if (valueCents !== null && (!Number.isSafeInteger(valueCents) || valueCents < 0 || valueCents > MAX_CENTS)) {
    return fail("invalid");
  }
  if (!uuid.safeParse(ticketId).success) return fail("notFound");
  const res = await transact(deps.db ?? appDb, async (tx) => {
    // The ticket, then its charges (global order). A charge being created holds the ticket (key
    // share), so this waits for it and then sees it.
    const [ticket] = await tx.select({ id: tickets.id, type: tickets.type }).from(tickets).where(eq(tickets.id, ticketId)).for("update");
    if (!ticket) throw new Abort("notFound");
    if (ticket.type !== "single") throw new Abort("invalid");
    const [live] = await tx
      .select({ id: charges.id })
      .from(charges)
      .where(and(eq(charges.ticketId, ticket.id), ne(charges.status, "canceled")))
      .limit(1);
    if (live) throw new Abort("chargeExists");
    await tx.update(tickets).set({ valueCents }).where(eq(tickets.id, ticket.id));
  });
  return res.ok ? ok() : res;
}
