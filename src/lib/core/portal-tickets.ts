import "server-only";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PortalSession } from "@/lib/auth/session";
import { charges, clients, db as appDb, sites, tickets, timeEntries, type Db, type Ticket, type TicketStatus } from "@/lib/db";
import type { Locale } from "@/lib/i18n";
import { lastAuthorType, whoseTurn, type Turn } from "@/lib/turn";
import { payPathOf } from "./portal-payments";
import { isCompanyAdmin } from "./portal-quotes";
import { loadThread, loadTicketFiles, type FileItem, type ThreadMessage } from "./thread";
import { findTicket } from "./tickets";

/**
 * The client portal's view of tickets. The company is always the session's active one, never a
 * parameter, and every query selects named columns: the ticket's value, labels and assignees are
 * agency business and never leave this module.
 */

export type PortalTicketRow = {
  id: string;
  number: number;
  title: string;
  siteName: string | null;
  status: TicketStatus;
  turn: Turn;
  lastActivity: Date;
};

/** Open tickets whose move is the client's: the last live message (or the opener) is the agency's. */
const clientsTurn = sql`${tickets.status} = 'open' and coalesce(${lastAuthorType}, ${tickets.createdByType}) = 'agency'`;

/**
 * The active company's tickets, newest activity first. `limit` bounds the read; `awaitingOnly`
 * keeps the open tickets on the client's turn.
 */
export async function listPortalTickets(
  session: PortalSession,
  db: Db = appDb,
  opts: { limit?: number; awaitingOnly?: boolean } = {},
): Promise<PortalTicketRow[]> {
  const where: SQL | undefined = opts.awaitingOnly
    ? and(eq(tickets.clientId, session.client.id), clientsTurn)
    : eq(tickets.clientId, session.client.id);
  const query = db
    .select({
      id: tickets.id,
      number: tickets.number,
      title: tickets.title,
      siteName: sites.name,
      status: tickets.status,
      createdByType: tickets.createdByType,
      createdAt: tickets.createdAt,
      lastMessageAt: tickets.lastMessageAt,
      lastAuthor: lastAuthorType,
    })
    .from(tickets)
    .leftJoin(sites, eq(sites.id, tickets.siteId))
    .where(where)
    .orderBy(desc(sql`coalesce(${tickets.lastMessageAt}, ${tickets.createdAt})`), desc(tickets.number));
  const rows = await (opts.limit === undefined ? query : query.limit(opts.limit));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    siteName: r.siteName,
    status: r.status,
    turn: whoseTurn(r, r.lastAuthor),
    lastActivity: r.lastMessageAt ?? r.createdAt,
  }));
}

/** No labels, assignees, value or who-edited: they never reach the portal. */
export type PortalTicketView = {
  ticket: Pick<Ticket, "id" | "number" | "title" | "status" | "closedAt" | "createdAt">;
  siteName: string | null;
  turn: Turn;
  /** Total of every entry on the ticket; null outside the package mode or when nothing is logged. */
  timeLoggedMinutes: number | null;
  messages: ThreadMessage[];
  files: FileItem[];
  /**
   * The ticket's live charge, for the company's admins only: paid, or pending (with a pay link when
   * it has a provider). Null for portal collaborators and when there is none.
   */
  charge: { status: "pending" | "paid"; amountCents: number; currency: string; payPath: string | null } | null;
};

/** null when the ticket is not the active company's (also for someone who belongs to both). */
export async function getPortalTicketView(
  session: PortalSession,
  ticketId: string,
  locale: Locale,
  db: Db = appDb,
): Promise<PortalTicketView | null> {
  const found = await findTicket(session, ticketId, db);
  if (!found.ok) return null;
  const ticket = found.value;
  const [[row], [hoursRow], messages, files, charge] = await Promise.all([
    db
      .select({ siteName: sites.name, last: lastAuthorType })
      .from(tickets)
      .leftJoin(sites, eq(sites.id, tickets.siteId))
      .where(eq(tickets.id, ticket.id)),
    // Only the mode and one sum: entries, notes, dates and authors stay on the team's side.
    db
      .select({
        mode: clients.hoursMode,
        total: sql<number>`coalesce((select sum(${timeEntries.minutes}) from ${timeEntries} where ${timeEntries.ticketId} = ${ticket.id}), 0)::int`,
      })
      .from(clients)
      .where(eq(clients.id, session.client.id)),
    loadThread(session, ticket, locale, db),
    loadTicketFiles(session, ticket, locale, db),
    ticketCharge(session, ticket.id, db),
  ]);
  if (!row) return null;
  return {
    ticket: {
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      status: ticket.status,
      closedAt: ticket.closedAt,
      createdAt: ticket.createdAt,
    },
    siteName: row.siteName,
    turn: whoseTurn(ticket, row.last),
    timeLoggedMinutes: hoursRow?.mode === "package" && hoursRow.total > 0 ? hoursRow.total : null,
    messages,
    files,
    charge,
  };
}

/** The ticket's pending or paid charge, read only for the company's admin (the role is re-read). */
async function ticketCharge(session: PortalSession, ticketId: string, db: Db): Promise<PortalTicketView["charge"]> {
  if (!(await isCompanyAdmin(db, session))) return null;
  const [row] = await db
    .select({ status: charges.status, provider: charges.provider, payToken: charges.payToken, amountCents: charges.amountCents, currency: charges.currency })
    .from(charges)
    .where(and(eq(charges.ticketId, ticketId), eq(charges.clientId, session.client.id), inArray(charges.status, ["pending", "paid"])));
  if (!row) return null;
  return {
    status: row.status as "pending" | "paid",
    amountCents: row.amountCents,
    currency: row.currency,
    payPath: row.status === "pending" && row.provider ? payPathOf(row.payToken) : null,
  };
}

export type PortalNewTicketOptions = { canOpen: boolean; sites: { id: string; name: string }[]; generalAllowed: boolean };

/**
 * What the new-ticket form may offer, read fresh: tickets need active support; sites are those
 * included in it; "General" only when the agency allows it. Nothing is offered without support.
 */
export async function portalNewTicketOptions(session: PortalSession, db: Db = appDb): Promise<PortalNewTicketOptions> {
  const clientId = session.client.id;
  const [client] = await db
    .select({ supportActive: clients.supportActive, general: clients.generalTicketsEnabled })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (!client?.supportActive) return { canOpen: false, sites: [], generalAllowed: false };
  const covered = await db
    .select({ id: sites.id, name: sites.name })
    .from(sites)
    .where(and(eq(sites.clientId, clientId), eq(sites.includedInSupport, true)))
    .orderBy(asc(sites.name), asc(sites.id));
  return { canOpen: true, sites: covered, generalAllowed: client.general };
}
