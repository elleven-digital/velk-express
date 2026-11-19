import "server-only";
import { sql } from "drizzle-orm";
import type { BadgeTone } from "@/components/ui";
import type { Ticket, TicketStatus } from "@/lib/db";
import type { Dict } from "@/lib/i18n";

/*
 * Whose move it is on a ticket: a client's message puts the ticket back on the agency's turn, an
 * agency reply hands it to the client. Without messages, the side that didn't open it moves next.
 * Deleted messages don't count: what they asked is gone. The SQL fragments go into queries over
 * `tickets` (unaliased), like the ones in lib/access.ts.
 */

/** Author type of the ticket's latest (not deleted) message. */
export const lastAuthorType = sql<"agency" | "client" | null>`(select m.author_type from messages m where m.ticket_id = tickets.id and m.deleted_at is null order by m.created_at desc limit 1)`;

export type Turn = "agency" | "client" | "done";

export function whoseTurn(
  ticket: Pick<Ticket, "status" | "createdByType">,
  lastAuthor: "agency" | "client" | null,
): Turn {
  if (ticket.status === "closed") return "done";
  return (lastAuthor ?? ticket.createdByType) === "client" ? "agency" : "client";
}

/**
 * The status dot of a ticket from the viewer's side: amber when it is their move (or, on the
 * agency side, when nobody took the ticket), blue when it is with the other side, gray when done.
 */
export function turnBadge(
  turn: Turn,
  viewer: "agency" | "client",
  t: Dict,
  opts: { unassigned?: boolean } = {},
): { tone: BadgeTone; label: string } {
  if (turn === "done") return { tone: "muted", label: t.ui.turnDone };
  if (viewer === "agency") {
    if (opts.unassigned) return { tone: "warn", label: t.ui.unassigned };
    return turn === "agency" ? { tone: "warn", label: t.ui.turnYours } : { tone: "info", label: t.ui.turnClient };
  }
  return turn === "client" ? { tone: "warn", label: t.ui.turnYours } : { tone: "info", label: t.ui.turnAgency };
}

/** The ticket's status in the team panel: open or closed, nothing else. */
export function ticketStatusBadge(status: TicketStatus, t: Dict): { tone: BadgeTone; label: string } {
  return status === "closed"
    ? { tone: "muted", label: t.tickets.statusClosed }
    : { tone: "ok", label: t.tickets.statusOpen };
}
