import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientAssignments,
  clients,
  clientUsers,
  hourPurchases,
  messages,
  ticketAssignments,
  tickets,
  timeEntries,
  users,
  type Client,
  type Db,
  type Ticket,
  type User,
} from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { addTimeEntry, getHoursSummary } from "./hours";
import { getTeamHome } from "./team-home";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let owner: TeamSession;
let collab: TeamSession;
let acme: Client;
let beta: Client;
let ticketNumber = 0;
let clock = Date.parse("2026-11-01T12:00:00Z");

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

async function makeUser(name: string, role: User["role"]): Promise<User> {
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
  return u;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en", timeZone: "America/Sao_Paulo" });
  owner = asTeam(await makeUser("Ana", "owner"));
  collab = asTeam(await makeUser("Cy", "collaborator"));
  [acme] = await db.insert(clients).values({ name: "Acme Corp", supportActive: true, hoursMode: "package", includedMinutes: 60 }).returning();
  [beta] = await db.insert(clients).values({ name: "Beta Ltd", supportActive: true, hoursMode: "internal" }).returning();
  await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
  ticketNumber = 0;
  clock = Date.parse("2026-11-01T12:00:00Z");
});

afterAll(async () => {
  await db?.$client.end();
});

/** A ticket opened by the agency or a client, each one a minute after the previous one. */
async function makeTicket(client: Client, title: string, values: Partial<typeof tickets.$inferInsert> = {}): Promise<Ticket> {
  ticketNumber += 1;
  clock += 60_000;
  const [t] = await db
    .insert(tickets)
    .values({
      number: ticketNumber,
      clientId: client.id,
      type: "support",
      title,
      createdByType: "agency",
      createdById: owner.user.id,
      createdAt: new Date(clock),
      ...values,
    })
    .returning();
  return t;
}

async function write(ticket: Ticket, author: { type: "agency" | "client"; id: string }) {
  clock += 60_000;
  const at = new Date(clock);
  await db.insert(messages).values({
    ticketId: ticket.id,
    authorType: author.type,
    authorId: author.id,
    bodyHtml: "<p>hi</p>",
    bodyText: "hi",
    createdAt: at,
  });
  await db.update(tickets).set({ lastMessageAt: at }).where(eq(tickets.id, ticket.id));
}

const assign = (ticket: Ticket, user: TeamSession) => db.insert(ticketAssignments).values({ ticketId: ticket.id, userId: user.user.id });

describe("getTeamHome", () => {
  it("a collaborator's home only counts and lists the tickets they can see", async () => {
    const [person] = await db.insert(clientUsers).values({ name: "Paula", email: "paula@acme.com" }).returning();
    const unassignedAcme = await makeTicket(acme, "Acme nobody took");
    await makeTicket(beta, "Beta nobody took");
    const answered = await makeTicket(acme, "Acme client answered");
    await assign(answered, collab);
    await write(answered, { type: "agency", id: collab.user.id });
    await write(answered, { type: "client", id: person.id });
    const waiting = await makeTicket(acme, "Acme waiting for the client");
    await assign(waiting, collab);
    await write(waiting, { type: "agency", id: collab.user.id });
    const betaMine = await makeTicket(beta, "Beta answered, assigned to Cy");
    await assign(betaMine, collab);
    await write(betaMine, { type: "client", id: person.id });
    await makeTicket(acme, "Acme closed", { status: "closed", closedAt: new Date(clock) });

    const home = await getTeamHome(collab, new Date(clock), { db });
    expect(home.needsYou.map((r) => r.ticket.title)).toEqual(["Acme client answered", "Acme nobody took"]);
    expect(home.needsYouTotal).toBe(2);
    expect(home.needsYou[0].lastAuthorName).toBe("Paula");
    expect(home.needsYou[1].lastAuthorName).toBeNull();
    expect(home.needsYou[1].ticket.id).toBe(unassignedAcme.id);
    expect(home.figures).toEqual({ role: "collaborator", myOpenTickets: 2, unassigned: 1, myClients: 1 });
    expect(home.recent.map((r) => r.ticket.title)).toEqual([
      "Acme closed",
      "Acme waiting for the client",
      "Acme client answered",
      "Acme nobody took",
    ]);

    // The owner sees Beta too; the ticket assigned to Cy is not the owner's to answer.
    const staff = await getTeamHome(owner, new Date(clock), { db });
    expect(staff.needsYou.map((r) => r.ticket.title)).toEqual(["Beta nobody took", "Acme nobody took"]);
    expect(staff.figures).toMatchObject({ role: "staff", openTickets: 5, clientsWithSupport: 2 });
    expect(staff.recent).toHaveLength(6);
  });

  it("an entry logged at 23:30 on 31 January in São Paulo counts in January, not February", async () => {
    const ticket = await makeTicket(acme, "Support");
    // 23:30 on 31 January in São Paulo is already 1 February in UTC.
    const lateJanuary = new Date("2026-02-01T02:30:00Z");
    const logged = await addTimeEntry(owner, ticket.id, { duration: "90" }, { db, now: () => lateJanuary });
    expect(logged.ok).toBe(true);
    const [entry] = await db.select().from(timeEntries);
    expect(entry.workedOn).toBe("2026-01-31");

    const january = await getTeamHome(owner, lateJanuary, { db });
    expect(january.figures).toMatchObject({ role: "staff", minutesUsedThisMonth: 90, negativeBalances: 1 });
    const february = await getTeamHome(owner, new Date("2026-02-01T12:00:00Z"), { db });
    expect(february.figures).toMatchObject({ role: "staff", minutesUsedThisMonth: 0, negativeBalances: 0 });
  });

  it("the month's figures agree with each client's hours summary", async () => {
    const now = new Date("2026-11-20T15:00:00Z");
    const acmeTicket = await makeTicket(acme, "Acme support");
    const betaTicket = await makeTicket(beta, "Beta support");
    const single = await makeTicket(acme, "Acme single", { type: "single" });
    const [offClient] = await db.insert(clients).values({ name: "Gamma", supportActive: true }).returning();
    const offTicket = await makeTicket(offClient, "Gamma support");
    for (const [t, minutes, workedOn] of [
      [acmeTicket, 50, "2026-11-03"],
      [acmeTicket, 30, "2026-11-19"],
      [acmeTicket, 500, "2026-10-31"],
      [single, 200, "2026-11-04"],
      [betaTicket, 45, "2026-11-10"],
      [offTicket, 15, "2026-11-10"],
    ] as const) {
      await db.insert(timeEntries).values({ ticketId: t.id, clientId: t.clientId, minutes, workedOn, createdById: owner.user.id });
    }
    // Acme: 60 included + 30 paid = 90, 80 used: positive. A pending purchase does not count.
    await db.insert(hourPurchases).values([
      { clientId: acme.id, minutes: 30, cycle: "2026-11" },
      { clientId: acme.id, minutes: 600, cycle: "2026-11", pending: true },
    ]);

    let home = await getTeamHome(owner, now, { db });
    expect(home.figures).toEqual({
      role: "staff",
      openTickets: 4,
      clientsWithSupport: 3,
      minutesUsedThisMonth: 80 + 45,
      negativeBalances: 0,
    });
    const acmeHours = await getHoursSummary(acme.id, undefined, { db, now: () => now });
    expect(acmeHours?.balanceMinutes).toBe(10);

    await db.insert(timeEntries).values({ ticketId: acmeTicket.id, clientId: acme.id, minutes: 11, workedOn: "2026-11-20" });
    home = await getTeamHome(owner, now, { db });
    expect(home.figures).toMatchObject({ minutesUsedThisMonth: 136, negativeBalances: 1 });
    expect((await getHoursSummary(acme.id, undefined, { db, now: () => now }))?.balanceMinutes).toBe(-1);
  });
});
