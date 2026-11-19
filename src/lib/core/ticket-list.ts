import "server-only";
import { and, count, desc, eq, exists, ilike, notExists, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ticketAssignees, visibleTicketsWhere } from "@/lib/access";
import type { TeamSession } from "@/lib/auth/session";
import {
  clients,
  db as appDb,
  sites,
  ticketAssignments,
  ticketLabels,
  tickets,
  type Client,
  type Db,
  type Label,
  type Site,
  type Ticket,
  type TicketStatus,
  type User,
} from "@/lib/db";
import { lastAuthorType } from "@/lib/turn";
import { unreadCountSql, unreadWhere } from "@/lib/unread";
import { labelsByTicket } from "./labels";

/**
 * The team's ticket list: filters, search and paging over what the member may see. Every query
 * starts from `visibleTicketsWhere`; a filter can only narrow it, never widen it.
 */

export type TicketFilters = {
  status?: TicketStatus;
  clientId?: string;
  who?: "mine" | "unassigned";
  unread?: boolean;
  labelId?: string;
  q?: string;
};

/**
 * The ticket columns the list shows. Not the whole row: `valueCents` is staff business and no list
 * needs it, so it is never selected here.
 */
export type TicketListItem = Pick<Ticket, "id" | "number" | "title" | "type" | "status" | "lastMessageAt" | "createdAt">;

export type TicketRow = {
  ticket: TicketListItem;
  site: Pick<Site, "id" | "name"> | null;
  client: Pick<Client, "id" | "name">;
  lastAuthor: "agency" | "client" | null;
  /** Messages of other people this member has not read. */
  unread: number;
  assignees: Pick<User, "id" | "name">[];
  labels: Label[];
};

export const TICKETS_PER_PAGE = 50;
const QUERY_MAX = 100;

const uuid = z.uuid();
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The filters of a URL's search params. Values it does not know are dropped; `q` is trimmed to 100. */
export function parseTicketFilters(sp: Record<string, string | string[] | undefined>): TicketFilters {
  const filters: TicketFilters = {};
  const status = first(sp.status);
  if (status === "open" || status === "closed") filters.status = status;
  const clientId = first(sp.client)?.trim();
  if (clientId) filters.clientId = clientId;
  const who = first(sp.who);
  if (who === "mine" || who === "unassigned") filters.who = who;
  if (first(sp.unread) === "1") filters.unread = true;
  const labelId = first(sp.label)?.trim();
  if (labelId) filters.labelId = labelId;
  const q = first(sp.q)?.trim().slice(0, QUERY_MAX);
  if (q) filters.q = q;
  return filters;
}

/** `%` and `_` in what people typed are plain characters, not wildcards. */
function likeLiteral(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function searchWhere(q: string): SQL {
  const parts: SQL[] = [ilike(tickets.title, likeLiteral(q)), ilike(clients.name, likeLiteral(q))];
  const number = /^#?(\d{1,9})$/.exec(q);
  if (number) parts.push(eq(tickets.number, Number(number[1])));
  return or(...parts) as SQL;
}

/** Newest activity first: the last message, or the opening for a ticket nobody wrote on. */
export async function listTickets(
  actor: TeamSession,
  filters: TicketFilters,
  page = 1,
  db: Db = appDb,
): Promise<{ rows: TicketRow[]; total: number }> {
  // A filter naming something that cannot exist has no tickets, and is not an error.
  if (filters.clientId !== undefined && !uuid.safeParse(filters.clientId).success) return { rows: [], total: 0 };
  if (filters.labelId !== undefined && !uuid.safeParse(filters.labelId).success) return { rows: [], total: 0 };

  const me = actor.user.id;
  const conditions: (SQL | undefined)[] = [await visibleTicketsWhere(actor, db)];
  if (filters.status) conditions.push(eq(tickets.status, filters.status));
  if (filters.clientId) conditions.push(eq(tickets.clientId, filters.clientId));
  if (filters.who === "mine") {
    conditions.push(
      exists(
        db
          .select({ one: ticketAssignments.ticketId })
          .from(ticketAssignments)
          .where(and(eq(ticketAssignments.ticketId, tickets.id), eq(ticketAssignments.userId, me))),
      ),
    );
  } else if (filters.who === "unassigned") {
    conditions.push(
      notExists(db.select({ one: ticketAssignments.ticketId }).from(ticketAssignments).where(eq(ticketAssignments.ticketId, tickets.id))),
    );
  }
  if (filters.unread) conditions.push(unreadWhere(me));
  if (filters.labelId) {
    conditions.push(
      exists(
        db
          .select({ one: ticketLabels.ticketId })
          .from(ticketLabels)
          .where(and(eq(ticketLabels.ticketId, tickets.id), eq(ticketLabels.labelId, filters.labelId))),
      ),
    );
  }
  const q = filters.q?.trim().slice(0, QUERY_MAX);
  if (q) conditions.push(searchWhere(q));
  const where = and(...conditions);

  const [{ total }] = await db
    .select({ total: count() })
    .from(tickets)
    .innerJoin(clients, eq(clients.id, tickets.clientId))
    .where(where);

  const pageNumber = Number.isSafeInteger(page) && page > 1 ? page : 1;
  const rows = await db
    .select({
      ticket: {
        id: tickets.id,
        number: tickets.number,
        title: tickets.title,
        type: tickets.type,
        status: tickets.status,
        lastMessageAt: tickets.lastMessageAt,
        createdAt: tickets.createdAt,
      },
      site: { id: sites.id, name: sites.name },
      client: { id: clients.id, name: clients.name },
      lastAuthor: lastAuthorType,
      unread: unreadCountSql(me),
    })
    .from(tickets)
    .innerJoin(clients, eq(clients.id, tickets.clientId))
    .leftJoin(sites, eq(sites.id, tickets.siteId))
    .where(where)
    .orderBy(desc(sql`coalesce(${tickets.lastMessageAt}, ${tickets.createdAt})`), desc(tickets.number))
    .limit(TICKETS_PER_PAGE)
    .offset((pageNumber - 1) * TICKETS_PER_PAGE);

  const ids = rows.map((r) => r.ticket.id);
  const [people, tags] = await Promise.all([ticketAssignees(ids, db), labelsByTicket(ids, db)]);
  return {
    total: Number(total),
    rows: rows.map((r) => ({
      ticket: r.ticket,
      // A left join with no match still yields an object of nulls.
      site: r.site && r.site.id ? r.site : null,
      client: r.client,
      lastAuthor: r.lastAuthor,
      unread: r.unread,
      assignees: people.get(r.ticket.id) ?? [],
      labels: tags.get(r.ticket.id) ?? [],
    })),
  };
}
