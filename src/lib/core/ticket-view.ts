import "server-only";
import { eq, sql } from "drizzle-orm";
import { assignableUsersFor, canAssumeTicket, isStaff, ticketAssignees } from "@/lib/access";
import type { TeamSession } from "@/lib/auth/session";
import {
  clients,
  db as appDb,
  sites,
  tickets,
  type Client,
  type Db,
  type Label,
  type Site,
  type Ticket,
  type User,
} from "@/lib/db";
import { getDict, type Locale } from "@/lib/i18n";
import { agencyTimeZone } from "@/lib/agency";
import { cycleKey, todayInCycleZone } from "@/lib/hours";
import { lastAuthorType, whoseTurn, type Turn } from "@/lib/turn";
import { unreadCountSql } from "@/lib/unread";
import { getHoursSummary, listTicketTime, type TicketTimeEntry } from "./hours";
import { labelsByTicket, listLabels } from "./labels";
import { actorKey, resolveActorNames } from "./messages";
import { loadThread, loadTicketFiles, type FileItem, type ThreadMessage } from "./thread";
import { findTicket } from "./tickets";

/**
 * Everything the team's ticket page shows, in one read. It never writes: marking the ticket read
 * is the client's job (`MarkRead`, after the page is on screen), so a prefetch or a server render
 * leaves `ticket_reads` alone.
 */

export type TeamTicketView = {
  /** `valueCents` is cleared for people who may not see it. */
  ticket: Ticket;
  site: Pick<Site, "id" | "name"> | null;
  client: Pick<Client, "id" | "name" | "supportActive" | "hoursTracked" | "hoursLimited" | "includedMinutes">;
  openerName: string;
  turn: Turn;
  /** Messages of other people this member has not read, as of this read. */
  unread: number;
  assignees: Pick<User, "id" | "name">[];
  /** Staff only (else empty): team members who can be added and are not on the ticket yet. */
  assignable: Pick<User, "id" | "name">[];
  canAssume: boolean;
  labels: Label[];
  allLabels: Label[];
  /** Staff only, else null. */
  valueCents: number | null;
  messages: ThreadMessage[];
  files: FileItem[];
  /** Time logged on this ticket, newest work day first. */
  time: { entries: TicketTimeEntry[]; totalMinutes: number };
  /** The same entries by when they were logged, for the conversation's quiet lines. */
  timeEvents: { id: string; at: number; iso: string; name: string; mine: boolean; minutes: number }[];
  /** The client's hours for the CURRENT cycle while hours are tracked, else null. */
  hours: { limited: boolean; visible: boolean; cycle: string; usedMinutes: number; balanceMinutes: number; totalMinutes: number } | null;
  /** Today in the agency's time zone: the default and the latest day a time entry can have. */
  today: string;
  /** ISO instant taken from the database clock before anything was read; what `MarkRead` sends back. */
  renderedAt: string;
};

/**
 * The database's clock, as ISO with milliseconds, rounded up to the next millisecond so a message
 * written in the same millisecond that was read still counts as seen (Postgres keeps microseconds).
 */
export async function databaseNow(db: Db): Promise<string> {
  const [row] = await db.execute<{ now: string }>(
    sql`select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`,
  );
  return new Date(new Date(row.now).getTime() + 1).toISOString();
}

/** Pure read: never touches ticket_reads. null when the ticket does not exist or is outside the viewer's scope. */
export async function getTeamTicketView(
  actor: TeamSession,
  ticketId: string,
  locale: Locale,
  db: Db = appDb,
  deps: { now?: () => Date } = {},
): Promise<TeamTicketView | null> {
  // Taken before the thread loads: what this render shows counts as read, nothing newer.
  const renderedAt = await databaseNow(db);
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return null;
  const ticket = found.value;
  const staff = isStaff(actor.user);

  const [dict, header, [turnRow], people, applied, everyLabel, thread, files] = await Promise.all([
    getDict(locale),
    db
      .select({
        client: {
          id: clients.id,
          name: clients.name,
          supportActive: clients.supportActive,
          hoursTracked: clients.hoursTracked,
          hoursLimited: clients.hoursLimited,
          includedMinutes: clients.includedMinutes,
        },
        site: { id: sites.id, name: sites.name } })
      .from(tickets)
      .innerJoin(clients, eq(clients.id, tickets.clientId))
      .leftJoin(sites, eq(sites.id, tickets.siteId))
      .where(eq(tickets.id, ticket.id)),
    db
      .select({ last: lastAuthorType, unread: unreadCountSql(actor.user.id) })
      .from(tickets)
      .where(eq(tickets.id, ticket.id)),
    ticketAssignees([ticket.id], db),
    labelsByTicket([ticket.id], db),
    listLabels(db),
    loadThread(actor, ticket, locale, db),
    loadTicketFiles(actor, ticket, locale, db),
  ]);
  const [row] = header;
  if (!row) return null;

  const assignees = people.get(ticket.id) ?? [];
  const assignedToMe = assignees.some((a) => a.id === actor.user.id);
  const canAssume = !assignedToMe && (await canAssumeTicket(actor, ticket, db));
  const assignable = staff
    ? (await assignableUsersFor(ticket.clientId, db))
        .filter((u) => !assignees.some((a) => a.id === u.id))
        .map((u) => ({ id: u.id, name: u.name }))
    : [];

  const timed = await listTicketTime(actor, ticket.id, { db, locale });
  const time = timed.ok ? timed.value : { entries: [], totalMinutes: 0 };
  const timeEvents = time.entries
    .map((e) => ({ id: e.id, at: new Date(e.createdAt).getTime(), iso: e.createdAt, name: e.authorName, mine: e.mine, minutes: e.minutes }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const now = deps.now?.() ?? new Date();
  const timeZone = await agencyTimeZone(db);
  const summary =
    !row.client.hoursTracked ? null : await getHoursSummary(ticket.clientId, cycleKey(now, timeZone), { db });
  const hours =
    summary && summary.tracked
      ? {
          limited: summary.limited,
          visible: summary.visible,
          cycle: summary.cycle,
          usedMinutes: summary.usedMinutes,
          balanceMinutes: summary.balanceMinutes,
          totalMinutes: summary.includedMinutes + summary.purchasedMinutes,
        }
      : null;

  const opener = { type: ticket.createdByType, id: ticket.createdById };
  const names = await resolveActorNames([opener], db);

  return {
    ticket: staff ? ticket : { ...ticket, valueCents: null },
    // A left join with no match still yields an object of nulls.
    site: row.site && row.site.id ? row.site : null,
    client: row.client,
    openerName: names.get(actorKey(opener)) ?? dict.common.removedUser,
    turn: whoseTurn(ticket, turnRow?.last ?? null),
    unread: turnRow?.unread ?? 0,
    assignees,
    assignable,
    canAssume,
    labels: applied.get(ticket.id) ?? [],
    allLabels: everyLabel.map((l) => ({ id: l.id, name: l.name, color: l.color, createdAt: l.createdAt })),
    valueCents: staff ? ticket.valueCents : null,
    messages: thread,
    files,
    time,
    timeEvents,
    hours,
    today: todayInCycleZone(now, timeZone),
    renderedAt,
  };
}

/** How many messages of the ticket this member has not read (0 outside their scope). Pure read. */
export async function ticketUnread(actor: TeamSession, ticketId: string, db: Db = appDb): Promise<number> {
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return 0;
  const [row] = await db.select({ unread: unreadCountSql(actor.user.id) }).from(tickets).where(eq(tickets.id, found.value.id));
  return row?.unread ?? 0;
}
