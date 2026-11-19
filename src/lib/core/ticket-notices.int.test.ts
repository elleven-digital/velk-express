import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientUsers,
  clients,
  sites,
  ticketAssignments,
  tickets,
  users,
  type Db,
  type User,
} from "@/lib/db";
import { sendMail, type MailMessage } from "@/lib/mail/send";
import { notifyTicketOpened } from "./ticket-notices";

// getConfig() is lazy: a database URL, a fixed public address and no SMTP.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";
delete process.env.SMTP_HOST;
delete process.env.MAIL_FROM;

let db: Db;
let sent: MailMessage[];
let send: typeof sendMail;
let clientId: string;
let personId: string;

async function makeUser(name: string, role: User["role"], opts: { password?: boolean; locale?: string } = {}): Promise<User> {
  const [u] = await db
    .insert(users)
    .values({
      name,
      email: `${name.toLowerCase()}@x.com`,
      role,
      locale: opts.locale ?? null,
      passwordHash: opts.password === false ? null : "hash",
    })
    .returning();
  return u;
}

async function makeTicket(opts: { by?: "client" | "agency"; siteId?: string | null; title?: string } = {}): Promise<string> {
  const [t] = await db
    .insert(tickets)
    .values({
      number: Math.floor(Math.random() * 1_000_000),
      clientId,
      siteId: opts.siteId ?? null,
      type: "support",
      title: opts.title ?? "Broken <b>form</b>",
      createdByType: opts.by ?? "client",
      createdById: personId,
    })
    .returning({ id: tickets.id });
  return t.id;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  const [c] = await db.insert(clients).values({ name: "Acme" }).returning();
  clientId = c.id;
  const [p] = await db.insert(clientUsers).values({ name: "Paula", email: "paula@acme.test" }).returning();
  personId = p.id;
  sent = [];
  send = vi.fn(async (m: MailMessage) => {
    sent.push(m);
    return { sent: true };
  }) as unknown as typeof sendMail;
});

afterAll(async () => {
  await db?.$client.end();
});

describe("notifyTicketOpened", () => {
  it("mails only the assignee, in their own language", async () => {
    const owner = await makeUser("Ana", "owner");
    const a = await makeUser("Cy", "collaborator", { locale: "pt" });
    await makeUser("Dai", "collaborator");
    const id = await makeTicket();
    await db.insert(ticketAssignments).values({ ticketId: id, userId: a.id });
    const res = await notifyTicketOpened(id, { db, send });
    expect(res).toEqual({ recipients: 1, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("cy@x.com");
    expect(sent[0].subject).toMatch(/^Novo chamado: #\d+ /);
    expect(sent[0].text).toContain("Paula abriu um chamado em Geral.");
    expect(sent[0].html).toContain(`https://painel.acme.com/admin/tickets/${id}`);
    expect(sent[0].html).not.toContain("<b>form</b>");
    expect(owner.id).toBeTruthy();
  });

  it("falls back to the agency language, then names the site", async () => {
    await db.update(agency).set({ locale: "es" });
    const a = await makeUser("Cy", "collaborator");
    const [site] = await db.insert(sites).values({ clientId, name: "acme.test" }).returning();
    const id = await makeTicket({ siteId: site.id });
    await db.insert(ticketAssignments).values({ ticketId: id, userId: a.id });
    await notifyTicketOpened(id, { db, send });
    expect(sent[0].text).toContain("Paula abrió un ticket en acme.test.");
  });

  it("without an assignee goes to the owner and managers with a password, not collaborators or pending invites", async () => {
    await makeUser("Ana", "owner");
    await makeUser("Beto", "manager");
    await makeUser("Cy", "collaborator");
    await makeUser("Eva", "manager", { password: false });
    const id = await makeTicket();
    const res = await notifyTicketOpened(id, { db, send });
    expect(res).toEqual({ recipients: 2, sent: 2 });
    expect(sent.map((m) => m.to).sort()).toEqual(["ana@x.com", "beto@x.com"]);
  });

  it("falls back to the owner and managers when every assignee is a pending invite", async () => {
    await makeUser("Ana", "owner");
    await makeUser("Beto", "manager");
    await makeUser("Cy", "collaborator");
    const pending = await makeUser("Dai", "collaborator", { password: false });
    const id = await makeTicket();
    await db.insert(ticketAssignments).values({ ticketId: id, userId: pending.id });
    const res = await notifyTicketOpened(id, { db, send });
    expect(res).toEqual({ recipients: 2, sent: 2 });
    expect(sent.map((m) => m.to).sort()).toEqual(["ana@x.com", "beto@x.com"]);
  });

  it("keeps to the assignees who can sign in when some are pending", async () => {
    await makeUser("Ana", "owner");
    const ok = await makeUser("Cy", "collaborator");
    const pending = await makeUser("Dai", "collaborator", { password: false });
    const id = await makeTicket();
    await db.insert(ticketAssignments).values([
      { ticketId: id, userId: ok.id },
      { ticketId: id, userId: pending.id },
    ]);
    expect(await notifyTicketOpened(id, { db, send })).toEqual({ recipients: 1, sent: 1 });
    expect(sent[0].to).toBe("cy@x.com");
  });

  it("does not notify when the team opened the ticket", async () => {
    await makeUser("Ana", "owner");
    const id = await makeTicket({ by: "agency" });
    expect(await notifyTicketOpened(id, { db, send })).toEqual({ recipients: 0, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("never throws when the sender rejects", async () => {
    await makeUser("Ana", "owner");
    const id = await makeTicket();
    const failing = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof sendMail;
    expect(await notifyTicketOpened(id, { db, send: failing })).toEqual({ recipients: 1, sent: 0 });
  });

  it("sends nothing without SMTP", async () => {
    await makeUser("Ana", "owner");
    const id = await makeTicket();
    expect(await notifyTicketOpened(id, { db })).toEqual({ recipients: 1, sent: 0 });
  });

  it("returns zero for an unknown ticket", async () => {
    expect(await notifyTicketOpened("00000000-0000-4000-8000-000000000000", { db, send })).toEqual({ recipients: 0, sent: 0 });
  });
});
