import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { resetTestDb } from "@/test/db";
import {
  agency,
  autoAssignUsers,
  charges,
  clientAssignments,
  clients,
  quotes,
  sites,
  users,
  type Client,
  type Db,
  type Site,
  type User,
} from "@/lib/db";
import { changeRole } from "@/lib/core/team";
import { en } from "@/lib/i18n/en";
import { pt } from "@/lib/i18n/pt";
import { CHARGE_TOOLS } from "./charge-tools";
import { CLIENT_TOOLS } from "./client-tools";
import { LABEL_TOOLS } from "./label-tools";
import { QUOTE_TOOLS } from "./quote-tools";
import { buildServer } from "./server";
import { SETTINGS_TOOLS } from "./settings-tools";
import { TEAM_TOOLS } from "./team-tools";
import { TICKET_TOOLS } from "./ticket-tools";
import type { ToolScope } from "./tools";

// A fake mail transport: every e-mail the app would send lands here instead.
type Mail = { to: string; text: string; html: string };
const mailed = vi.hoisted(() => vi.fn<(msg: Mail) => Promise<{ sent: boolean }>>(async () => ({ sent: true })));
vi.mock("@/lib/mail/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/send")>()),
  sendMail: mailed,
}));

// The cores and the connector read the app database: point it at the test one.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://agency.test";
// Both providers turned on (fake keys: creating a charge never calls them; the checkout opens on /pay).
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-fake";
process.env.MERCADOPAGO_WEBHOOK_SECRET = "mp-fake";

let db: Db;
let owner: User;
let manager: User;
let collab: User;
let acme: Client;
let shop: Site;

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

/** Every answer of this file, to look for secrets in. */
const answers: string[] = [];

async function rpc(user: User, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(() => buildServer(scopeOf(user)), { responseMode: "json" });
  const response = await handler.fetch(
    new Request("https://agency.test/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL,
        "Mcp-Method": method,
        ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    }),
  );
  const raw = await response.text();
  answers.push(raw);
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Calls a tool as `user` through the real MCP handler. */
async function call(user: User, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const message = await rpc(user, "tools/call", { name, arguments: args });
  if (!message.result) throw new Error(`${name}: ${JSON.stringify(message)}`);
  return message.result as ToolResult;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped tool answers */
function data(result: ToolResult): Record<string, any> {
  if (result.isError) throw new Error(`unexpected refusal: ${result.content[0]?.text}`);
  return result.structuredContent ?? {};
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const sentence = (r: ToolResult) => r.content[0]?.text;

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
  [acme] = await db
    .insert(clients)
    .values({ name: "Acme", email: "hi@acme.com", supportActive: true, supportMonthlyCents: 100000 })
    .returning();
  [shop] = await db.insert(sites).values({ clientId: acme.id, name: "Shop", url: "https://shop.acme.com" }).returning();
  mailed.mockClear();
  mailed.mockResolvedValue({ sent: true });
  answers.length = 0;
});

afterAll(async () => {
  await db?.$client.end();
});

const siteItem = { kind: "site_creation", title: "New site", amount_cents: 500000, new_site: { name: "Store" } };

async function draftQuote(args: Record<string, unknown> = {}): Promise<string> {
  const res = data(await call(owner, "create_quote", { title: "Website", client_id: acme.id, items: [siteItem], ...args }));
  return res.quote.id;
}

describe("tools/list", () => {
  it("gives the owner the 59 tools", async () => {
    const message = await rpc(owner, "tools/list", {});
    const names = ((message.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name).sort();
    const all = [...SETTINGS_TOOLS, ...TICKET_TOOLS, ...LABEL_TOOLS, ...CLIENT_TOOLS, ...QUOTE_TOOLS, ...CHARGE_TOOLS, ...TEAM_TOOLS];
    expect(names).toHaveLength(59);
    expect(names).toEqual([...all].sort());
  });

  it("marks the tools that e-mail people or reach a payment provider as open-world", async () => {
    const message = await rpc(owner, "tools/list", {});
    type Listed = { name: string; annotations?: { openWorldHint?: boolean; idempotentHint?: boolean } };
    const tools = (message.result as { tools: Listed[] }).tools;
    const openWorld = tools.filter((t) => t.annotations?.openWorldHint).map((t) => t.name).sort();
    expect(openWorld).toEqual(
      ["cancel_charge", "create_charge", "invite_member", "invite_to_portal", "mark_charge_paid", "resend_portal_invite", "send_quote"].sort(),
    );
    // A second mark_charge_paid is refused, so it isn't idempotent.
    expect(tools.find((t) => t.name === "mark_charge_paid")?.annotations?.idempotentHint).toBe(false);
  });
});

describe("quotes", () => {
  it("creates, reads, edits and lists a client's quote, filtering on the page", async () => {
    const created = data(
      await call(owner, "create_quote", {
        title: "Website",
        client_id: acme.id,
        notes: "Valid for 30 days",
        items: [
          siteItem,
          { kind: "maintenance", title: "Fix shop", amount_cents: 20000, site_id: shop.id },
          { kind: "support", title: "Plan", amount_cents: 90000, site_ids: [shop.id], track_hours: true, show_hours_to_client: true, included_minutes_per_month: 300, extra_hour_cents: 12000, client_can_buy_hours: true },
        ],
      }),
    );
    expect(created.quote).toMatchObject({ status: "draft", one_time_cents: 520000, monthly_cents: 90000, currency: "BRL" });
    const id = created.quote.id;

    const { quote } = data(await call(owner, "get_quote", { quote_id: id }));
    expect(quote).toMatchObject({ title: "Website", notes: "Valid for 30 days", editable: true, public_url: null, charge: null });
    expect(quote.client).toEqual({ id: acme.id, name: "Acme" });
    expect(quote.items[1]).toMatchObject({ kind: "maintenance", billing: "one_time", site_id: shop.id });
    expect(quote.items[2]).toMatchObject({
      kind: "support",
      billing: "monthly",
      site_ids: [shop.id],
      track_hours: true,
      show_hours_to_client: true,
      included_minutes_per_month: 300,
      extra_hour_cents: 12000,
      client_can_buy_hours: true,
    });

    const edited = data(await call(owner, "update_quote", { quote_id: id, title: "Website v2", client_id: acme.id, items: [siteItem] }));
    expect(edited.quote).toMatchObject({ id, title: "Website v2", one_time_cents: 500000, monthly_cents: 0 });

    const prospect = await draftQuote({ client_id: undefined, prospect_name: "Padaria Aurora", prospect_email: "oi@aurora.com" });
    data(await call(owner, "archive_quote", { quote_id: prospect }));
    const all = data(await call(owner, "list_quotes"));
    expect(all.total).toBe(2);
    const archived = data(await call(owner, "list_quotes", { status: "archived" }));
    expect(archived.quotes.map((q: { id: string }) => q.id)).toEqual([prospect]);
    expect(archived.quotes[0].prospect).toEqual({ name: "Padaria Aurora", email: "oi@aurora.com" });
    const ofAcme = data(await call(owner, "list_quotes", { client_id: acme.id }));
    expect(ofAcme.quotes.map((q: { id: string }) => q.id)).toEqual([id]);
  });

  it("refuses with the panel's sentences: a site of another client, a locked quote", async () => {
    const [beta] = await db.insert(clients).values({ name: "Beta" }).returning();
    const bad = await call(owner, "create_quote", {
      title: "Fix",
      client_id: beta.id,
      items: [{ kind: "maintenance", title: "Fix", amount_cents: 100, site_id: shop.id }],
    });
    expect(sentence(bad)).toBe(en.quotes.errors.invalidSite);
    const id = await draftQuote();
    data(await call(owner, "archive_quote", { quote_id: id }));
    const locked = await call(owner, "update_quote", { quote_id: id, title: "X", client_id: acme.id, items: [siteItem] });
    expect(sentence(locked)).toBe(en.quotes.errors.quoteLocked);
    const again = data(await call(owner, "archive_quote", { quote_id: id }));
    expect(again.changed).toBe(false);
  });

  it("an archived quote has no public link, as in the panel", async () => {
    mailed.mockResolvedValue({ sent: false });
    const id = await draftQuote();
    data(await call(owner, "send_quote", { quote_id: id }));
    expect(data(await call(owner, "get_quote", { quote_id: id })).quote.public_url).toMatch(/^https:\/\/agency\.test\/q\//);
    data(await call(owner, "archive_quote", { quote_id: id }));
    expect(data(await call(owner, "get_quote", { quote_id: id })).quote.public_url).toBeNull();
  });

  it("send_quote without e-mail says the quote is marked sent and no e-mail went out", async () => {
    mailed.mockResolvedValue({ sent: false });
    const id = await draftQuote();
    const res = data(await call(owner, "send_quote", { quote_id: id }));
    expect(res).toMatchObject({ ok: true, email_sent: false, emailed_to: null, notice: en.quotes.sentNoEmail });
    expect(res.quote.status).toBe("sent");
    const [row] = await db.select().from(quotes).where(eq(quotes.id, id));
    expect(row.status).toBe("sent");
    expect(res.quote.public_url).toBe(`https://agency.test/q/${row.token}`);
  });

  it("send_quote with e-mail says who got it", async () => {
    const id = await draftQuote();
    const res = data(await call(owner, "send_quote", { quote_id: id }));
    expect(res).toMatchObject({ email_sent: true, emailed_to: "hi@acme.com" });
    expect(res.notice).toBeUndefined();
  });

  it("is the owner's: managers and collaborators get the role refusal", async () => {
    expect(sentence(await call(manager, "list_quotes"))).toBe(pt.mcp.ownerOnly);
    expect(sentence(await call(collab, "create_quote", { title: "X", client_id: acme.id, items: [siteItem] }))).toBe(en.mcp.ownerOnly);
  });

  it("an owner demoted with changeRole gets the role refusal from create_quote on the next call", async () => {
    const second = await makeUser("Dora", "owner");
    data(await call(second, "create_quote", { title: "Before", client_id: acme.id, items: [siteItem] }));
    const res = await changeRole({ userType: "agency", user: owner }, second.id, "manager", { db });
    expect(res.ok).toBe(true);
    const after = await call(second, "create_quote", { title: "After", client_id: acme.id, items: [siteItem] });
    expect(sentence(after)).toBe(en.mcp.ownerOnly);
    expect(await db.select().from(quotes).where(eq(quotes.title, "After"))).toHaveLength(0);
  });
});

describe("charges", () => {
  it("create_charge without provider uses the agency's default provider", async () => {
    await db.update(agency).set({ defaultPaymentProvider: "mercadopago" }).where(eq(agency.id, 1));
    const res = data(
      await call(manager, "create_charge", { source: "none", client_id: acme.id, label: "Hosting", amount_cents: 30000 }),
    );
    expect(res.charge).toMatchObject({ provider: "mercadopago", status: "pending", amount_cents: 30000, currency: "BRL", label: "Hosting" });
    expect(res.charge.pay_url).toMatch(/^https:\/\/agency\.test\/pay\//);
    const [row] = await db.select().from(charges).where(eq(charges.id, res.charge.id));
    expect(row.provider).toBe("mercadopago");

    // No default: the first provider the charge can use, as the panel preselects.
    await db.update(agency).set({ defaultPaymentProvider: null }).where(eq(agency.id, 1));
    const plan = data(await call(owner, "create_charge", { source: "support", id: acme.id }));
    expect(plan.charge).toMatchObject({ provider: "stripe", kind: "subscription", amount_cents: 100000, source: { type: "support", id: acme.id } });
  });

  it("refuses Mercado Pago for an agency charging in USD with the panel's sentence, writing nothing", async () => {
    await db.update(agency).set({ currency: "USD" }).where(eq(agency.id, 1));
    const res = await call(manager, "create_charge", {
      source: "none",
      client_id: acme.id,
      label: "Hosting",
      amount_cents: 30000,
      provider: "mercadopago",
    });
    expect(sentence(res)).toBe(pt.charges.errors.providerUnavailable);
    expect(await db.select().from(charges)).toHaveLength(0);
    // The manual record is always there.
    const manual = data(
      await call(manager, "create_charge", { source: "none", client_id: acme.id, label: "Hosting", amount_cents: 30000, provider: "manual" }),
    );
    expect(manual.charge).toMatchObject({ provider: null, currency: "USD" });
  });

  it("a quote's charge is the owner's: a manager gets the role refusal creating it and not found reading it", async () => {
    const id = await draftQuote();
    data(await call(owner, "send_quote", { quote_id: id }));
    const refusedCreate = await call(manager, "create_charge", { source: "quote", id, provider: "manual" });
    expect(sentence(refusedCreate)).toBe(pt.mcp.ownerOnly);
    expect(await db.select().from(charges)).toHaveLength(0);

    const made = data(await call(owner, "create_charge", { source: "quote", id, provider: "manual" }));
    expect(made.charge).toMatchObject({ source: { type: "quote", id }, amount_cents: 500000, provider: null });
    const hidden = await call(manager, "get_charge", { charge_id: made.charge.id });
    expect(sentence(hidden)).toBe(pt.charges.errors.notFound);
    const listed = data(await call(manager, "list_charges"));
    expect(listed.charges).toHaveLength(0);
    const seen = data(await call(owner, "get_charge", { charge_id: made.charge.id }));
    expect(seen.charge.id).toBe(made.charge.id);
    const { quote } = data(await call(owner, "get_quote", { quote_id: id }));
    expect(quote.charge).toMatchObject({ id: made.charge.id, status: "pending" });
  });

  it("lists with filters, marks a one-time charge paid and cancels another", async () => {
    const one = data(await call(owner, "create_charge", { source: "none", client_id: acme.id, label: "Domain", amount_cents: 5000, provider: "manual" }));
    const plan = data(await call(owner, "create_charge", { source: "support", id: acme.id, provider: "manual" }));
    const listed = data(await call(manager, "list_charges", { client_id: acme.id }));
    expect(listed.charges).toHaveLength(2);
    expect(listed.payment_providers).toEqual({ stripe: true, mercadopago: true });

    const paid = data(await call(manager, "mark_charge_paid", { charge_id: one.charge.id }));
    expect(paid.charge).toMatchObject({ status: "paid", pay_url: null });
    expect(paid.charge.paid_at).toBeTruthy();
    const notPending = await call(manager, "mark_charge_paid", { charge_id: plan.charge.id });
    expect(sentence(notPending)).toBe(pt.charges.errors.chargeNotPending);
    const canceled = data(await call(manager, "cancel_charge", { charge_id: plan.charge.id }));
    expect(canceled).toMatchObject({ changed: true, charge: { status: "canceled", pay_url: null } });
    expect(sentence(await call(manager, "cancel_charge", { charge_id: one.charge.id }))).toBe(pt.charges.errors.alreadyPaid);
    expect(data(await call(owner, "list_charges", { status: "paid" })).charges.map((c: { id: string }) => c.id)).toEqual([one.charge.id]);
  });

  it("is staff business", async () => {
    expect(sentence(await call(collab, "list_charges"))).toBe(en.mcp.staffOnly);
  });
});

describe("team", () => {
  it("list_team: the owner sees e-mails, pending invites and clients; a manager only names and roles", async () => {
    await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.id });
    await db.insert(autoAssignUsers).values({ clientId: null, userId: manager.id });
    const full = data(await call(owner, "list_team"));
    const cy = full.members.find((m: { id: string }) => m.id === collab.id);
    expect(cy).toMatchObject({ name: "Cy", email: "cy@x.com", role: "collaborator", invite_pending: false, clients: [{ id: acme.id, name: "Acme" }] });
    expect(full.members.find((m: { id: string }) => m.id === owner.id).you).toBe(true);

    const basic = data(await call(manager, "list_team"));
    expect(basic.members).toHaveLength(3);
    for (const m of basic.members) expect(Object.keys(m).sort()).toEqual(["id", "in_auto_assign", "name", "role", "you"]);
    expect(basic.members.find((m: { id: string }) => m.id === manager.id).in_auto_assign).toBe(true);
    expect(JSON.stringify(basic)).not.toContain("@x.com");
    expect(sentence(await call(collab, "list_team"))).toBe(en.mcp.staffOnly);
  });

  it("invite_member without e-mail set up creates the invite and never returns the link", async () => {
    mailed.mockResolvedValue({ sent: false });
    const res = data(await call(owner, "invite_member", { name: "Eva", email: "Eva@X.com" }));
    expect(res).toMatchObject({
      ok: true,
      member: { name: "Eva", email: "eva@x.com", role: "collaborator", invite_pending: true },
      email_sent: false,
      notice: en.mcp.teamInviteNotEmailed,
      team_url: "https://agency.test/admin/team",
    });
    const [row] = await db.select().from(users).where(eq(users.email, "eva@x.com"));
    expect(row.passwordHash).toBeNull();
    // The link was built (the mail carried it) but never came back.
    const tokens = mailed.mock.calls.flatMap(([msg]) => [...`${msg.text} ${msg.html}`.matchAll(/\/set-password\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
    expect(tokens.length).toBeGreaterThan(0);
    for (const text of answers) {
      expect(text).not.toContain("/set-password");
      for (const token of tokens) expect(text).not.toContain(token);
    }
    expect(sentence(await call(owner, "invite_member", { name: "Eva", email: "eva@x.com" }))).toBe(en.team.errors.emailTaken);
  });

  it("changes roles keeping one owner, sets a member's clients and removes a member; all owner only", async () => {
    expect(sentence(await call(owner, "change_member_role", { user_id: owner.id, role: "manager" }))).toBe(en.team.errors.lastOwner);
    const promoted = data(await call(owner, "change_member_role", { user_id: collab.id, role: "manager" }));
    expect(promoted.member).toEqual({ id: collab.id, name: "Cy", role: "manager" });

    const set = data(await call(owner, "set_member_clients", { user_id: collab.id, client_ids: [acme.id] }));
    expect(set.clients).toEqual([{ id: acme.id, name: "Acme" }]);
    expect(await db.select().from(clientAssignments).where(eq(clientAssignments.userId, collab.id))).toHaveLength(1);

    expect(sentence(await call(manager, "remove_member", { user_id: collab.id }))).toBe(pt.mcp.ownerOnly);
    expect(sentence(await call(owner, "remove_member", { user_id: owner.id }))).toBe(en.team.errors.self);
    data(await call(owner, "remove_member", { user_id: collab.id }));
    expect(await db.select().from(users).where(eq(users.id, collab.id))).toHaveLength(0);
  });
});

describe("settings", () => {
  it("update_agency with only time_zone keeps name, currency and language; an unknown zone is refused", async () => {
    const res = data(await call(owner, "update_agency", { time_zone: "Europe/Lisbon" }));
    expect(res.agency).toEqual({ name: "Studio Acme", currency: "BRL", locale: "en", time_zone: "Europe/Lisbon" });
    let [row] = await db.select().from(agency);
    expect([row.name, row.currency, row.locale, row.timeZone]).toEqual(["Studio Acme", "BRL", "en", "Europe/Lisbon"]);

    const bad = await call(owner, "update_agency", { name: "Other", time_zone: "Mars/Base" });
    expect(sentence(bad)).toBe(en.settings.errors.invalidTimeZone);
    [row] = await db.select().from(agency);
    expect(row.name).toBe("Studio Acme");
    expect(sentence(await call(manager, "update_agency", { name: "X" }))).toBe(pt.mcp.ownerOnly);
  });

  it("set_collaborator_visibility changes only what is given", async () => {
    const res = data(await call(owner, "set_collaborator_visibility", { ticket_scope: "assigned" }));
    expect(res).toMatchObject({ client_scope: "all", ticket_scope: "assigned", sees_unassigned: true });
    const [row] = await db.select().from(agency);
    expect([row.collabClientScope, row.collabTicketScope, row.collabSeesUnassigned]).toEqual(["all", "assigned", true]);
  });

  it("set_auto_assign keeps the people when only enabled is given, and is the owner's", async () => {
    data(await call(owner, "set_auto_assign", { enabled: true, user_ids: [collab.id, manager.id] }));
    const off = data(await call(owner, "set_auto_assign", { enabled: false }));
    expect(off.enabled).toBe(false);
    expect([...off.user_ids].sort()).toEqual([collab.id, manager.id].sort());
    const on = data(await call(owner, "set_auto_assign", { enabled: true }));
    expect(on.enabled).toBe(true);

    // As in the panel, managers and collaborators can't change the agency's rotation.
    expect(sentence(await call(manager, "set_auto_assign", { enabled: false, user_ids: [manager.id] }))).toBe(pt.mcp.ownerOnly);
    expect(sentence(await call(collab, "set_auto_assign", { enabled: false }))).toBe(en.mcp.ownerOnly);
    const [row] = await db.select().from(agency);
    expect(row.autoAssign).toBe(true);
    const people = await db.select().from(autoAssignUsers).where(isNull(autoAssignUsers.clientId));
    expect(people.map((p) => p.userId).sort()).toEqual([collab.id, manager.id].sort());
  });
});
