import { isLiveStatus } from "@/lib/charge-utils";
import type { ChargeView } from "@/lib/core/charges";
import type { TicketRow } from "@/lib/core/ticket-list";
import type { TeamTicketView } from "@/lib/core/ticket-view";
import type { FileItem, ThreadMessage } from "@/lib/core/thread";
import type { Label, User } from "@/lib/db";
import { labelColorOf } from "@/lib/labels";
import { htmlToText } from "@/lib/sanitize";
import { whoseTurn } from "@/lib/turn";

/**
 * How Velk Express data is shown to the AI app: plain JSON with English
 * snake_case keys, ISO dates, money in cents plus the currency. Nothing here
 * decides what the viewer may see — the cores already did; `staff` only
 * leaves out what the panel hides from collaborators.
 */

export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function presentPerson(user: Pick<User, "id" | "name">) {
  return { id: user.id, name: user.name };
}

/** The panel's address, without a trailing slash. */
export function panelBase(appUrl: string): string {
  return appUrl.replace(/\/+$/, "");
}

/** The ticket's page in the team panel. */
export function ticketUrl(appUrl: string, ticketId: string): string {
  return `${panelBase(appUrl)}/admin/tickets/${ticketId}`;
}

/** A ticket's internal labels, each color as hex. */
export function presentLabels(labels: Pick<Label, "id" | "name" | "color">[]) {
  return labels.map((l) => ({ id: l.id, name: l.name, color: labelColorOf(l.color) }));
}

/** One row of the ticket list (and of the home). */
export function presentTicketRow(row: TicketRow, appUrl: string) {
  const { ticket } = row;
  return {
    id: ticket.id,
    number: ticket.number,
    title: ticket.title,
    type: ticket.type,
    status: ticket.status,
    whose_turn: whoseTurn(ticket, row.lastAuthor),
    unread_messages: row.unread,
    labels: presentLabels(row.labels),
    client: { id: row.client.id, name: row.client.name },
    site: row.site ? { id: row.site.id, name: row.site.name } : null,
    assignees: row.assignees.map(presentPerson),
    unassigned: row.assignees.length === 0,
    opened_by: ticket.createdByType,
    created_at: iso(ticket.createdAt),
    last_activity_at: iso(ticket.lastMessageAt ?? ticket.createdAt),
    url: ticketUrl(appUrl, ticket.id),
  };
}

/**
 * One message of a ticket. A deleted one keeps its place in the thread but
 * says nothing of what it said: text null, deleted_at and deleted_by set.
 */
export function presentTicketMessage(m: ThreadMessage) {
  const edit = m.edited && !m.deleted ? m.changedBy : null;
  const removal = m.deleted ? m.changedBy : null;
  return {
    id: m.id,
    from: m.fromAgency ? "agency" : "client",
    author: m.authorName,
    text: m.deleted ? null : htmlToText(m.bodyHtml),
    has_images: m.deleted ? false : m.bodyHtml.includes("<img"),
    in_reply_to: m.replyTo?.id ?? null,
    created_at: m.createdAt,
    edited: m.edited,
    edited_at: edit?.at ?? null,
    edited_by: edit?.name ?? null,
    deleted: m.deleted,
    deleted_at: removal?.at ?? null,
    deleted_by: removal?.name ?? null,
    attachment_ids: m.attachments.map((f) => f.id),
  };
}

/** A file of the ticket, with a link that opens for people signed in to the panel. */
export function presentTicketFile(f: FileItem, appUrl: string) {
  return {
    id: f.id,
    name: f.name,
    type: f.mime,
    size: f.size,
    message_id: f.messageId,
    uploaded_by: f.byName,
    created_at: f.at,
    url: `${panelBase(appUrl)}${f.url}`,
  };
}

/** The payment page only while the charge can still be paid (not paid nor canceled), as the panel shows it. */
export function presentCharge(charge: ChargeView) {
  return {
    id: charge.id,
    status: charge.status,
    kind: charge.kind,
    provider: charge.provider,
    amount_cents: charge.amountCents,
    currency: charge.currency,
    pay_url: isLiveStatus(charge.status) ? charge.payUrl : null,
  };
}

/**
 * The ticket page. `money` is the staff block (value, currency, charge):
 * left out for collaborators, as the panel does.
 */
export function presentTicketDetail(
  view: TeamTicketView,
  appUrl: string,
  money: { currency: string | null; charge: ChargeView | null; billedOnQuote: boolean } | null,
) {
  const { ticket } = view;
  return {
    id: ticket.id,
    number: ticket.number,
    title: ticket.title,
    type: ticket.type,
    status: ticket.status,
    whose_turn: view.turn,
    unread_messages: view.unread,
    labels: presentLabels(view.labels),
    client: { id: view.client.id, name: view.client.name },
    site: view.site ? { id: view.site.id, name: view.site.name } : null,
    opened_by: { side: ticket.createdByType, name: view.openerName },
    created_at: iso(ticket.createdAt),
    closed_at: iso(ticket.closedAt),
    assignees: view.assignees.map(presentPerson),
    can_assume: view.canAssume,
    // Staff only, like the panel's "add responsible" list.
    ...(money ? { assignable: view.assignable.map(presentPerson) } : {}),
    messages: view.messages.map(presentTicketMessage),
    // general attachments (message_id null) and files sent in messages
    files: view.files.map((f) => presentTicketFile(f, appUrl)),
    time_entries: view.time.entries.map((e) => ({
      id: e.id,
      minutes: e.minutes,
      worked_on: e.workedOn,
      note: e.note,
      by: e.authorName,
      created_at: e.createdAt,
    })),
    minutes_logged: view.time.totalMinutes,
    // The latest day log_time accepts, and its default.
    today: view.today,
    client_hours: view.hours
      ? view.hours.mode === "package"
        ? {
            mode: "package" as const,
            cycle: view.hours.cycle,
            used_minutes: view.hours.usedMinutes,
            total_minutes: view.hours.totalMinutes,
            balance_minutes: view.hours.balanceMinutes,
          }
        : { mode: "internal" as const, cycle: view.hours.cycle, used_minutes: view.hours.usedMinutes }
      : null,
    // Money is staff business.
    ...(money
      ? {
          value_cents: view.valueCents,
          currency: money.currency,
          billed_on_quote: money.billedOnQuote,
          charge: money.charge ? presentCharge(money.charge) : null,
        }
      : {}),
    url: ticketUrl(appUrl, ticket.id),
  };
}
