import "server-only";
import * as z from "zod";
import { isStaff } from "@/lib/access";
import { agencyTimeZone, getAgency } from "@/lib/agency";
import { getAppUrl } from "@/lib/app-url";
import type { TeamSession } from "@/lib/auth/session";
import { chargeFor, ticketBilledOnQuote } from "@/lib/core/charges";
import { addTimeEntry, deleteTimeEntry } from "@/lib/core/hours";
import { deleteMessage, editMessage, postMessage } from "@/lib/core/messages";
import { getTeamHome } from "@/lib/core/team-home";
import { listTickets, TICKETS_PER_PAGE } from "@/lib/core/ticket-list";
import { getTeamTicketView } from "@/lib/core/ticket-view";
import {
  addTicketAssignee,
  assumeTicket,
  createTicket,
  removeTicketAssignee,
  setTicketStatus,
  updateTicketValue,
} from "@/lib/core/tickets";
import { todayInCycleZone } from "@/lib/hours";
import { isLocale } from "@/lib/i18n";
import { agencyLocale } from "@/lib/mcp/context";
import { markdownToHtml } from "@/lib/mcp/markdown";
import { presentTicketDetail, presentTicketRow, ticketUrl } from "@/lib/mcp/present";
import {
  minutesToDuration,
  PEOPLE_TEXT,
  READ_ONLY,
  recordWrite,
  refused,
  teamTool,
  toolData,
  writeAnnotations,
  written,
  type ToolRegistrar,
} from "@/lib/mcp/tools";

/**
 * The home and the tickets: what needs the person, the ticket list and one
 * ticket, and everything the ticket page does — open, reply, edit or delete a
 * message, take, assign, close/reopen, log time and set the agreed value.
 * Same cores as the panel, same visibility: outside a collaborator's scope a
 * ticket is "not found", exactly like one that doesn't exist.
 */

export const TICKET_TOOLS = [
  "get_home",
  "list_tickets",
  "get_ticket",
  "open_ticket",
  "reply_to_ticket",
  "edit_ticket_message",
  "delete_ticket_message",
  "assume_ticket",
  "assign_ticket",
  "unassign_ticket",
  "close_ticket",
  "reopen_ticket",
  "log_time",
  "delete_time_entry",
  "set_ticket_value",
] as const;

const TICKET_ID = z.string().describe("The ticket id (from list_tickets or get_ticket).");
const MESSAGE_ID = z.string().describe("The message id (from get_ticket).");
const TEXT_MAX = 20000;

/** The language a core writes its labels in ("removed user"): the person's own, else the agency's. */
const localeOf = async (actor: TeamSession) => (isLocale(actor.user.locale) ? actor.user.locale : agencyLocale());

export const registerTicketTools: ToolRegistrar = (server, scope) => {
  server.registerTool(
    "get_home",
    {
      description:
        "The connected person's home: what needs them (open tickets nobody took, and their own open tickets the client answered), whose turn it is on each, this month's figures in the agency's time zone (owners/managers: open tickets, clients with support, minutes used on support this month, clients over their hour package; collaborators: my open tickets, unassigned tickets, my clients) and the latest activity." +
        PEOPLE_TEXT,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    teamTool(scope, "get_home", "member", async (actor) => {
      const [home, appUrl] = await Promise.all([getTeamHome(actor), getAppUrl()]);
      const f = home.figures;
      return toolData({
        needs_you: home.needsYou.map((r) => ({ ...presentTicketRow(r, appUrl), last_message_by: r.lastAuthorName })),
        needs_you_total: home.needsYouTotal,
        figures:
          f.role === "staff"
            ? {
                open_tickets: f.openTickets,
                clients_with_support: f.clientsWithSupport,
                minutes_used_this_month: f.minutesUsedThisMonth,
                negative_hour_balances: f.negativeBalances,
              }
            : { my_open_tickets: f.myOpenTickets, unassigned_tickets: f.unassigned, my_clients: f.myClients },
        recent: home.recent.map((r) => presentTicketRow(r, appUrl)),
      });
    }),
  );

  server.registerTool(
    "list_tickets",
    {
      description: `Lists the tickets the person can see, most recent activity first, ${TICKETS_PER_PAGE} per page. Each ticket says whose turn it is (whose_turn: agency, client or done), how many messages the person hasn't read (unread_messages) and its internal labels. Filters: status, client, who (mine / unassigned), turn (agency = waiting for the agency, client = waiting for the client; open tickets only), unread_only, label_id (from list_labels) and a search over title, client name or number ("12" or "#12").${PEOPLE_TEXT}`,
      inputSchema: z.object({
        status: z.enum(["open", "closed"]).optional(),
        client_id: z.string().optional().describe("Only this client's tickets."),
        who: z.enum(["mine", "unassigned"]).optional(),
        turn: z.enum(["agency", "client"]).optional(),
        unread_only: z.boolean().optional().describe("Only tickets with messages the person hasn't read."),
        label_id: z.string().optional().describe("Only tickets with this label (id from list_labels)."),
        search: z.string().max(100).optional(),
        page: z.number().int().min(1).optional().describe("Page number, from 1 (default 1)."),
      }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "list_tickets", "member", async (actor, args) => {
      const page = args.page ?? 1;
      const [{ rows, total }, appUrl] = await Promise.all([
        listTickets(
          actor,
          {
            status: args.status,
            clientId: args.client_id,
            who: args.who,
            turn: args.turn,
            unread: args.unread_only,
            labelId: args.label_id,
            q: args.search,
          },
          page,
        ),
        getAppUrl(),
      ]);
      return toolData({
        tickets: rows.map((r) => presentTicketRow(r, appUrl)),
        total,
        page,
        per_page: TICKETS_PER_PAGE,
        next_page: page * TICKETS_PER_PAGE < total ? page + 1 : null,
      });
    }),
  );

  server.registerTool(
    "get_ticket",
    {
      description:
        "One ticket as its panel page shows it: status and whose turn, internal labels, client and site, who opened it, responsibles (and, for owners/managers, who else can be assigned), the whole conversation (each message with its id, for reply_to_ticket's reply_to and edit/delete_ticket_message; edited messages say who edited them and when; deleted ones keep their place with text null, deleted_by and deleted_at), the ticket's files (a link that opens for people signed in to the panel), time entries and the client's hours this month. Owners and managers also get the agreed value and the charge. Reading it does not mark anything read (unread_messages says how many messages the person hasn't read)." +
        PEOPLE_TEXT,
      inputSchema: z.object({ ticket_id: TICKET_ID }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "get_ticket", "member", async (actor, args) => {
      const view = await getTeamTicketView(actor, args.ticket_id, await localeOf(actor));
      if (!view) return refused(actor, "notFound", "tickets");
      const appUrl = await getAppUrl();
      let money = null;
      if (isStaff(actor.user)) {
        const single = view.ticket.type === "single";
        const [brand, charge, billed] = await Promise.all([
          getAgency(),
          single ? chargeFor(actor, { source: "ticket", sourceId: view.ticket.id }) : null,
          single ? ticketBilledOnQuote(actor, view.ticket.id) : null,
        ]);
        money = {
          currency: brand?.currency ?? null,
          charge: charge?.ok ? charge.value : null,
          billedOnQuote: Boolean(billed?.ok && billed.value),
        };
      }
      return toolData({ ticket: presentTicketDetail(view, appUrl, money) });
    }),
  );

  server.registerTool(
    "open_ticket",
    {
      description:
        "Opens a ticket for a client, as the agency. client_id is required (from list_clients); site_id is optional (one of the client's sites; without it the ticket is general). type: single (a one-off job; owners and managers may give value_cents) or support (needs the client's support plan). The opener becomes its first responsible. text is the first message, in light Markdown (paragraphs, lists, **bold**, *italic*, links).",
      inputSchema: z.object({
        client_id: z.string().describe("The client id (from list_clients)."),
        site_id: z.string().optional().describe("One of the client's sites; leave out for a general ticket."),
        type: z.enum(["single", "support"]),
        title: z.string().min(1).max(200),
        text: z.string().max(TEXT_MAX).optional(),
        value_cents: z.number().int().min(0).optional().describe("Agreed value of a single ticket, owners and managers only."),
      }),
      annotations: writeAnnotations({ destructive: false }),
    },
    teamTool(scope, "open_ticket", "member", async (actor, args) => {
      // The panel's createTicketAction does nothing more than createTicket (a ticket the team
      // opens notifies nobody), so neither does this.
      const result = await createTicket(actor, {
        clientId: args.client_id,
        siteId: args.site_id ?? null,
        type: args.type,
        title: args.title,
        bodyHtml: args.text ? markdownToHtml(args.text) : undefined,
        valueCents: args.value_cents ?? null,
      });
      if (!result.ok) return refused(actor, result.error, "tickets");
      recordWrite(scope, actor, "open_ticket");
      const { ticketId, number } = result.value;
      return written({ ticket: { id: ticketId, number, url: ticketUrl(await getAppUrl(), ticketId) } });
    }),
  );

  server.registerTool(
    "reply_to_ticket",
    {
      description:
        "Writes a message on an open ticket as the agency (the client sees it in their area). text is light Markdown (paragraphs, lists, **bold**, *italic*, links). reply_to: optional id of the message being answered (from get_ticket).",
      inputSchema: z.object({
        ticket_id: TICKET_ID,
        text: z.string().min(1).max(TEXT_MAX),
        reply_to: MESSAGE_ID.optional(),
      }),
      annotations: writeAnnotations({ destructive: false }),
    },
    teamTool(scope, "reply_to_ticket", "member", async (actor, args) => {
      const result = await postMessage(actor, args.ticket_id, {
        bodyHtml: markdownToHtml(args.text),
        replyToId: args.reply_to ?? null,
      });
      if (!result.ok) return refused(actor, result.error, "tickets");
      recordWrite(scope, actor, "reply_to_ticket");
      return written({ ticket_id: args.ticket_id, message_id: result.value.messageId });
    }),
  );

  server.registerTool(
    "edit_ticket_message",
    {
      description:
        "Replaces the text of a message on a ticket (message id from get_ticket). Everyone sees it marked as edited; the team also sees who edited it. You can edit your own messages; owners can also edit any team member's, managers a collaborator's. Client messages and deleted messages can't be edited. text is light Markdown, as in reply_to_ticket.",
      inputSchema: z.object({ ticket_id: TICKET_ID, message_id: MESSAGE_ID, text: z.string().min(1).max(TEXT_MAX) }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "edit_ticket_message", "member", async (actor, args) => {
      const result = await editMessage(actor, args.ticket_id, args.message_id, markdownToHtml(args.text));
      if (!result.ok) return refused(actor, result.error, "tickets");
      if (result.value.changed) recordWrite(scope, actor, "edit_ticket_message");
      return written({ ticket_id: args.ticket_id, message_id: args.message_id, changed: result.value.changed });
    }),
  );

  server.registerTool(
    "delete_ticket_message",
    {
      description:
        "Deletes a message on a ticket (message id from get_ticket). Its text and files disappear for everyone and \"Message deleted\" shows in its place; the team also sees who deleted it. Same rules as edit_ticket_message. Deleting a deleted message changes nothing.",
      inputSchema: z.object({ ticket_id: TICKET_ID, message_id: MESSAGE_ID }),
      annotations: writeAnnotations({ destructive: true, idempotent: true }),
    },
    teamTool(scope, "delete_ticket_message", "member", async (actor, args) => {
      const result = await deleteMessage(actor, args.ticket_id, args.message_id);
      if (!result.ok) return refused(actor, result.error, "tickets");
      if (result.value.changed) recordWrite(scope, actor, "delete_ticket_message");
      return written({ ticket_id: args.ticket_id, message_id: args.message_id, changed: result.value.changed });
    }),
  );

  server.registerTool(
    "assume_ticket",
    {
      description:
        "The connected person takes the ticket as a responsible. Owners and managers can take any; collaborators only an unassigned ticket they can see.",
      inputSchema: z.object({ ticket_id: TICKET_ID }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "assume_ticket", "member", async (actor, args) => {
      const result = await assumeTicket(actor, args.ticket_id);
      if (!result.ok) return refused(actor, result.error, "tickets");
      recordWrite(scope, actor, "assume_ticket");
      return written({ ticket_id: args.ticket_id });
    }),
  );

  server.registerTool(
    "assign_ticket",
    {
      description:
        "Owners and managers: adds a team member as a responsible of the ticket (they also join the client). user_id from get_ticket's assignable list or list_team.",
      inputSchema: z.object({ ticket_id: TICKET_ID, user_id: z.string() }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "assign_ticket", "staff", async (actor, args) => {
      const result = await addTicketAssignee(actor, args.ticket_id, args.user_id);
      if (!result.ok) return refused(actor, result.error, "tickets");
      recordWrite(scope, actor, "assign_ticket");
      return written({ ticket_id: args.ticket_id, user_id: args.user_id });
    }),
  );

  server.registerTool(
    "unassign_ticket",
    {
      description: "Owners and managers: removes a responsible from the ticket. They stay on the client's team.",
      inputSchema: z.object({ ticket_id: TICKET_ID, user_id: z.string() }),
      annotations: writeAnnotations({ destructive: true, idempotent: true }),
    },
    teamTool(scope, "unassign_ticket", "staff", async (actor, args) => {
      const result = await removeTicketAssignee(actor, args.ticket_id, args.user_id);
      if (!result.ok) return refused(actor, result.error, "tickets");
      recordWrite(scope, actor, "unassign_ticket");
      return written({ ticket_id: args.ticket_id, user_id: args.user_id });
    }),
  );

  for (const [tool, status] of [
    ["close_ticket", "closed"],
    ["reopen_ticket", "open"],
  ] as const) {
    server.registerTool(
      tool,
      {
        description:
          status === "closed"
            ? "Marks the ticket as done (closed). Closing a closed ticket changes nothing."
            : "Reopens a closed ticket. Reopening an open ticket changes nothing.",
        inputSchema: z.object({ ticket_id: TICKET_ID }),
        annotations: writeAnnotations({ destructive: false, idempotent: true }),
      },
      teamTool(scope, tool, "member", async (actor, args) => {
        const result = await setTicketStatus(actor, args.ticket_id, status);
        if (!result.ok) return refused(actor, result.error, "tickets");
        if (result.value.changed) recordWrite(scope, actor, tool);
        return written({ ticket_id: args.ticket_id, status, changed: result.value.changed });
      }),
    );
  }

  server.registerTool(
    "log_time",
    {
      description:
        "Logs time worked on a ticket, in the connected person's name: whole minutes, up to 24 hours. Time on support tickets counts against the client's monthly hours. worked_on (YYYY-MM-DD) defaults to today in the agency's time zone and can't be in the future.",
      inputSchema: z.object({
        ticket_id: TICKET_ID,
        minutes: z.number().int().min(1).describe("Whole minutes worked, e.g. 90 for 1h30."),
        worked_on: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        note: z.string().max(500).optional(),
      }),
      annotations: writeAnnotations({ destructive: false }),
    },
    teamTool(scope, "log_time", "member", async (actor, args) => {
      // Today as the agency sees it, taken before the core's own: never later than its today.
      const workedOn = args.worked_on ?? todayInCycleZone(new Date(), await agencyTimeZone());
      const result = await addTimeEntry(actor, args.ticket_id, {
        duration: minutesToDuration(args.minutes),
        workedOn,
        note: args.note,
      });
      if (!result.ok) return refused(actor, result.error, "tickets");
      recordWrite(scope, actor, "log_time");
      return written({ ticket_id: args.ticket_id, time_entry_id: result.value.id, minutes: args.minutes, worked_on: workedOn });
    }),
  );

  server.registerTool(
    "delete_time_entry",
    {
      description: "Deletes a time entry of a ticket (entry id from get_ticket). Its author can, and owners and managers.",
      inputSchema: z.object({ ticket_id: TICKET_ID, time_entry_id: z.string() }),
      annotations: writeAnnotations({ destructive: true, idempotent: true }),
    },
    teamTool(scope, "delete_time_entry", "member", async (actor, args) => {
      const result = await deleteTimeEntry(actor, args.ticket_id, args.time_entry_id);
      if (!result.ok) return refused(actor, result.error, "tickets");
      recordWrite(scope, actor, "delete_time_entry");
      return written({ ticket_id: args.ticket_id, time_entry_id: args.time_entry_id });
    }),
  );

  server.registerTool(
    "set_ticket_value",
    {
      description:
        "Owners and managers: sets the agreed value of a single (one-off) ticket, in cents of the agency's currency; null or 0 clears it. Refused while the ticket has an open or paid charge (cancel it first). Use create_charge afterwards to charge it.",
      inputSchema: z.object({
        ticket_id: TICKET_ID,
        value_cents: z.number().int().min(0).nullable(),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "set_ticket_value", "staff", async (actor, args) => {
      // As the panel's charge form: an empty or zero value clears it.
      const valueCents = args.value_cents ? args.value_cents : null;
      const result = await updateTicketValue(actor, args.ticket_id, valueCents);
      if (!result.ok) return refused(actor, result.error, "charges");
      recordWrite(scope, actor, "set_ticket_value");
      return written({ ticket_id: args.ticket_id, value_cents: valueCents });
    }),
  );
};
