/**
 * Ticket checks of the connector's end-to-end run (loaded by scripts/mcp-e2e.ts):
 * a collaborator opens, answers, logs time on and closes a ticket, and each
 * step is checked in the database, with the refusals that write nothing.
 */
import type { Ctx } from "./mcp-e2e";

export async function run({ restore, sql, call, data, sentence, check, section, collaborator, ownerToken, connect }: Ctx) {
  section("Tickets — collaborator");
  const [client] = await sql`
    insert into clients (name, support_active, general_tickets_enabled)
    values ('E2E — Padaria Aurora', true, true) returning id`;
  // Deleting the client takes its tickets, messages and time entries with it.
  restore(() => sql`delete from clients where id = ${client.id}`);
  // Whatever the collaborators' scope, this one takes part in the client.
  await sql`insert into client_assignments (client_id, user_id) values (${client.id}, ${collaborator.id})`;

  const collabToken = (await connect(collaborator.id)).access_token;

  const noClient = await call(collabToken, "open_ticket", { type: "support", title: "E2E — no client" });
  const [noClientRows] = await sql`select count(*)::int as n from tickets where title = 'E2E — no client'`;
  check("open_ticket without client_id is refused and writes nothing", noClient.isError === true && noClientRows.n === 0, sentence(noClient));

  const opened = data(
    await call(collabToken, "open_ticket", {
      client_id: client.id,
      type: "support",
      title: "E2E — new banner",
      text: "Please **update** the banner.",
    }),
  );
  const ticketId = opened.ticket?.id;
  const [ticket] = await sql`select created_by_type, created_by_id, status from tickets where id = ${ticketId}`;
  check(
    "open_ticket writes the ticket in the collaborator's name",
    ticket?.created_by_type === "agency" && ticket.created_by_id === collaborator.id && ticket.status === "open",
    ticket,
  );
  const assignees = await sql`select user_id from ticket_assignments where ticket_id = ${ticketId}`;
  check("the opener is its responsible", assignees.length === 1 && assignees[0].user_id === collaborator.id, assignees);
  const [first] = await sql`select body_html from messages where ticket_id = ${ticketId}`;
  check("the first message is the Markdown as HTML", first?.body_html === "<p>Please <strong>update</strong> the banner.</p>", first);

  const reply = data(
    await call(collabToken, "reply_to_ticket", { ticket_id: ticketId, text: "On it *today* <script>alert(1)</script>" }),
  );
  const [replied] = await sql`select body_html, author_id from messages where id = ${reply.message_id}`;
  check(
    "reply_to_ticket stores sanitized HTML (no script tag) in the collaborator's name",
    replied?.author_id === collaborator.id && replied.body_html.includes("<em>today</em>") && !replied.body_html.includes("<script"),
    replied,
  );

  const logged = data(await call(collabToken, "log_time", { ticket_id: ticketId, minutes: 45, note: "layout" }));
  const [entry] = await sql`select minutes, created_by_id, worked_on::text as worked_on from time_entries where id = ${logged.time_entry_id}`;
  check(
    "log_time records 45 minutes for the collaborator",
    entry?.minutes === 45 && entry.created_by_id === collaborator.id && entry.worked_on === logged.worked_on,
    entry,
  );
  const tooMuch = await call(collabToken, "log_time", { ticket_id: ticketId, minutes: 24 * 60 + 1 });
  const fraction = await call(collabToken, "log_time", { ticket_id: ticketId, minutes: 1.5 });
  const [entries] = await sql`select count(*)::int as n from time_entries where ticket_id = ${ticketId}`;
  check(
    "log_time over 24 hours or a fraction gets the panel's sentence, and nothing more is logged",
    sentence(tooMuch).startsWith("Enter the time like") && sentence(fraction).startsWith("Enter the time like") && entries.n === 1,
    [sentence(tooMuch), sentence(fraction), entries.n],
  );

  const detail = data(await call(collabToken, "get_ticket", { ticket_id: ticketId })).ticket;
  check(
    "get_ticket shows the conversation and the time, and no money to a collaborator",
    detail?.messages?.length === 2 && detail.minutes_logged === 45 && !("value_cents" in detail),
    { messages: detail?.messages?.length, minutes: detail?.minutes_logged },
  );
  const [reads] = await sql`select count(*)::int as n from ticket_reads where ticket_id = ${ticketId}`;
  check("get_ticket marks nothing read", reads.n === 0, reads.n);

  const value = await call(collabToken, "set_ticket_value", { ticket_id: ticketId, value_cents: 1000 });
  check("a collaborator can't set a ticket's value", value.isError === true && sentence(value).includes("owners and managers"), sentence(value));

  const closed = data(await call(collabToken, "close_ticket", { ticket_id: ticketId }));
  const [closedRow] = await sql`select status, closed_at from tickets where id = ${ticketId}`;
  check("close_ticket closes it", closed.changed === true && closedRow?.status === "closed" && closedRow.closed_at !== null, closedRow);
  const late = await call(collabToken, "reply_to_ticket", { ticket_id: ticketId, text: "One more thing" });
  const [messageCount] = await sql`select count(*)::int as n from messages where ticket_id = ${ticketId}`;
  check(
    "a closed ticket refuses replies and keeps its messages",
    late.isError === true && sentence(late).startsWith("This ticket is closed") && messageCount.n === 2,
    sentence(late),
  );

  section("Tickets — owner");
  const home = data(await call(ownerToken, "get_home"));
  check("get_home has the staff figures", typeof home.figures?.open_tickets === "number" && Array.isArray(home.needs_you), home.figures);
  const listed = data(await call(ownerToken, "list_tickets", { client_id: client.id }));
  check(
    "list_tickets finds the ticket with whose turn it is",
    listed.total === 1 && listed.tickets[0]?.id === ticketId && listed.tickets[0].whose_turn === "done",
    listed.tickets?.[0],
  );
}
