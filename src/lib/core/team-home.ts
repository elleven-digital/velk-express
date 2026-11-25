import "server-only";
import { and, between, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { assignedClientIds, isStaff } from "@/lib/access";
import { agencyTimeZone } from "@/lib/agency";
import type { TeamSession } from "@/lib/auth/session";
import { clients, db as appDb, messages, tickets, timeEntries, type Db } from "@/lib/db";
import { cycleKey, cycleRange } from "@/lib/hours";
import { actorKey, resolveActorNames } from "./messages";
import { countTickets, latestTickets, type TicketFilters, type TicketRow } from "./ticket-list";

/**
 * The team home: what needs the member now, the month's figures for their role and the latest
 * activity. Everything goes through the ticket list, so a collaborator only ever counts and sees
 * the tickets the list shows them. The month is the agency's, in its time zone.
 */

const NEEDS_YOU_MAX = 12;
const RECENT_MAX = 6;

/** Open tickets nobody has taken yet. */
const UNASSIGNED: TicketFilters = { status: "open", who: "unassigned" };
/** The member's own open tickets the client answered (the agency's move). */
const ANSWERED: TicketFilters = { status: "open", who: "mine", turn: "agency" };

export type StaffFigures = {
  role: "staff";
  openTickets: number;
  clientsWithSupport: number;
  /** Minutes logged this month on support tickets of clients with hours (internal or package). */
  minutesUsedThisMonth: number;
  /** Clients on a package whose balance this month is below zero. */
  negativeBalances: number;
};

export type CollaboratorFigures = {
  role: "collaborator";
  myOpenTickets: number;
  /** Open tickets nobody has taken, among the ones the collaborator sees. */
  unassigned: number;
  /** Clients the collaborator takes part in. */
  myClients: number;
};

/** A ticket with recent activity, newest first. */
export type ActivityItem = TicketRow;

export type TeamHome = {
  /** Open unassigned tickets and the member's own tickets the client answered, newest activity first. */
  needsYou: (TicketRow & { lastAuthorName: string | null })[];
  /** How many tickets need the member, beyond the ones listed. */
  needsYouTotal: number;
  figures: StaffFigures | CollaboratorFigures;
  recent: ActivityItem[];
};

const activityOf = (r: TicketRow) => (r.ticket.lastMessageAt ?? r.ticket.createdAt).getTime();

/** The list's order: newest activity first, then the higher number. */
const newestFirst = (a: TicketRow, b: TicketRow) => activityOf(b) - activityOf(a) || b.ticket.number - a.ticket.number;

/** Who wrote each ticket's latest (not deleted) message, by ticket; null when nobody did or the person is gone. */
async function lastAuthorNames(ticketIds: string[], db: Db): Promise<Map<string, string | null>> {
  const byTicket = new Map<string, string | null>();
  if (ticketIds.length === 0) return byTicket;
  const latest = await db
    .selectDistinctOn([messages.ticketId], { ticketId: messages.ticketId, type: messages.authorType, id: messages.authorId })
    .from(messages)
    .where(and(inArray(messages.ticketId, ticketIds), isNull(messages.deletedAt)))
    .orderBy(messages.ticketId, desc(messages.createdAt));
  const names = await resolveActorNames(latest, db);
  for (const m of latest) byTicket.set(m.ticketId, names.get(actorKey(m)) ?? null);
  return byTicket;
}

/** The agency's month in one aggregate per figure, never one query per client. */
async function staffFigures(actor: TeamSession, now: Date, db: Db): Promise<StaffFigures> {
  const cycle = cycleKey(now, await agencyTimeZone(db));
  const { start, end } = cycleRange(cycle);

  const openTickets = await countTickets(actor, { status: "open" }, db);
  const [support] = await db.select({ n: count() }).from(clients).where(eq(clients.supportActive, true));

  // What getHoursSummary counts as used, summed over the clients that keep hours.
  const [used] = await db
    .select({ minutes: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int` })
    .from(timeEntries)
    .innerJoin(tickets, eq(tickets.id, timeEntries.ticketId))
    .innerJoin(clients, eq(clients.id, timeEntries.clientId))
    .where(and(eq(clients.hoursTracked, true), eq(tickets.type, "support"), between(timeEntries.workedOn, start, end)));

  // getHoursSummary's balance (included + paid purchases - used) per client with included hours, in SQL.
  const usedOf = sql`coalesce((select sum(te.minutes) from time_entries te inner join tickets t on t.id = te.ticket_id
    where te.client_id = ${clients.id} and t.type = 'support' and te.worked_on between ${start}::date and ${end}::date), 0)`;
  const boughtOf = sql`coalesce((select sum(hp.minutes) from hour_purchases hp
    where hp.client_id = ${clients.id} and hp.cycle = ${cycle} and not hp.pending), 0)`;
  const [negative] = await db
    .select({ n: count() })
    .from(clients)
    .where(and(eq(clients.hoursLimited, true), sql`${clients.includedMinutes} + ${boughtOf} - ${usedOf} < 0`));

  return {
    role: "staff",
    openTickets,
    clientsWithSupport: Number(support?.n ?? 0),
    minutesUsedThisMonth: Number(used?.minutes ?? 0),
    negativeBalances: Number(negative?.n ?? 0),
  };
}

export async function getTeamHome(actor: TeamSession, now: Date = new Date(), deps: { db?: Db } = {}): Promise<TeamHome> {
  const db = deps.db ?? appDb;

  // The two halves never overlap (a ticket with an assignee is not unassigned), so totals add up.
  const unassigned = await countTickets(actor, UNASSIGNED, db);
  const answered = await countTickets(actor, ANSWERED, db);
  const candidates = [
    ...(await latestTickets(actor, UNASSIGNED, NEEDS_YOU_MAX, db)),
    ...(await latestTickets(actor, ANSWERED, NEEDS_YOU_MAX, db)),
  ];
  const needsYou = candidates.sort(newestFirst).slice(0, NEEDS_YOU_MAX);
  const names = await lastAuthorNames(
    needsYou.map((r) => r.ticket.id),
    db,
  );

  const figures: StaffFigures | CollaboratorFigures = isStaff(actor.user)
    ? await staffFigures(actor, now, db)
    : {
        role: "collaborator",
        myOpenTickets: await countTickets(actor, { status: "open", who: "mine" }, db),
        unassigned,
        myClients: (await assignedClientIds(actor.user.id, db)).length,
      };

  return {
    needsYou: needsYou.map((r) => ({ ...r, lastAuthorName: names.get(r.ticket.id) ?? null })),
    needsYouTotal: unassigned + answered,
    figures,
    recent: await latestTickets(actor, {}, RECENT_MAX, db),
  };
}
