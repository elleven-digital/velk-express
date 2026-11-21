import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clients,
  clientUsers,
  messages,
  ticketAssignments,
  ticketReads,
  tickets,
  timeEntries,
  users,
  type Client,
  type Db,
  type User,
} from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { insertMessage } from "@/lib/core/messages";
import { notifyTicketOpened } from "@/lib/core/ticket-notices";
import { createTicket } from "@/lib/core/tickets";
import { todayInCycleZone } from "@/lib/hours";
import { en } from "@/lib/i18n/en";
import { pt } from "@/lib/i18n/pt";
import { buildServer } from "./server";
import type { ToolScope } from "./tools";

// A fake mail transport: every e-mail the app would send lands here instead.
const mailed = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
vi.mock("@/lib/mail/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/send")>()),
  sendMail: mailed,
}));

// The cores and the connector read the app database: point it at the test one.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://agency.test";

let db: Db;
let owner: User;
let manager: User;
let collab: User;
let acme: Client;
let beta: Client;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

async function makeUser(name: string, role: User["role"], locale: string | null = null): Promise<User> {
  const [u] = await db
    .insert(users)
    .values({ name, email: `${name.toLowerCase()}@x.com`, role, locale, passwordHash: "hash" })
    .returning();
  return u;
}

const scopeOf = (user: User): ToolScope => ({
  userId: user.id,
  connectionId: "00000000-0000-4000-8000-000000000001",
  clientId: "https://app.test/client.json",
  clientName: "Test app",
  rateLimited: false,
});

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };

const PROTOCOL = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "velk-int", version: "1.0.0" },
};

/** Calls a tool as `user` through the real MCP handler. */
async function call(user: User, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const handler = createMcpHandler(() => buildServer(scopeOf(user)), { responseMode: "json" });
  const response = await handler.fetch(
    new Request("https://agency.test/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: META } }),
    }),
  );
  const message = (await response.json()) as { result?: ToolResult; error?: unknown };
  if (!message.result) throw new Error(`${name}: ${JSON.stringify(message)}`);
  return message.result;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped tool answers */
function data(result: ToolResult): Record<string, any> {
  if (result.isError) throw new Error(`unexpected refusal: ${result.content[0]?.text}`);
  return result.structuredContent ?? {};
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const sentence = (r: ToolResult) => r.content[0]?.text;

async function openAs(user: User, client: Client, title: string, type: "single" | "support" = "support"): Promise<string> {
  const res = await createTicket(asTeam(user), { clientId: client.id, type, title, bodyHtml: "<p>Start</p>" }, { db });
  if (!res.ok) throw new Error(res.error);
  return res.value.ticketId;
}

/** A portal person of the client writes on the ticket. */
async function clientWrites(ticketId: string, text: string) {
  const [person] = await db.insert(clientUsers).values({ name: "Carla", email: `carla-${Date.now()}@client.com` }).returning();
  await insertMessage(db, { ticketId, author: { type: "client", id: person.id }, body: { bodyHtml: `<p>${text}</p>`, bodyText: text } });
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({
    id: 1,
    name: "Studio Acme",
    currency: "BRL",
    locale: "en",
    timeZone: "America/Sao_Paulo",
    collabClientScope: "all",
  });
  owner = await makeUser("Ana", "owner");
  manager = await makeUser("Beto", "manager", "pt");
  collab = await makeUser("Cy", "collaborator");
  [acme] = await db.insert(clients).values({ name: "Acme", supportActive: true, generalTicketsEnabled: true, hoursMode: "package", includedMinutes: 120 }).returning();
  [beta] = await db.insert(clients).values({ name: "Beta", supportActive: true }).returning();
  mailed.mockClear();
});

afterAll(async () => {
  await db?.$client.end();
});

describe("open_ticket", () => {
  it("is refused by the schema without a client_id, and writes nothing", async () => {
    const result = await call(owner, "open_ticket", { type: "single", title: "No client" });
    expect(result.isError).toBe(true);
    expect(sentence(result)).toContain("Input validation error");
    expect(await db.select().from(tickets)).toEqual([]);
  });

  it("opens the ticket as the panel does: the opener assigned, Markdown as HTML, no e-mail (the panel sends none either)", async () => {
    const opened = data(await call(collab, "open_ticket", {
      client_id: acme.id,
      type: "single",
      title: "New banner",
      text: "Please **update** the banner.",
      value_cents: 5000,
    }));
    expect(opened).toEqual({
      ok: true,
      ticket: { id: expect.any(String), number: 1, url: `https://agency.test/admin/tickets/${opened.ticket.id}` },
    });
    const [row] = await db.select().from(tickets).where(eq(tickets.id, opened.ticket.id));
    // The agreed value is staff business: a collaborator's is dropped, as in the panel.
    expect(row).toMatchObject({ clientId: acme.id, type: "single", title: "New banner", createdByType: "agency", createdById: collab.id, valueCents: null });
    expect(await db.select({ userId: ticketAssignments.userId }).from(ticketAssignments)).toEqual([{ userId: collab.id }]);
    const [first] = await db.select().from(messages).where(eq(messages.ticketId, row.id));
    expect(first.bodyHtml).toBe("<p>Please <strong>update</strong> the banner.</p>");
    // The panel's createTicketAction sends no notice for a ticket the team opens, so neither does the tool.
    expect(mailed).not.toHaveBeenCalled();

    // The fake transport does catch the notice a client-opened ticket sends.
    const [person] = await db.insert(clientUsers).values({ name: "Carla", email: "carla@client.com" }).returning();
    await db.update(tickets).set({ createdByType: "client", createdById: person.id }).where(eq(tickets.id, row.id));
    expect(await notifyTicketOpened(row.id, { db })).toMatchObject({ sent: 1 });
    expect(mailed).toHaveBeenCalledTimes(1);
  });

  it("keeps a staff member's value and refuses a support ticket for a client without the plan", async () => {
    const opened = data(await call(owner, "open_ticket", { client_id: acme.id, type: "single", title: "Landing page", value_cents: 150000 }));
    const [row] = await db.select().from(tickets).where(eq(tickets.id, opened.ticket.id));
    expect(row.valueCents).toBe(150000);

    const [noPlan] = await db.insert(clients).values({ name: "Gamma" }).returning();
    const refusedNow = await call(manager, "open_ticket", { client_id: noPlan.id, type: "support", title: "Help" });
    expect(sentence(refusedNow)).toBe(pt.tickets.errors.supportNeedsPlan);
  });
});

describe("reply_to_ticket and message changes", () => {
  it("stores Markdown as sanitized HTML (a script tag never survives) and keeps the reply-to link", async () => {
    const ticketId = await openAs(owner, acme, "Banner");
    const first = data(await call(collab, "reply_to_ticket", { ticket_id: ticketId, text: "Done **now** <script>alert(1)</script>" }));
    expect(first).toEqual({ ok: true, ticket_id: ticketId, message_id: expect.any(String) });
    const [stored] = await db.select().from(messages).where(eq(messages.id, first.message_id));
    expect(stored.bodyHtml).toContain("<strong>now</strong>");
    expect(stored.bodyHtml).not.toContain("<script");

    const second = data(await call(owner, "reply_to_ticket", { ticket_id: ticketId, text: "Thanks", reply_to: first.message_id }));
    const [threaded] = await db.select().from(messages).where(eq(messages.id, second.message_id));
    expect(threaded.replyToId).toBe(first.message_id);

    const edited = data(await call(collab, "edit_ticket_message", { ticket_id: ticketId, message_id: first.message_id, text: "Done *today*" }));
    expect(edited).toEqual({ ok: true, ticket_id: ticketId, message_id: first.message_id, changed: true });
    const [after] = await db.select().from(messages).where(eq(messages.id, first.message_id));
    expect(after.bodyHtml).toBe("<p>Done <em>today</em></p>");
    // A collaborator can't touch the owner's message.
    const notTheirs = await call(collab, "delete_ticket_message", { ticket_id: ticketId, message_id: second.message_id });
    expect(sentence(notTheirs)).toBe(en.tickets.errors.forbidden);
    expect(data(await call(owner, "delete_ticket_message", { ticket_id: ticketId, message_id: second.message_id })).changed).toBe(true);

    expect(data(await call(owner, "close_ticket", { ticket_id: ticketId }))).toEqual({ ok: true, ticket_id: ticketId, status: "closed", changed: true });
    expect(data(await call(owner, "close_ticket", { ticket_id: ticketId })).changed).toBe(false);
    expect(sentence(await call(collab, "reply_to_ticket", { ticket_id: ticketId, text: "More" }))).toBe(en.tickets.errors.closed);
    expect(data(await call(collab, "reopen_ticket", { ticket_id: ticketId }))).toEqual({ ok: true, ticket_id: ticketId, status: "open", changed: true });
  });
});

describe("get_ticket", () => {
  it("shows the ticket and never marks it read", async () => {
    const ticketId = await openAs(owner, acme, "Banner");
    await clientWrites(ticketId, "Any news?");

    const first = data(await call(owner, "get_ticket", { ticket_id: ticketId })).ticket;
    expect(first).toMatchObject({
      id: ticketId,
      number: 1,
      title: "Banner",
      status: "open",
      whose_turn: "agency",
      unread_messages: 1,
      client: { id: acme.id, name: "Acme" },
      opened_by: { side: "agency", name: "Ana" },
      assignees: [{ id: owner.id, name: "Ana" }],
      url: `https://agency.test/admin/tickets/${ticketId}`,
      value_cents: null,
      currency: "BRL",
      client_hours: { mode: "package", used_minutes: 0, total_minutes: 120, balance_minutes: 120 },
    });
    expect(first.messages.map((m: { from: string; text: string }) => [m.from, m.text])).toEqual([
      ["agency", "Start"],
      ["client", "Any news?"],
    ]);

    const again = data(await call(owner, "get_ticket", { ticket_id: ticketId })).ticket;
    expect(again.unread_messages).toBe(1);
    expect(await db.select().from(ticketReads)).toEqual([]);

    // Money is staff business.
    const asCollab = data(await call(collab, "get_ticket", { ticket_id: ticketId })).ticket;
    expect(asCollab).not.toHaveProperty("value_cents");
    expect(asCollab).not.toHaveProperty("assignable");
  });

  it("answers a ticket outside a collaborator's scope exactly like one that doesn't exist", async () => {
    await db.update(agency).set({ collabTicketScope: "assigned", collabSeesUnassigned: false });
    const hiddenId = await openAs(owner, beta, "Owner's own work");

    const hidden = await call(collab, "get_ticket", { ticket_id: hiddenId });
    const missing = await call(collab, "get_ticket", { ticket_id: "00000000-0000-4000-8000-0000000000ff" });
    expect(hidden.isError).toBe(true);
    expect(sentence(hidden)).toBe(en.tickets.errors.notFound);
    expect(hidden).toEqual(missing);
    expect(data(await call(collab, "list_tickets")).tickets).toEqual([]);
    // Staff see it.
    expect(data(await call(owner, "get_ticket", { ticket_id: hiddenId })).ticket.id).toBe(hiddenId);
  });
});

describe("log_time", () => {
  it("logs whole minutes on today in the agency's time zone, and deletes the entry", async () => {
    const ticketId = await openAs(owner, acme, "Banner");
    const logged = data(await call(collab, "log_time", { ticket_id: ticketId, minutes: 45, note: "layout" }));
    const today = todayInCycleZone(new Date(), "America/Sao_Paulo");
    expect(logged).toEqual({ ok: true, ticket_id: ticketId, time_entry_id: expect.any(String), minutes: 45, worked_on: today });
    const [entry] = await db.select().from(timeEntries);
    expect(entry).toMatchObject({ minutes: 45, workedOn: today, note: "layout", createdById: collab.id });

    expect(data(await call(collab, "delete_time_entry", { ticket_id: ticketId, time_entry_id: entry.id }))).toEqual({
      ok: true,
      ticket_id: ticketId,
      time_entry_id: entry.id,
    });
    expect(await db.select().from(timeEntries)).toEqual([]);
  });

  it("refuses 0, negative, fractional and over-the-limit minutes, logging nothing", async () => {
    const ticketId = await openAs(owner, acme, "Banner");
    // Each reaches the core and gets the panel's sentence, in the person's language.
    for (const minutes of [0, -5, 1.5, 24 * 60 + 1]) {
      const result = await call(collab, "log_time", { ticket_id: ticketId, minutes });
      expect(result.isError).toBe(true);
      expect(sentence(result)).toBe(en.tickets.errors.invalidDuration);
      const asManager = await call(manager, "log_time", { ticket_id: ticketId, minutes });
      expect(sentence(asManager)).toBe(pt.tickets.errors.invalidDuration);
    }
    const future = await call(manager, "log_time", { ticket_id: ticketId, minutes: 30, worked_on: "2999-01-01" });
    expect(sentence(future)).toBe(pt.tickets.errors.futureDate);
    expect(await db.select().from(timeEntries)).toEqual([]);
  });
});

describe("set_ticket_value", () => {
  it("lets staff set and clear a single ticket's value, refuses collaborators and support tickets", async () => {
    const ticketId = await openAs(owner, acme, "Landing page", "single");
    const collabTry = await call(collab, "set_ticket_value", { ticket_id: ticketId, value_cents: 9900 });
    expect(sentence(collabTry)).toBe(en.mcp.staffOnly);

    expect(data(await call(manager, "set_ticket_value", { ticket_id: ticketId, value_cents: 9900 }))).toEqual({
      ok: true,
      ticket_id: ticketId,
      value_cents: 9900,
    });
    expect((await db.select().from(tickets).where(eq(tickets.id, ticketId)))[0].valueCents).toBe(9900);
    expect(data(await call(owner, "set_ticket_value", { ticket_id: ticketId, value_cents: null })).value_cents).toBeNull();
    expect((await db.select().from(tickets).where(eq(tickets.id, ticketId)))[0].valueCents).toBeNull();

    const supportId = await openAs(owner, acme, "Monthly");
    expect(sentence(await call(owner, "set_ticket_value", { ticket_id: supportId, value_cents: 100 }))).toBe(en.charges.errors.invalid);
  });
});

describe("assignees", () => {
  it("lets a collaborator take an unassigned ticket, and staff add or remove people", async () => {
    const ticketId = await openAs(owner, acme, "Banner");
    await db.delete(ticketAssignments);
    expect(data(await call(collab, "assume_ticket", { ticket_id: ticketId }))).toEqual({ ok: true, ticket_id: ticketId });
    expect(sentence(await call(collab, "assign_ticket", { ticket_id: ticketId, user_id: manager.id }))).toBe(en.mcp.staffOnly);
    expect(data(await call(owner, "assign_ticket", { ticket_id: ticketId, user_id: manager.id }))).toEqual({
      ok: true,
      ticket_id: ticketId,
      user_id: manager.id,
    });
    expect(data(await call(owner, "unassign_ticket", { ticket_id: ticketId, user_id: collab.id })).ok).toBe(true);
    const people = await db.select({ userId: ticketAssignments.userId }).from(ticketAssignments);
    expect(people).toEqual([{ userId: manager.id }]);
    // Taken by someone else: a collaborator can no longer assume it.
    expect(sentence(await call(collab, "assume_ticket", { ticket_id: ticketId }))).toBe(en.tickets.errors.forbidden);
  });
});

describe("list_tickets and get_home", () => {
  it("lists with whose turn per row, filters and pages", async () => {
    const quiet = await openAs(owner, acme, "Quiet");
    const asked = await openAs(collab, beta, "Asked");
    await clientWrites(asked, "Hello?");

    const all = data(await call(owner, "list_tickets"));
    expect(all).toMatchObject({ total: 2, page: 1, per_page: 50, next_page: null });
    expect(all.tickets.map((t: { id: string; whose_turn: string }) => [t.id, t.whose_turn])).toEqual([
      [asked, "agency"],
      [quiet, "client"],
    ]);
    expect(all.tickets[0]).toMatchObject({
      number: 2,
      title: "Asked",
      status: "open",
      // Cy's opening message and the client's, both unread for the owner.
      unread_messages: 2,
      client: { id: beta.id, name: "Beta" },
      site: null,
      assignees: [{ id: collab.id, name: "Cy" }],
      unassigned: false,
      labels: [],
      url: `https://agency.test/admin/tickets/${asked}`,
    });

    expect(data(await call(owner, "list_tickets", { turn: "agency" })).tickets.map((t: { id: string }) => t.id)).toEqual([asked]);
    expect(data(await call(collab, "list_tickets", { who: "mine" })).tickets.map((t: { id: string }) => t.id)).toEqual([asked]);
    expect(data(await call(owner, "list_tickets", { unread_only: true, client_id: beta.id })).total).toBe(1);
    expect(data(await call(owner, "list_tickets", { search: "#1" })).tickets.map((t: { id: string }) => t.id)).toEqual([quiet]);
    expect(data(await call(owner, "list_tickets", { page: 2 }))).toMatchObject({ tickets: [], total: 2, page: 2, next_page: null });
  });

  it("answers what needs the person, the month's figures for their role and recent activity", async () => {
    const answered = await openAs(collab, beta, "Asked");
    await clientWrites(answered, "Hello?");
    const free = await openAs(owner, acme, "Free");
    await db.delete(ticketAssignments).where(eq(ticketAssignments.ticketId, free));

    const staff = data(await call(owner, "get_home"));
    expect(staff.figures).toEqual({ open_tickets: 2, clients_with_support: 2, minutes_used_this_month: 0, negative_hour_balances: 0 });
    expect(staff.needs_you.map((t: { id: string }) => t.id)).toEqual([free]);
    expect(staff.needs_you_total).toBe(1);
    expect(staff.recent.map((t: { id: string }) => t.id)).toEqual([free, answered]);

    const mine = data(await call(collab, "get_home"));
    expect(mine.figures).toEqual({ my_open_tickets: 1, unassigned_tickets: 1, my_clients: 1 });
    expect(mine.needs_you.map((t: { id: string; last_message_by: string | null }) => [t.id, t.last_message_by])).toEqual([
      [free, "Ana"],
      [answered, "Carla"],
    ]);
    expect(mine.needs_you_total).toBe(2);
  });
});
