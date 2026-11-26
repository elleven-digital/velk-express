import "server-only";
import { sql, type SQL } from "drizzle-orm";

/*
 * Unread messages on a ticket, per team member: messages after the person last opened the ticket,
 * not written by them and not deleted (a deleted message no longer asks anything). Without a read
 * row the person has read up to when they joined the agency. The fragments go into queries over
 * `tickets` (unaliased), like lib/turn.ts.
 */

function unreadMessagesFrom(userId: string): SQL {
  return sql`from messages m
    where m.ticket_id = tickets.id
      and m.deleted_at is null
      and not (m.author_type = 'agency' and m.author_id = ${userId})
      and m.created_at > coalesce(
        (select tr.last_read_at from ticket_reads tr where tr.ticket_id = tickets.id and tr.user_id = ${userId}),
        (select u.created_at from users u where u.id = ${userId})
      )`;
}

/** How many messages of the ticket this person hasn't read. */
export function unreadCountSql(userId: string): SQL<number> {
  return sql<number>`(select count(*)::int ${unreadMessagesFrom(userId)})`;
}

/** Tickets with at least one message this person hasn't read. */
export function unreadWhere(userId: string): SQL {
  return sql`exists (select 1 ${unreadMessagesFrom(userId)})`;
}

/*
 * The same on the portal, per client login in one company: messages after the person last opened
 * the ticket, not written by them and not deleted. Without a read row the person has read up to
 * when they joined the company (a colleague's earlier messages are history, not news).
 */
function portalUnreadMessagesFrom(clientUserId: string, clientId: string): SQL {
  return sql`from messages m
    where m.ticket_id = tickets.id
      and m.deleted_at is null
      and not (m.author_type = 'client' and m.author_id = ${clientUserId})
      and m.created_at > coalesce(
        (select r.last_read_at from client_ticket_reads r where r.ticket_id = tickets.id and r.client_user_id = ${clientUserId}),
        (select cm.created_at from client_memberships cm where cm.client_user_id = ${clientUserId} and cm.client_id = ${clientId})
      )`;
}

/** How many messages of the ticket this portal login hasn't read. */
export function portalUnreadCountSql(clientUserId: string, clientId: string): SQL<number> {
  return sql<number>`(select count(*)::int ${portalUnreadMessagesFrom(clientUserId, clientId)})`;
}
