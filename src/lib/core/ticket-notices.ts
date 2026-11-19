import "server-only";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { ticketAssignees } from "@/lib/access";
import { getAppUrl } from "@/lib/app-url";
import { logoAbsoluteUrl } from "@/lib/agency";
import { agency, clientUsers, db as appDb, sites, tickets, users, type Db } from "@/lib/db";
import { getDict, isLocale } from "@/lib/i18n";
import { buildTicketOpenedMail } from "@/lib/mail/messages/ticket-opened";
import { sendMail } from "@/lib/mail/send";

/** Test seams: the database and the mail sender. */
type Deps = { db?: Db; send?: typeof sendMail };

/**
 * Best effort, never throws: e-mails the ticket's assignees that a client opened it, or the owner
 * and managers when nobody is assigned. Only people with a password (a pending invite cannot sign
 * in). When the assignees are all pending invites, it falls back to the owner and managers like
 * the unassigned case, so a ticket never goes unnoticed. Run it after the opening transaction has committed. Without SMTP nothing is sent.
 */
export async function notifyTicketOpened(ticketId: string, deps: Deps = {}): Promise<{ recipients: number; sent: number }> {
  try {
    const db = deps.db ?? appDb;
    const send = deps.send ?? sendMail;
    const [ticket] = await db
      .select({
        id: tickets.id,
        number: tickets.number,
        title: tickets.title,
        createdByType: tickets.createdByType,
        createdById: tickets.createdById,
        siteName: sites.name,
      })
      .from(tickets)
      .leftJoin(sites, eq(sites.id, tickets.siteId))
      .where(eq(tickets.id, ticketId));
    // Only a client opening a ticket notifies; the team opening one does not.
    if (!ticket || ticket.createdByType !== "client") return { recipients: 0, sent: 0 };

    const [[opener], [brand], assignees] = await Promise.all([
      db.select({ name: clientUsers.name }).from(clientUsers).where(eq(clientUsers.id, ticket.createdById)),
      db.select().from(agency).limit(1),
      ticketAssignees([ticket.id], db),
    ]);
    const assigned = (assignees.get(ticket.id) ?? []).map((a) => a.id);
    const pick = (where: ReturnType<typeof inArray>) =>
      db
        .select({ id: users.id, name: users.name, email: users.email, locale: users.locale })
        .from(users)
        .where(and(isNotNull(users.passwordHash), where))
        .orderBy(asc(users.createdAt), asc(users.id));
    // Assignees who can sign in; when there are none (nobody assigned, or only pending invites),
    // the owner and managers with a password.
    let people = assigned.length > 0 ? await pick(inArray(users.id, assigned)) : [];
    if (people.length === 0) people = await pick(inArray(users.role, ["owner", "manager"]));
    if (people.length === 0) return { recipients: 0, sent: 0 };

    const link = `${await getAppUrl()}/admin/tickets/${ticket.id}`;
    const logoUrl = await logoAbsoluteUrl(brand?.logoFileId ?? null);
    const results = await Promise.all(
      people.map(async (p) => {
        try {
          const locale = isLocale(p.locale) ? p.locale : isLocale(brand?.locale) ? brand.locale : "en";
          const dict = await getDict(locale);
          const msg = buildTicketOpenedMail(dict.tickets.openedMail, {
            to: p.email,
            userName: p.name,
            agencyName: brand?.name ?? "Velk Express",
            logoUrl,
            number: ticket.number,
            title: ticket.title,
            openerName: opener?.name ?? "",
            siteName: ticket.siteName ?? dict.tickets.generalLabel,
            link,
          });
          return (await send(msg)).sent;
        } catch {
          return false;
        }
      }),
    );
    return { recipients: people.length, sent: results.filter(Boolean).length };
  } catch (err) {
    console.error("[mail] ticket-opened notice failed:", err instanceof Error ? err.message : err);
    return { recipients: 0, sent: 0 };
  }
}
