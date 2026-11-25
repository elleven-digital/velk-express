import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { resetTestDb } from "@/test/db";
import {
  agency,
  autoAssignUsers,
  clientAssignments,
  clientMemberships,
  clients,
  clientUsers,
  hourPurchases,
  sites,
  users,
  type Client,
  type Db,
  type Site,
  type User,
} from "@/lib/db";
import { en } from "@/lib/i18n/en";
import { pt } from "@/lib/i18n/pt";
import { buildServer } from "./server";
import type { ToolScope } from "./tools";

// A fake mail transport: every e-mail the app would send lands here instead.
type Mail = { to: string; text: string; html: string };
const mailed = vi.hoisted(() => vi.fn<(msg: Mail) => Promise<{ sent: boolean }>>(async () => ({ sent: true })));
vi.mock("@/lib/mail/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/send")>()),
  sendMail: mailed,
}));

// Lets a test make the support plan's write fail after the client's data was saved.
const supportFails = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/core/clients", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/core/clients")>();
  return {
    ...real,
    updateSupport: (...args: Parameters<typeof real.updateSupport>) =>
      supportFails.on ? Promise.resolve({ ok: false as const, error: "invalid" }) : real.updateSupport(...args),
  };
});

// The cores and the connector read the app database: point it at the test one.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://agency.test";

let db: Db;
let owner: User;
let manager: User;
let collab: User;
let acme: Client;
let inPlan: Site;
let outOfPlan: Site;

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

/** Every answer of this file, to look for secrets in at the end of a test. */
const answers: string[] = [];

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
  const raw = await response.text();
  answers.push(raw);
  const message = JSON.parse(raw) as { result?: ToolResult; error?: unknown };
  if (!message.result) throw new Error(`${name}: ${raw}`);
  return message.result;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped tool answers */
function data(result: ToolResult): Record<string, any> {
  if (result.isError) throw new Error(`unexpected refusal: ${result.content[0]?.text}`);
  return result.structuredContent ?? {};
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const sentence = (r: ToolResult) => r.content[0]?.text;

/** The raw tokens of every invite e-mail the app tried to send so far. */
function mailedTokens(expectSome: boolean): string[] {
  const tokens = mailed.mock.calls.flatMap(([msg]) =>
    [...`${msg.text} ${msg.html}`.matchAll(/\/set-password\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  );
  // Each invite mail carries its link: the check below means something.
  if (expectSome) expect(tokens.length).toBeGreaterThan(0);
  return tokens;
}

/** No answer carries an invite or reset link, nor any token the app mailed (`invites`: some invite was mailed). */
function expectNoSecrets(invites = true) {
  const tokens = mailedTokens(invites);
  for (const text of answers) {
    expect(text).not.toContain("/set-password");
    for (const token of tokens) expect(text).not.toContain(token);
  }
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
  [acme] = await db
    .insert(clients)
    .values({
      name: "Acme",
      email: "hi@acme.com",
      phone: "555-1000",
      notes: "Big client",
      supportActive: true,
      supportMonthlyCents: 100000,
      generalTicketsEnabled: true,
      hoursTracked: true,
      hoursVisible: true,
      hoursLimited: true,
      hoursPurchasable: true,
      includedMinutes: 600,
      extraHourCents: 15000,
    })
    .returning();
  [inPlan, outOfPlan] = await db
    .insert(sites)
    .values([
      { clientId: acme.id, name: "Shop", url: "https://shop.acme.com", notes: "Main", includedInSupport: true },
      { clientId: acme.id, name: "Blog", url: "https://blog.acme.com", includedInSupport: false },
    ])
    .returning();
  mailed.mockClear();
  mailed.mockResolvedValue({ sent: true });
  answers.length = 0;
});

afterAll(async () => {
  await db?.$client.end();
});

async function reload(): Promise<{ client: Client; sites: Site[] }> {
  const [client] = await db.select().from(clients).where(eq(clients.id, acme.id));
  const rows = await db.select().from(sites).where(eq(sites.clientId, acme.id));
  return { client, sites: rows };
}

describe("update_client", () => {
  it("with only monthly_amount keeps the hours options, the sites in the plan and the included minutes", async () => {
    const res = data(await call(manager, "update_client", { client_id: acme.id, monthly_amount: "1.500,00" }));
    expect(res.ok).toBe(true);
    const { client, sites: after } = await reload();
    expect(client.supportMonthlyCents).toBe(150000);
    expect(client.supportActive).toBe(true);
    expect(client).toMatchObject({ hoursTracked: true, hoursVisible: true, hoursLimited: true, hoursPurchasable: true });
    expect(client.includedMinutes).toBe(600);
    expect(client.extraHourCents).toBe(15000);
    expect(client.generalTicketsEnabled).toBe(true);
    expect(after.find((s) => s.id === inPlan.id)?.includedInSupport).toBe(true);
    expect(after.find((s) => s.id === outOfPlan.id)?.includedInSupport).toBe(false);
    // The company data didn't move either.
    expect([client.name, client.email, client.phone, client.notes]).toEqual(["Acme", "hi@acme.com", "555-1000", "Big client"]);
    expect(res.client.support.monthly_cents).toBe(150000);
  });

  it("with only a name keeps e-mail, phone and notes; a bad amount is refused with the panel's sentence and changes nothing", async () => {
    data(await call(owner, "update_client", { client_id: acme.id, name: "Acme Inc" }));
    let { client } = await reload();
    expect([client.name, client.email, client.phone, client.notes]).toEqual(["Acme Inc", "hi@acme.com", "555-1000", "Big client"]);
    expect(client.supportMonthlyCents).toBe(100000);

    const bad = await call(manager, "update_client", { client_id: acme.id, name: "Other", monthly_amount: "lots" });
    expect(bad.isError).toBe(true);
    expect(sentence(bad)).toBe(pt.clients.errors.invalidMoney);
    ({ client } = await reload());
    expect(client.name).toBe("Acme Inc");
    expect(client.supportMonthlyCents).toBe(100000);
  });

  it("switches the hours options and the sites in the plan when asked", async () => {
    data(await call(owner, "update_client", { client_id: acme.id, show_hours_to_client: false, sites_in_plan: [outOfPlan.id] }));
    const { client, sites: after } = await reload();
    // Hours stay tracked with included hours; buying needs the client to see the hours, so it goes off.
    expect(client).toMatchObject({ hoursTracked: true, hoursVisible: false, hoursLimited: true, hoursPurchasable: false, includedMinutes: 600 });
    expect(client.supportMonthlyCents).toBe(100000);
    expect(after.find((s) => s.id === inPlan.id)?.includedInSupport).toBe(false);
    expect(after.find((s) => s.id === outOfPlan.id)?.includedInSupport).toBe(true);
  });

  it("included_minutes_per_month null removes the included hours and the extra hour price", async () => {
    const res = data(await call(owner, "update_client", { client_id: acme.id, included_minutes_per_month: null }));
    expect(res.ok).toBe(true);
    const { client } = await reload();
    expect(client).toMatchObject({
      hoursTracked: true,
      hoursVisible: true,
      hoursLimited: false,
      hoursPurchasable: false,
      includedMinutes: 0,
      extraHourCents: null,
    });
    expect(res.client.support).toMatchObject({ track_hours: true, show_hours_to_client: true, included_minutes_per_month: null, client_can_buy_hours: false });
  });

  it("says the client's data was saved when the plan is refused after it", async () => {
    supportFails.on = true;
    try {
      const res = await call(manager, "update_client", { client_id: acme.id, phone: "555-2000", monthly_amount: "1.500,00" });
      expect(res.isError).toBe(true);
      expect(sentence(res)).toBe(`${pt.clients.errors.invalid} ${pt.mcp.clientDataSavedPlanNot}`);
    } finally {
      supportFails.on = false;
    }
    const { client } = await reload();
    expect(client.phone).toBe("555-2000");
    expect(client.supportMonthlyCents).toBe(100000);

    // With only plan fields, the refusal is the panel's sentence alone.
    supportFails.on = true;
    try {
      const res = await call(manager, "update_client", { client_id: acme.id, monthly_amount: "1.500,00" });
      expect(sentence(res)).toBe(pt.clients.errors.invalid);
    } finally {
      supportFails.on = false;
    }
  });

  it("is refused to collaborators", async () => {
    const res = await call(collab, "update_client", { client_id: acme.id, name: "X" });
    expect(sentence(res)).toBe(en.mcp.staffOnly);
  });
});

describe("sites", () => {
  it("update_site with only a name keeps the site in the plan, its address and notes", async () => {
    data(await call(owner, "update_site", { client_id: acme.id, site_id: inPlan.id, name: "Store" }));
    const [site] = await db.select().from(sites).where(eq(sites.id, inPlan.id));
    expect(site).toMatchObject({ name: "Store", includedInSupport: true, url: "https://shop.acme.com", notes: "Main" });
  });

  it("adds and deletes a site, refusing a site of another client as not found", async () => {
    const added = data(await call(owner, "add_site", { client_id: acme.id, name: "Docs", url: "docs.acme.com", in_support_plan: true }));
    expect(added.site).toMatchObject({ name: "Docs", url: "https://docs.acme.com", in_support_plan: true });
    const [other] = await db.insert(clients).values({ name: "Beta" }).returning();
    const wrong = await call(owner, "delete_site", { client_id: other.id, site_id: added.site.id });
    expect(sentence(wrong)).toBe(en.clients.errors.notFound);
    data(await call(owner, "delete_site", { client_id: acme.id, site_id: added.site.id }));
    expect(await db.select().from(sites).where(eq(sites.id, added.site.id))).toHaveLength(0);
  });
});

describe("list_clients and get_client", () => {
  beforeEach(async () => {
    await db.insert(clientAssignments).values({ clientId: acme.id, userId: manager.id });
    await db.insert(autoAssignUsers).values({ clientId: acme.id, userId: manager.id });
    await db.update(clients).set({ autoAssign: true }).where(eq(clients.id, acme.id));
  });

  it("gives a collaborator no money, team or rotation", async () => {
    const { client } = data(await call(collab, "get_client", { client_id: acme.id }));
    expect(client).toMatchObject({ id: acme.id, name: "Acme", email: "hi@acme.com" });
    expect(client.support).toMatchObject({ active: true, track_hours: true, show_hours_to_client: true, included_minutes_per_month: 600, client_can_buy_hours: true });
    expect(client.sites.map((s: { name: string }) => s.name).sort()).toEqual(["Blog", "Shop"]);
    expect(client.hours).toMatchObject({ track_hours: true, show_hours_to_client: true, has_included_hours: true, balance_minutes: 600 });
    const text = JSON.stringify(client);
    for (const key of ["monthly_cents", "extra_hour_cents", "team", "rotation", "support_charge", "auto_assign"]) {
      expect(text).not.toContain(`"${key}"`);
    }
    const listed = data(await call(collab, "list_clients"));
    expect(JSON.stringify(listed)).not.toContain("monthly_cents");
  });

  it("gives staff the money, the team and the rotation", async () => {
    const { client } = data(await call(owner, "get_client", { client_id: acme.id }));
    expect(client.support).toMatchObject({ monthly_cents: 100000, extra_hour_cents: 15000, currency: "BRL" });
    expect(client.team).toEqual([{ id: manager.id, name: "Beto" }]);
    expect(client.rotation).toEqual({ enabled: true, people: [{ id: manager.id, name: "Beto" }] });
    expect(client.support_charge).toBeNull();
    const { clients: rows } = data(await call(owner, "list_clients"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: acme.id, sites: 2, support: { monthly_cents: 100000 } });
  });

  it("answers a client outside a collaborator's scope as not found", async () => {
    await db.update(agency).set({ collabClientScope: "assigned" });
    const res = await call(collab, "get_client", { client_id: acme.id });
    expect(sentence(res)).toBe(en.clients.errors.notFound);
    expect(data(await call(collab, "list_clients")).clients).toEqual([]);
  });

  it("sets the client's team and rotation", async () => {
    const team = data(await call(owner, "set_client_team", { client_id: acme.id, user_ids: [collab.id] }));
    expect(team.team).toEqual([{ id: collab.id, name: "Cy" }]);
    const rot = data(await call(owner, "set_client_rotation", { client_id: acme.id, enabled: true, user_ids: [] }));
    expect(rot.enabled).toBe(false);
  });
});

describe("hours", () => {
  it("get_hours of a client with hours off says so", async () => {
    const [off] = await db.insert(clients).values({ name: "Off Co", supportActive: true }).returning();
    const { hours } = data(await call(owner, "get_hours", { client_id: off.id, cycle: "2026-11" }));
    expect(hours).toMatchObject({ track_hours: false, show_hours_to_client: false, has_included_hours: false });
    expect(hours.notice).toBe(en.hours.notTracked);
    expect(hours).not.toHaveProperty("balance_minutes");
  });

  it("adds an hour package in minutes with the panel's price, shows it and deletes it", async () => {
    const added = data(
      await call(manager, "add_hour_package", { client_id: acme.id, minutes: 90, cycle: "2026-11", price: "150,00", note: "Extra" }),
    );
    const [row] = await db.select().from(hourPurchases).where(eq(hourPurchases.id, added.hour_package.id));
    expect(row).toMatchObject({ minutes: 90, cycle: "2026-11", priceCents: 15000, note: "Extra", pending: false });

    const { hours } = data(await call(manager, "get_hours", { client_id: acme.id, cycle: "2026-11" }));
    expect(hours).toMatchObject({ track_hours: true, show_hours_to_client: true, has_included_hours: true, included_minutes: 600, purchased_minutes: 90, balance_minutes: 690 });
    expect(hours.hour_packages).toEqual([
      expect.objectContaining({ id: row.id, minutes: 90, price_cents: 15000, pending_payment: false, charge: null }),
    ]);

    data(await call(manager, "delete_hour_package", { client_id: acme.id, hour_package_id: row.id }));
    expect(await db.select().from(hourPurchases).where(eq(hourPurchases.id, row.id))).toHaveLength(0);
  });

  it("refuses bad minutes, cycle or price with the panel's sentences, and collaborators", async () => {
    const zero = await call(owner, "add_hour_package", { client_id: acme.id, minutes: 0, cycle: "2026-11" });
    expect(sentence(zero)).toBe(en.hours.errors.invalidDuration);
    const cycle = await call(owner, "add_hour_package", { client_id: acme.id, minutes: 60, cycle: "2026-13" });
    expect(sentence(cycle)).toBe(en.hours.errors.invalidCycle);
    const price = await call(owner, "add_hour_package", { client_id: acme.id, minutes: 60, cycle: "2026-11", price: "free" });
    expect(sentence(price)).toBe(en.hours.errors.invalidPrice);
    expect(await db.select().from(hourPurchases)).toHaveLength(0);
    expect(sentence(await call(collab, "get_hours", { client_id: acme.id }))).toBe(en.mcp.staffOnly);
  });
});

describe("portal access", () => {
  async function portalLogin(name: string, email: string, clientId: string, active: boolean, role: "admin" | "collaborator" = "admin") {
    const [person] = await db
      .insert(clientUsers)
      .values({ name, email, passwordHash: active ? "hash" : null })
      .returning();
    await db.insert(clientMemberships).values({ clientUserId: person.id, clientId, role });
    return person;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any -- the question's untyped existing_login */
  /** The confirm an app sends back: the login exactly as the question showed it. */
  const shown = (login: Record<string, any>) => ({
    portal_user_id: login.portal_user_id,
    status: login.status,
    will_be_admin: login.will_be_admin,
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it("invites a new e-mail, lists it as invited, resends and cancels — never showing the link", async () => {
    const invited = data(
      await call(owner, "invite_to_portal", { client_id: acme.id, name: "Dora", email: "dora@acme.com", role: "collaborator" }),
    );
    expect(invited).toMatchObject({ ok: true, outcome: "invited", email_sent: true });
    expect(mailed).toHaveBeenCalledTimes(1);

    const access = data(await call(owner, "get_portal_access", { client_id: acme.id }));
    // The company's first login is its admin.
    expect(access.logins).toEqual([
      { id: invited.portal_user_id, name: "Dora", email: "dora@acme.com", role: "admin", status: "invited" },
    ]);

    expect(data(await call(owner, "resend_portal_invite", { client_id: acme.id, portal_user_id: invited.portal_user_id })).email_sent).toBe(
      true,
    );
    data(await call(owner, "cancel_portal_invite", { client_id: acme.id, portal_user_id: invited.portal_user_id }));
    expect(await db.select().from(clientUsers).where(eq(clientUsers.id, invited.portal_user_id))).toHaveLength(0);
    expectNoSecrets();
  });

  it("without e-mail, creates the invite and says no e-mail went out and where to copy the link", async () => {
    mailed.mockResolvedValue({ sent: false });
    const res = await call(manager, "invite_to_portal", { client_id: acme.id, name: "Eva", email: "eva@acme.com", role: "admin" });
    const invited = data(res);
    expect(invited).toMatchObject({ outcome: "invited", email_sent: false, notice: pt.mcp.portalInviteNotEmailed });
    expect(invited.access_url).toBe(`https://agency.test/admin/clients/${acme.id}/access`);
    const [person] = await db.select().from(clientUsers).where(eq(clientUsers.email, "eva@acme.com"));
    expect(person.passwordHash).toBeNull();
    const resent = data(await call(manager, "resend_portal_invite", { client_id: acme.id, portal_user_id: person.id }));
    expect(resent).toMatchObject({ email_sent: false, notice: pt.mcp.portalInviteNotEmailed });
    expect(mailed).toHaveBeenCalledTimes(2);
    expectNoSecrets();
  });

  it("asks before linking an e-mail that is already a login of another company, and links only with the confirm it showed", async () => {
    const [other] = await db.insert(clients).values({ name: "Beta" }).returning();
    const known = await portalLogin("Gil", "gil@beta.com", other.id, true);

    const asked = data(await call(owner, "invite_to_portal", { client_id: acme.id, name: "Gil", email: "gil@beta.com", role: "collaborator" }));
    expect(asked.ok).toBe(false);
    expect(asked.outcome).toBe("confirm");
    expect(asked.question).toBe(en.mcp.portalLinkQuestion);
    expect(asked.existing_login).toMatchObject({
      portal_user_id: known.id,
      name: "Gil",
      status: "active",
      will_be_admin: true,
      companies: [{ name: "Beta", role: "admin" }],
    });
    const before = await db
      .select()
      .from(clientMemberships)
      .where(and(eq(clientMemberships.clientUserId, known.id), eq(clientMemberships.clientId, acme.id)));
    expect(before).toHaveLength(0);

    const linked = data(
      await call(owner, "invite_to_portal", {
        client_id: acme.id,
        name: "Gil",
        email: "gil@beta.com",
        role: "collaborator",
        confirm: shown(asked.existing_login),
      }),
    );
    expect(linked).toMatchObject({ ok: true, outcome: "linked", portal_user_id: known.id, was_pending: false });
    const after = await db
      .select()
      .from(clientMemberships)
      .where(and(eq(clientMemberships.clientUserId, known.id), eq(clientMemberships.clientId, acme.id)));
    expect(after).toHaveLength(1);
    // Linking an active login mails a notice, never an invite link.
    expect(mailed).toHaveBeenCalledTimes(1);
    expectNoSecrets(false);
  });

  it("asks again, linking nothing, when the login changed between the question and the yes", async () => {
    const [other] = await db.insert(clients).values({ name: "Beta" }).returning();
    const known = await portalLogin("Jo", "jo@beta.com", other.id, false);
    const args = { client_id: acme.id, name: "Jo", email: "jo@beta.com", role: "collaborator" };

    const asked = data(await call(owner, "invite_to_portal", args));
    expect(asked.existing_login).toMatchObject({ portal_user_id: known.id, status: "invited" });
    // While the person thinks, the pending login sets its password.
    await db.update(clientUsers).set({ passwordHash: "hash" }).where(eq(clientUsers.id, known.id));

    const again = data(await call(owner, "invite_to_portal", { ...args, confirm: shown(asked.existing_login) }));
    expect(again).toMatchObject({ ok: false, outcome: "confirm", question: en.mcp.portalLinkQuestion });
    expect(again.existing_login).toMatchObject({ portal_user_id: known.id, status: "active" });
    expect(again.warnings).toContain(en.mcp.portalLinkActive);
    const links = await db
      .select()
      .from(clientMemberships)
      .where(and(eq(clientMemberships.clientUserId, known.id), eq(clientMemberships.clientId, acme.id)));
    expect(links).toHaveLength(0);

    // A confirm for another login than the one shown is the question again too.
    const wrong = data(
      await call(owner, "invite_to_portal", { ...args, confirm: { ...shown(again.existing_login), portal_user_id: owner.id } }),
    );
    expect(wrong.outcome).toBe("confirm");
  });

  it("cancel_portal_invite refuses an active login; set_portal_role and remove_from_portal keep one admin", async () => {
    const admin = await portalLogin("Hal", "hal@acme.com", acme.id, true);
    const second = await portalLogin("Ivy", "ivy@acme.com", acme.id, true, "collaborator");

    expect(sentence(await call(owner, "cancel_portal_invite", { client_id: acme.id, portal_user_id: admin.id }))).toBe(
      en.portalUsers.errors.alreadyActive,
    );
    expect(sentence(await call(owner, "set_portal_role", { client_id: acme.id, portal_user_id: admin.id, role: "collaborator" }))).toBe(
      en.portalUsers.errors.lastAdmin,
    );
    data(await call(owner, "set_portal_role", { client_id: acme.id, portal_user_id: second.id, role: "admin" }));
    const removed = data(await call(owner, "remove_from_portal", { client_id: acme.id, portal_user_id: admin.id }));
    expect(removed).toMatchObject({ ok: true, login_deleted: true });
    expect(await db.select().from(clientUsers).where(eq(clientUsers.id, admin.id))).toHaveLength(0);
    expect(sentence(await call(collab, "get_portal_access", { client_id: acme.id }))).toBe(en.mcp.staffOnly);
  });
});

describe("create_client", () => {
  it("creates the client and answers its id and page", async () => {
    const res = data(await call(manager, "create_client", { name: "Nova", email: "Hello@Nova.com" }));
    const [row] = await db.select().from(clients).where(eq(clients.id, res.client.id));
    expect(row).toMatchObject({ name: "Nova", email: "hello@nova.com" });
    expect(res.client.url).toBe(`https://agency.test/admin/clients/${row.id}`);
    const bad = await call(manager, "create_client", { name: "Bad", email: "not-an-email" });
    expect(sentence(bad)).toBe(pt.clients.errors.invalid);
  });
});
