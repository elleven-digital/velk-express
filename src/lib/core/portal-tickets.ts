import "server-only";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PortalSession } from "@/lib/auth/session";
import { charges, clientTicketReads, clients, db as appDb, sites, tickets, timeEntries, type Db, type Ticket, type TicketStatus } from "@/lib/db";
import type { Locale } from "@/lib/i18n";
import { portalUnreadCountSql } from "@/lib/unread";
import { payPathOf } from "./portal-payments";
import { isCompanyAdmin } from "./portal-quotes";
import { loadThread, loadTicketFiles, type FileItem, type ThreadMessage } from "./thread";
import { fail, ok, type Result } from "./result";
import { databaseNow } from "./ticket-view";
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
  isProject: boolean;
  /** Messages this login hasn't read yet (not their own, not deleted). */
  unread: number;
  lastActivity: Date;
  createdAt: Date;
  closedAt: Date | null;
};

/** Which tickets a list holds: plain tickets, projects, or both. */
export type PortalTicketKind = "tickets" | "projects" | "all";

const kindWhere = (kind: PortalTicketKind): SQL | undefined =>
  kind === "tickets" ? eq(tickets.isProject, false) : kind === "projects" ? eq(tickets.isProject, true) : undefined;


/**
 * The active company's tickets, newest activity first. `limit` bounds the read; `openOnly` keeps
 * the open ones; `kind` keeps plain tickets or projects (default both).
 */
export async function listPortalTickets(
  session: PortalSession,
  db: Db = appDb,
  opts: { limit?: number; kind?: PortalTicketKind; openOnly?: boolean } = {},
): Promise<PortalTicketRow[]> {
  const where = and(
    eq(tickets.clientId, session.client.id),
    opts.openOnly ? eq(tickets.status, "open") : undefined,
    kindWhere(opts.kind ?? "all"),
  );
  const query = db
    .select({
      id: tickets.id,
      number: tickets.number,
      title: tickets.title,
      siteName: sites.name,
      status: tickets.status,
      isProject: tickets.isProject,
      createdAt: tickets.createdAt,
      closedAt: tickets.closedAt,
      lastMessageAt: tickets.lastMessageAt,
      unread: portalUnreadCountSql(session.user.id, session.client.id),
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
    isProject: r.isProject,
    unread: r.unread,
    lastActivity: r.lastMessageAt ?? r.createdAt,
    createdAt: r.createdAt,
    closedAt: r.closedAt,
  }));
}

/**
 * Which parts of the portal the active company gets. Tickets: while it has the support plan or
 * has ever had a ticket (open or closed). Projects: once it has ever had one. Both read fresh.
 */
export async function portalSections(session: PortalSession, db: Db = appDb): Promise<{ tickets: boolean; projects: boolean }> {
  const clientId = session.client.id;
  const [[client], [kinds]] = await Promise.all([
    db.select({ supportActive: clients.supportActive }).from(clients).where(eq(clients.id, clientId)),
    db
      .select({
        tickets: sql<boolean>`coalesce(bool_or(not ${tickets.isProject}), false)`,
        projects: sql<boolean>`coalesce(bool_or(${tickets.isProject}), false)`,
      })
      .from(tickets)
      .where(eq(tickets.clientId, clientId)),
  ]);
  return { tickets: Boolean(client?.supportActive) || Boolean(kinds?.tickets), projects: Boolean(kinds?.projects) };
}

/** No labels, assignees, value or who-edited: they never reach the portal. */
export type PortalTicketView = {
  ticket: Pick<Ticket, "id" | "number" | "title" | "status" | "isProject" | "closedAt" | "createdAt">;
  siteName: string | null;
  /** Total of every entry on the ticket; null outside the package mode or when nothing is logged. */
  timeLoggedMinutes: number | null;
  messages: ThreadMessage[];
  files: FileItem[];
  /**
   * The ticket's live charge, for the company's admins only: paid, or pending (with a pay link when
   * it has a provider). Null for portal collaborators and when there is none.
   */
  charge: { status: "pending" | "paid"; amountCents: number; currency: string; payPath: string | null } | null;
  /** The database's clock when the page was read: what `MarkRead` sends back. */
  renderedAt: string;
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
  // Taken before anything is read, so a message arriving meanwhile stays unread after the mark.
  const renderedAt = await databaseNow(db);
  const [[row], [hoursRow], messages, files, charge] = await Promise.all([
    db
      .select({ siteName: sites.name })
      .from(tickets)
      .leftJoin(sites, eq(sites.id, tickets.siteId))
      .where(eq(tickets.id, ticket.id)),
    // Only whether the client sees hours, and one sum: entries, notes, dates and authors stay on the team's side.
    db
      .select({
        visible: clients.hoursVisible,
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
      isProject: ticket.isProject,
      closedAt: ticket.closedAt,
      createdAt: ticket.createdAt,
    },
    siteName: row.siteName,
    timeLoggedMinutes: hoursRow?.visible && hoursRow.total > 0 ? hoursRow.total : null,
    messages,
    files,
    charge,
    renderedAt,
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

/**
 * Marks a ticket of the active company read for this login, up to `at` (when its page was read),
 * clamped to the database's clock. A ticket of another company is notFound.
 */
export async function markPortalTicketRead(session: PortalSession, ticketId: string, at?: Date, db: Db = appDb): Promise<Result> {
  if (at && Number.isNaN(at.getTime())) return fail("invalid");
  const found = await findTicket(session, ticketId, db);
  if (!found.ok) return found;
  const mark = at
    ? sql`least(${new Date(Math.min(Math.max(at.getTime(), 0), Date.now() + 86_400_000)).toISOString()}::timestamptz, now())`
    : sql`now()`;
  await db
    .insert(clientTicketReads)
    .values({ clientUserId: session.user.id, ticketId: found.value.id, lastReadAt: mark })
    .onConflictDoUpdate({
      target: [clientTicketReads.clientUserId, clientTicketReads.ticketId],
      set: { lastReadAt: sql`greatest(${clientTicketReads.lastReadAt}, excluded.last_read_at)` },
    });
  return ok();
}

/** How many messages of a ticket of the active company this login hasn't read; 0 for any other ticket. */
export async function portalTicketUnread(session: PortalSession, ticketId: string, db: Db = appDb): Promise<number> {
  const found = await findTicket(session, ticketId, db);
  if (!found.ok) return 0;
  const [row] = await db
    .select({ unread: portalUnreadCountSql(session.user.id, session.client.id) })
    .from(tickets)
    .where(eq(tickets.id, found.value.id));
  return row?.unread ?? 0;
}
