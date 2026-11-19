import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { todayInCycleZone } from "@/lib/hours";
import { DEFAULT_TIME_ZONE } from "@/lib/time-zone";
import { agency, clientMemberships, clientUsers, clients, sites, tickets, timeEntries, users, type Client, type ClientRole, type ClientUser } from "@/lib/db";
import {
  PORTAL_COOKIE,
  createSession,
  resolvePortalSession,
  switchActiveCompany,
  type CookieStore,
  type PortalSession,
} from "@/lib/auth/session";
import { postMessage } from "./messages";
import { getPortalHome } from "./portal-home";
import { openPortalTicket } from "./tickets";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let A: Client;
let B: Client;
let person: ClientUser;

function fakeStore(): CookieStore {
  const jar = new Map<string, string>();
  return {
    get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name, value) => void jar.set(name, value),
    delete: (name) => void jar.delete(name),
  };
}

const asPortal = (client: Client, role: ClientRole): PortalSession => ({ userType: "client", user: person, client, role });

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  [A, B] = await db
    .insert(clients)
    .values([
      { name: "Alpha", supportActive: true, supportMonthlyCents: 150_000, generalTicketsEnabled: true },
      { name: "Beta" },
    ])
    .returning();
  [person] = await db.insert(clientUsers).values({ name: "Pat", email: "pat@x.com", passwordHash: "x" }).returning();
  await db.insert(clientMemberships).values([
    { clientUserId: person.id, clientId: A.id, role: "admin" },
    { clientUserId: person.id, clientId: B.id, role: "collaborator" },
  ]);
  await db.insert(sites).values([
    { clientId: A.id, name: "zeta.com", includedInSupport: true },
    { clientId: A.id, name: "alpha.com", url: "https://alpha.com", includedInSupport: true },
    { clientId: A.id, name: "loose.com", includedInSupport: false },
    { clientId: B.id, name: "beta.com", includedInSupport: false },
  ]);
});

afterAll(async () => {
  await db?.$client.end();
});

describe("getPortalHome", () => {
  it("only returns the active company's sites", async () => {
    const store = fakeStore();
    await createSession("client", person.id, { store, db, secure: false });
    const token = store.get(PORTAL_COOKIE)!.value;

    const inA = await resolvePortalSession(token, db);
    expect(inA?.client.id).toBe(A.id);
    const homeA = await getPortalHome(inA!, db);
    expect(homeA.sites.map((s) => s.name)).toEqual(["alpha.com", "loose.com", "zeta.com"]);

    expect(await switchActiveCompany(B.id, { store, db })).toEqual({ ok: true, value: undefined });
    const inB = await resolvePortalSession(token, db);
    expect(inB?.client.id).toBe(B.id);
    const homeB = await getPortalHome(inB!, db);
    expect(homeB.sites.map((s) => s.name)).toEqual(["beta.com"]);
  });

  it("shows the monthly value to admins only", async () => {
    const admin = await getPortalHome(asPortal(A, "admin"), db);
    expect(admin.monthlyCents).toBe(150_000);
    expect(admin.supportActive).toBe(true);
    expect(admin.generalTickets).toBe(true);
    const collaborator = await getPortalHome(asPortal(A, "collaborator"), db);
    expect(collaborator.monthlyCents).toBeNull();
    expect(collaborator.supportActive).toBe(true);
  });

  it("counts only the sites included in support", async () => {
    expect((await getPortalHome(asPortal(A, "admin"), db)).coveredCount).toBe(2);
    expect((await getPortalHome(asPortal(B, "admin"), db)).coveredCount).toBe(0);
  });

  it("reads the plan from the database, not from a stale session snapshot", async () => {
    await db.update(clients).set({ supportActive: false, supportMonthlyCents: null }).where(eq(clients.id, A.id));
    const home = await getPortalHome(asPortal(A, "admin"), db);
    expect(home.supportActive).toBe(false);
    expect(home.monthlyCents).toBeNull();
  });
});

describe("getPortalHome tickets", () => {
  const open = async (client: Client, title: string) => {
    const res = await openPortalTicket(asPortal(client, "admin"), { title, bodyHtml: "<p>Hi</p>" }, { db });
    if (!res.ok) throw new Error(res.error);
    return res.value.ticketId;
  };

  it("awaiting holds only open tickets on the client's turn, of the active company", async () => {
    await db.update(clients).set({ supportActive: true, generalTicketsEnabled: true }).where(eq(clients.id, B.id));
    const [team] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner" }).returning();
    const asTeam = { userType: "agency" as const, user: team };
    const waiting = await open(A, "Team answered");
    await postMessage(asTeam, waiting, { bodyHtml: "<p>Please check</p>" }, { db });
    await open(A, "Agency has it");
    const closed = await open(A, "Closed one");
    await postMessage(asTeam, closed, { bodyHtml: "<p>Done</p>" }, { db });
    await db.update(tickets).set({ status: "closed", closedAt: new Date() }).where(eq(tickets.id, closed));
    const other = await open(B, "Other company");
    await postMessage(asTeam, other, { bodyHtml: "<p>Other</p>" }, { db });

    const home = await getPortalHome(asPortal(A, "admin"), db);
    expect(home.awaiting.map((t) => t.title)).toEqual(["Team answered"]);
    expect(home.awaiting[0].turn).toBe("client");
    expect(home.recent.map((t) => t.title).sort()).toEqual(["Agency has it", "Closed one", "Team answered"]);
  });

  it("recent holds at most 5, newest activity first", async () => {
    for (let i = 1; i <= 7; i++) await open(A, `T${i}`);
    const home = await getPortalHome(asPortal(A, "admin"), db);
    expect(home.recent).toHaveLength(5);
    expect(home.recent.map((t) => t.title)).toEqual(["T7", "T6", "T5", "T4", "T3"]);
  });
});

describe("getPortalHome query size", () => {
  /** Wraps `db.select` so every awaited query reports how many rows it returned. */
  function countRows(target: Db): { rows: () => number[]; restore: () => void } {
    const seen: number[] = [];
    const real = target.select.bind(target);
    const wrap = (builder: object): object =>
      new Proxy(builder, {
        get(obj, prop, receiver) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              (obj as PromiseLike<unknown[]>).then((r) => {
                if (Array.isArray(r)) seen.push(r.length);
                return resolve(r);
              }, reject);
          }
          const value = Reflect.get(obj, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const out = value.apply(obj, args);
            return out && typeof out === "object" ? wrap(out) : out;
          };
        },
      });
    const spy = vi.spyOn(target, "select").mockImplementation(((...args: unknown[]) =>
      wrap((real as (...a: unknown[]) => object)(...args))) as never);
    return { rows: () => seen, restore: () => spy.mockRestore() };
  }

  it("portal home reads a bounded number of tickets", async () => {
    const [team] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner" }).returning();
    const asTeam = { userType: "agency" as const, user: team };
    const open = async (title: string) => {
      const res = await openPortalTicket(asPortal(A, "admin"), { title, bodyHtml: "<p>Hi</p>" }, { db });
      if (!res.ok) throw new Error(res.error);
      return res.value.ticketId;
    };
    // The 3 oldest tickets are answered by the team (client's turn); 57 newer ones wait on the team.
    const oldest: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const id = await open(`Old ${i}`);
      await postMessage(asTeam, id, { bodyHtml: "<p>Reply</p>" }, { db });
      oldest.push(id);
    }
    for (let i = 1; i <= 57; i++) await open(`New ${i}`);

    const counter = countRows(db);
    let home;
    try {
      home = await getPortalHome(asPortal(A, "admin"), db);
    } finally {
      counter.restore();
    }
    expect(home.awaiting.map((t) => t.id).sort()).toEqual([...oldest].sort());
    expect(home.recent).toHaveLength(5);
    expect(home.recent.map((t) => t.title)).toEqual(["New 57", "New 56", "New 55", "New 54", "New 53"]);
    // Two limited ticket queries: never the 60 tickets of the company.
    expect(Math.max(...counter.rows())).toBeLessThanOrEqual(5 + 3 + 3);
    expect(counter.rows().filter((n) => n > 5).length).toBeLessThanOrEqual(1);
  });
});

describe("getPortalHome hours", () => {
  const log = async (client: Client, minutes: number, type: "support" | "single" = "support") => {
    const [ticket] = await db
      .insert(tickets)
      .values({ clientId: client.id, number: Math.floor(Math.random() * 1e6), title: "T", type, createdByType: "client", createdById: person.id })
      .returning({ id: tickets.id });
    const day = todayInCycleZone(new Date(), DEFAULT_TIME_ZONE);
    await db.insert(timeEntries).values({ ticketId: ticket.id, clientId: client.id, minutes, workedOn: day, note: "secret note" });
  };

  it("portal home has no hours for internal or off clients", async () => {
    await log(A, 30);
    expect((await getPortalHome(asPortal(A, "admin"), db)).hours).toBeNull();
    await db.update(clients).set({ hoursMode: "internal" }).where(eq(clients.id, A.id));
    expect((await getPortalHome(asPortal(A, "admin"), db)).hours).toBeNull();
    expect((await getPortalHome(asPortal(A, "collaborator"), db)).hours).toBeNull();
  });

  it("portal home shows the package balance of the session company", async () => {
    await db.update(clients).set({ supportActive: true, hoursMode: "package", includedMinutes: 600 }).where(eq(clients.id, A.id));
    await log(A, 90);
    const home = await getPortalHome(asPortal(A, "admin"), db);
    expect(home.hours).toMatchObject({ includedMinutes: 600, purchasedMinutes: 0, usedMinutes: 90, balanceMinutes: 510 });
    expect(Object.keys(home.hours!).sort()).toEqual(["balanceMinutes", "cycle", "includedMinutes", "purchasedMinutes", "usedMinutes"]);
    const collaborator = await getPortalHome(asPortal(A, "collaborator"), db);
    expect(collaborator.hours).toEqual(home.hours);
    await log(A, 600);
    expect((await getPortalHome(asPortal(A, "admin"), db)).hours!.balanceMinutes).toBe(-90);
  });

  it("portal hours are always the session company's", async () => {
    await db.update(clients).set({ supportActive: true, hoursMode: "package", includedMinutes: 600 }).where(eq(clients.id, A.id));
    await db.update(clients).set({ supportActive: true, hoursMode: "package", includedMinutes: 120 }).where(eq(clients.id, B.id));
    await log(A, 100);
    await log(B, 20);
    const a = await getPortalHome(asPortal(A, "admin"), db);
    const b = await getPortalHome(asPortal(B, "admin"), db);
    expect(a.hours).toMatchObject({ includedMinutes: 600, usedMinutes: 100 });
    expect(b.hours).toMatchObject({ includedMinutes: 120, usedMinutes: 20 });
  });

  it("an agency in Tokyo shows February's balance at 08:00 on 1 February there (still 31 January in São Paulo)", async () => {
    await db.update(agency).set({ timeZone: "Asia/Tokyo" }).where(eq(agency.id, 1));
    await db.update(clients).set({ supportActive: true, hoursMode: "package", includedMinutes: 600 }).where(eq(clients.id, A.id));
    const [ticket] = await db
      .insert(tickets)
      .values({ clientId: A.id, number: 1, title: "T", type: "support", createdByType: "client", createdById: person.id })
      .returning({ id: tickets.id });
    await db.insert(timeEntries).values([
      { ticketId: ticket.id, clientId: A.id, minutes: 60, workedOn: "2026-02-01" },
      { ticketId: ticket.id, clientId: A.id, minutes: 45, workedOn: "2026-01-31" },
    ]);
    const now = () => new Date("2026-01-31T23:00:00Z");
    const home = await getPortalHome(asPortal(A, "admin"), db, { now });
    expect(home.hours).toMatchObject({ cycle: "2026-02", usedMinutes: 60, balanceMinutes: 540 });
  });
});
