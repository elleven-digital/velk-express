import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { resetTestDb } from "@/test/db";
import { agency, clients, labels, ticketLabels, users, type Db, type User } from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { changeRole, removeMember } from "@/lib/core/team";
import { createTicket } from "@/lib/core/tickets";
import { en } from "@/lib/i18n/en";
import { pt } from "@/lib/i18n/pt";
import { actorForUser } from "./context";
import { buildServer } from "./server";
import { teamTool, toolData, type ToolScope } from "./tools";

// The cores and the connector read the app database: point it at the test one.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://agency.test";

let db: Db;
let owner: User;
let secondOwner: User;
let manager: User;
let collab: User;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

async function makeUser(name: string, role: User["role"], locale: string | null = null): Promise<User> {
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role, locale }).returning();
  return u;
}

const scopeOf = (user: User, rateLimited = false): ToolScope => ({
  userId: user.id,
  connectionId: "00000000-0000-4000-8000-000000000001",
  clientId: "https://app.test/client.json",
  clientName: "Test app",
  rateLimited,
});

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };

const PROTOCOL = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "velk-int", version: "1.0.0" },
};

/**
 * Calls a tool through the real MCP handler on the server built for `scope`, plus a test-only
 * owner-gated tool (no owner-only tool exists yet in this set).
 */
async function call(scope: ToolScope, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const handler = createMcpHandler(
    () => {
      const server = buildServer(scope);
      server.registerTool(
        "owner_probe",
        { description: "Test only.", annotations: { readOnlyHint: true } },
        teamTool(scope, "owner_probe", "owner", async (actor) => toolData({ ran_as: actor.user.id })),
      );
      return server;
    },
    { responseMode: "json" },
  );
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
  secondOwner = await makeUser("Bia", "owner");
  manager = await makeUser("Beto", "manager", "pt");
  collab = await makeUser("Cy", "collaborator");
});

afterAll(async () => {
  await db?.$client.end();
});

describe("actorForUser", () => {
  it("re-reads the person as a team session, or null once removed", async () => {
    expect(await actorForUser(collab.id)).toEqual({ userType: "agency", user: collab });
    expect((await removeMember(asTeam(owner), collab.id, { db })).ok).toBe(true);
    expect(await actorForUser(collab.id)).toBeNull();
  });
});

describe("gates", () => {
  it("refuses an owner tool to a manager in the manager's language", async () => {
    const result = await call(scopeOf(manager), "owner_probe");
    expect(result.isError).toBe(true);
    expect(sentence(result)).toBe(pt.mcp.ownerOnly);
  });

  it("applies a demotion on the very next call, while member tools keep working", async () => {
    expect((await call(scopeOf(secondOwner), "owner_probe")).structuredContent).toEqual({ ran_as: secondOwner.id });
    expect((await changeRole(asTeam(owner), secondOwner.id, "collaborator", { db })).ok).toBe(true);

    const refusedNow = await call(scopeOf(secondOwner), "owner_probe");
    expect(refusedNow.isError).toBe(true);
    expect(sentence(refusedNow)).toBe(en.mcp.ownerOnly);
    const listed = await call(scopeOf(secondOwner), "list_labels");
    expect(listed.isError).toBeUndefined();
    expect(listed.structuredContent).toEqual({ labels: [] });
  });

  it("answers the no-access sentence to a person removed from the team", async () => {
    expect((await removeMember(asTeam(owner), collab.id, { db })).ok).toBe(true);
    const result = await call(scopeOf(collab), "list_labels");
    expect(result.isError).toBe(true);
    expect(sentence(result)).toBe(en.mcp.noAccess);
  });

  it("answers the limit sentence over the rate limit", async () => {
    const result = await call(scopeOf(owner, true), "get_agency");
    expect(result.isError).toBe(true);
    expect(sentence(result)).toBe(en.mcp.rateLimited);
  });
});

describe("get_agency", () => {
  it("tells staff who they are, the agency and which providers are on", async () => {
    const data = (await call(scopeOf(manager), "get_agency")).structuredContent!;
    expect(data).toEqual({
      you: { id: manager.id, name: "Beto", email: "beto@x.com", role: "manager", locale: "pt" },
      agency: {
        name: "Studio Acme",
        locale: "en",
        currency: "BRL",
        time_zone: "America/Sao_Paulo",
        panel_url: "https://agency.test/admin",
      },
      collaborator_visibility: { client_scope: "all", ticket_scope: "all", sees_unassigned: true },
      payment_providers: { stripe: expect.any(Boolean), mercadopago: expect.any(Boolean) },
    });
  });

  it("leaves the payment providers out for collaborators", async () => {
    const data = (await call(scopeOf(collab), "get_agency")).structuredContent!;
    expect(data.you).toMatchObject({ id: collab.id, role: "collaborator", locale: null });
    expect(data).not.toHaveProperty("payment_providers");
    expect(data.collaborator_visibility).toEqual({ client_scope: "all", ticket_scope: "all", sees_unassigned: true });
  });
});

describe("label tools", () => {
  it("lets staff create, rename and delete labels, and refuses collaborators", async () => {
    const created = await call(scopeOf(manager), "create_label", { name: "  Waiting   art ", color: "blue" });
    expect(created.structuredContent).toEqual({
      ok: true,
      label: { id: expect.any(String), name: "Waiting art", color: "#0a72ef" },
    });
    const labelId = (created.structuredContent!.label as { id: string }).id;

    const taken = await call(scopeOf(owner), "create_label", { name: "waiting ART" });
    expect(taken.isError).toBe(true);
    expect(sentence(taken)).toBe(en.settings.errors.labelTaken);
    const badColor = await call(scopeOf(manager), "update_label", { label_id: labelId, color: "nope" });
    expect(sentence(badColor)).toBe(pt.settings.errors.labelColorInvalid);

    const renamed = await call(scopeOf(owner), "update_label", { label_id: labelId, name: "Waiting client" });
    expect(renamed.structuredContent).toEqual({ ok: true, label: { id: labelId, name: "Waiting client", color: "#0a72ef" } });

    const collabCreate = await call(scopeOf(collab), "create_label", { name: "Mine" });
    expect(sentence(collabCreate)).toBe(en.mcp.staffOnly);

    expect((await call(scopeOf(owner), "delete_label", { label_id: labelId })).structuredContent).toEqual({ ok: true, label_id: labelId });
    expect(await db.select().from(labels)).toEqual([]);
    expect(sentence(await call(scopeOf(owner), "delete_label", { label_id: labelId }))).toBe(en.settings.errors.notFound);
  });

  it("lets any member apply and remove a label on a ticket they see, listed with its count", async () => {
    const [acme] = await db.insert(clients).values({ name: "Acme", supportActive: true, generalTicketsEnabled: true }).returning();
    const ticket = await createTicket(asTeam(owner), { clientId: acme.id, type: "support", title: "Banner", bodyHtml: "<p>Hi</p>" }, { db });
    if (!ticket.ok) throw new Error(ticket.error);
    const ticketId = ticket.value.ticketId;
    const [label] = await db.insert(labels).values({ name: "Urgent", color: "#e5484d" }).returning();

    const added = await call(scopeOf(collab), "add_ticket_label", { ticket_id: ticketId, label_id: label.id });
    expect(added.structuredContent).toEqual({ ok: true, ticket_id: ticketId, label_id: label.id });
    const listed = await call(scopeOf(collab), "list_labels");
    expect(listed.structuredContent).toEqual({
      labels: [{ id: label.id, name: "Urgent", color: "#e5484d", tickets: 1, created_at: label.createdAt.toISOString() }],
    });

    const missing = await call(scopeOf(collab), "add_ticket_label", { ticket_id: ticketId, label_id: "not-a-uuid" });
    expect(sentence(missing)).toBe(en.tickets.errors.notFound);

    expect((await call(scopeOf(collab), "remove_ticket_label", { ticket_id: ticketId, label_id: label.id })).isError).toBeUndefined();
    expect(await db.select().from(ticketLabels).where(eq(ticketLabels.labelId, label.id))).toEqual([]);
  });
});
