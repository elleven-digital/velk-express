import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { agency, clientAssignments, clients, hourPurchases, tickets, timeEntries, users, type Client, type User } from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { addHourPurchase, addTimeEntry, deleteHourPurchase, deleteTimeEntry, getClientHoursCycle, getHoursSummary, listTicketTime } from "./hours";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let A: Client;
let B: Client;
let userId: string;
let n = 0;

async function ticket(clientId: string, type: "single" | "support") {
  const [t] = await db
    .insert(tickets)
    .values({ number: ++n, clientId, type, title: "T", createdByType: "agency", createdById: userId })
    .returning();
  return t;
}

const entry = (t: { id: string; clientId: string }, minutes: number, workedOn: string) =>
  ({ ticketId: t.id, clientId: t.clientId, minutes, workedOn });

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  n = 0;
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  [A, B] = await db
    .insert(clients)
    .values([
      { name: "Alpha", supportActive: true, hoursMode: "package", includedMinutes: 600 },
      { name: "Beta", supportActive: true, hoursMode: "package", includedMinutes: 300 },
    ])
    .returning();
  [{ id: userId }] = await db
    .insert(users)
    .values({ name: "Ana", email: "ana@x.com", passwordHash: "x", role: "owner" })
    .returning({ id: users.id });
});

afterAll(async () => {
  await db?.$client.end();
});

describe("getHoursSummary", () => {
  it("counts support entries of the cycle, non-pending purchases of the cycle and package minutes only", async () => {
    const support = await ticket(A.id, "support");
    const single = await ticket(A.id, "single");
    const other = await ticket(B.id, "support");
    await db.insert(timeEntries).values([
      entry(support, 60, "2026-11-01"),
      entry(support, 90, "2026-11-30"),
      entry(support, 45, "2026-10-31"), // other cycle
      entry(support, 45, "2026-12-01"), // other cycle
      entry(single, 120, "2026-11-10"), // single ticket: outside the package
      entry(other, 200, "2026-11-10"), // other client
    ]);
    await db.insert(hourPurchases).values([
      { clientId: A.id, minutes: 120, cycle: "2026-11" },
      { clientId: A.id, minutes: 30, cycle: "2026-11", pending: true },
      { clientId: A.id, minutes: 500, cycle: "2026-10" },
      { clientId: B.id, minutes: 400, cycle: "2026-11" },
    ]);

    expect(await getHoursSummary(A.id, "2026-11", { db })).toEqual({
      cycle: "2026-11",
      mode: "package",
      includedMinutes: 600,
      purchasedMinutes: 120,
      usedMinutes: 150,
      balanceMinutes: 570,
    });
  });

  it("defaults to the cycle of now and can go negative", async () => {
    const support = await ticket(A.id, "support");
    await db.insert(timeEntries).values(entry(support, 700, "2026-11-30"));
    const summary = await getHoursSummary(A.id, undefined, { db, now: () => new Date("2026-12-01T01:00:00Z") });
    expect(summary?.cycle).toBe("2026-11");
    expect(summary?.balanceMinutes).toBe(-100);
  });

  it("internal and off clients have zero included minutes", async () => {
    const [internal, off] = await db
      .insert(clients)
      .values([
        { name: "Gamma", supportActive: true, hoursMode: "internal" },
        { name: "Delta", hoursMode: "off" },
      ])
      .returning();
    const t = await ticket(internal.id, "support");
    await db.insert(timeEntries).values(entry(t, 30, "2026-11-05"));

    const a = await getHoursSummary(internal.id, "2026-11", { db });
    expect(a).toMatchObject({ mode: "internal", includedMinutes: 0, usedMinutes: 30, balanceMinutes: -30 });
    const b = await getHoursSummary(off.id, "2026-11", { db });
    expect(b).toMatchObject({ mode: "off", includedMinutes: 0, usedMinutes: 0, balanceMinutes: 0 });
  });

  it("is null for a client that does not exist", async () => {
    expect(await getHoursSummary("00000000-0000-0000-0000-000000000000", "2026-11", { db })).toBeNull();
  });
});

describe("time entries", () => {
  const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
  async function member(name: string, role: User["role"]) {
    const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
    return asTeam(u);
  }
  const noon = () => new Date("2026-11-18T15:00:00Z");

  it("addTimeEntry stores minutes, day and note with the ticket's client", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const t = await ticket(B.id, "support");
    const res = await addTimeEntry(owner, t.id, { duration: "1h30", workedOn: "2026-11-17", note: "  Fixed the menu  " }, { db, now: noon });
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(timeEntries);
    expect(row).toMatchObject({ ticketId: t.id, clientId: B.id, minutes: 90, workedOn: "2026-11-17", note: "Fixed the menu", createdById: owner.user.id });
    // no day: today in the cycle zone
    await addTimeEntry(owner, t.id, { duration: "30" }, { db, now: noon });
    const days = (await db.select().from(timeEntries)).map((r) => r.workedOn).sort();
    expect(days).toEqual(["2026-11-17", "2026-11-18"]);
  });

  it("addTimeEntry refuses a date after today in the cycle zone", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const t = await ticket(A.id, "support");
    // 01:00 UTC on 30/11 is still 29/11 in Sao Paulo
    const now = () => new Date("2026-11-30T01:00:00Z");
    expect(await addTimeEntry(owner, t.id, { duration: "1h", workedOn: "2026-11-30" }, { db, now })).toEqual({ ok: false, error: "futureDate" });
    expect((await addTimeEntry(owner, t.id, { duration: "1h", workedOn: "2026-11-29" }, { db, now })).ok).toBe(true);
    expect(await db.select().from(timeEntries)).toHaveLength(1);
  });

  it("addTimeEntry limits the note to 500 characters", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const t = await ticket(A.id, "support");
    expect(await addTimeEntry(owner, t.id, { duration: "1h", note: "a".repeat(501) }, { db, now: noon })).toEqual({ ok: false, error: "tooLong" });
    expect(await db.select().from(timeEntries)).toEqual([]);
    expect((await addTimeEntry(owner, t.id, { duration: "1h", note: "a".repeat(500) }, { db, now: noon })).ok).toBe(true);
  });

  it("addTimeEntry refuses an impossible date and a bad duration", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const t = await ticket(A.id, "support");
    for (const workedOn of ["2026-02-31", "2026-13-01", "yesterday", "2026-1-5"]) {
      expect(await addTimeEntry(owner, t.id, { duration: "1h", workedOn }, { db, now: noon })).toEqual({ ok: false, error: "invalidDate" });
    }
    for (const duration of ["", "abc", "0", "25h", "1441", "-5"]) {
      expect(await addTimeEntry(owner, t.id, { duration }, { db, now: noon })).toEqual({ ok: false, error: "invalidDuration" });
    }
    expect(await db.select().from(timeEntries)).toEqual([]);
  });

  it("time entry actions outside the collaborator's scope are notFound", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const collab = await member("Cy", "collaborator");
    await db.insert(clientAssignments).values({ clientId: A.id, userId: collab.user.id });
    const mine = await ticket(A.id, "support");
    const hidden = await ticket(B.id, "support");
    const made = await addTimeEntry(owner, hidden.id, { duration: "1h" }, { db, now: noon });
    if (!made.ok) throw new Error(made.error);
    expect(await addTimeEntry(collab, hidden.id, { duration: "1h" }, { db, now: noon })).toEqual({ ok: false, error: "notFound" });
    expect(await deleteTimeEntry(collab, hidden.id, made.value.id, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await listTicketTime(collab, hidden.id, { db })).toEqual({ ok: false, error: "notFound" });
    // an entry id of another ticket never resolves through a ticket the actor can see
    expect(await deleteTimeEntry(owner, mine.id, made.value.id, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await deleteTimeEntry(owner, mine.id, "nope", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await db.select().from(timeEntries)).toHaveLength(1);
  });

  it("a collaborator cannot delete someone else's entry, but staff can and the author can", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const manager = await member("Beto", "manager");
    const collab = await member("Cy", "collaborator");
    const other = await member("Dai", "collaborator");
    await db.insert(clientAssignments).values([
      { clientId: A.id, userId: collab.user.id },
      { clientId: A.id, userId: other.user.id },
    ]);
    const t = await ticket(A.id, "support");
    const log = async (who: TeamSession) => {
      const r = await addTimeEntry(who, t.id, { duration: "20" }, { db, now: noon });
      if (!r.ok) throw new Error(r.error);
      return r.value.id;
    };
    const ownersEntry = await log(owner);
    expect(await deleteTimeEntry(collab, t.id, ownersEntry, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await db.select().from(timeEntries)).toHaveLength(1);

    const collabEntry = await log(collab);
    expect(await deleteTimeEntry(other, t.id, collabEntry, { db })).toEqual({ ok: false, error: "forbidden" });
    expect((await deleteTimeEntry(collab, t.id, collabEntry, { db })).ok).toBe(true);

    const again = await log(collab);
    expect((await deleteTimeEntry(manager, t.id, again, { db })).ok).toBe(true);
    expect((await deleteTimeEntry(owner, t.id, ownersEntry, { db })).ok).toBe(true);
    expect(await db.select().from(timeEntries)).toEqual([]);
  });

  it("a closed ticket still accepts time", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const t = await ticket(A.id, "single");
    await db.update(tickets).set({ status: "closed", closedAt: new Date() }).where(eq(tickets.id, t.id));
    expect((await addTimeEntry(owner, t.id, { duration: "45min" }, { db, now: noon })).ok).toBe(true);
    const listed = await listTicketTime(owner, t.id, { db });
    expect(listed.ok && listed.value.totalMinutes).toBe(45);
  });

  it("a removed author shows as removed user", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const gone = await member("Eva", "manager");
    const t = await ticket(A.id, "support");
    await addTimeEntry(gone, t.id, { duration: "10", workedOn: "2026-11-10" }, { db, now: noon });
    await addTimeEntry(owner, t.id, { duration: "50", workedOn: "2026-11-12" }, { db, now: noon });
    await db.delete(users).where(eq(users.id, gone.user.id));
    const res = await listTicketTime(owner, t.id, { db, locale: "pt" });
    if (!res.ok) throw new Error(res.error);
    expect(res.value.totalMinutes).toBe(60);
    expect(res.value.entries.map((e) => [e.minutes, e.authorName, e.mine])).toEqual([
      [50, "Ana", true],
      [10, "Usuário removido", false],
    ]);
  });
});

describe("hour purchases and the client's cycle", () => {
  const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
  async function member(name: string, role: User["role"]) {
    const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
    return asTeam(u);
  }
  const owner = async () => asTeam((await db.select().from(users))[0]);

  it("hour purchases are staff only", async () => {
    const collab = await member("Cy", "collaborator");
    await db.insert(clientAssignments).values({ clientId: A.id, userId: collab.user.id });
    const [p] = await db.insert(hourPurchases).values({ clientId: A.id, minutes: 60, cycle: "2026-11" }).returning();
    expect(await addHourPurchase(collab, A.id, { duration: "1h", cycle: "2026-11" }, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteHourPurchase(collab, A.id, p.id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await getClientHoursCycle(collab, A.id, "2026-11", { db })).toEqual({ ok: false, error: "forbidden" });
    const manager = await member("Beto", "manager");
    expect((await addHourPurchase(manager, A.id, { duration: "1h", cycle: "2026-11" }, { db })).ok).toBe(true);
    expect(await addHourPurchase(await owner(), "00000000-0000-0000-0000-000000000000", { duration: "1h", cycle: "2026-11" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await db.select().from(hourPurchases)).toHaveLength(2);
  });

  it("validates the duration, the cycle and the price", async () => {
    const o = await owner();
    for (const duration of ["", "abc", "0", "100001"]) {
      expect(await addHourPurchase(o, A.id, { duration, cycle: "2026-11" }, { db })).toEqual({ ok: false, error: "invalidDuration" });
    }
    for (const cycle of ["", "2026-13", "2026-1", "nov"]) {
      expect(await addHourPurchase(o, A.id, { duration: "1h", cycle }, { db })).toEqual({ ok: false, error: "invalidCycle" });
    }
    expect(await addHourPurchase(o, A.id, { duration: "1h", cycle: "2026-11", price: "abc" }, { db })).toEqual({ ok: false, error: "invalidPrice" });
    expect(await db.select().from(hourPurchases)).toEqual([]);
    // more than a day is fine for a purchase, and a bare number is hours
    expect((await addHourPurchase(o, A.id, { duration: "1666h", cycle: "2026-11" }, { db })).ok).toBe(true);
    expect(await addHourPurchase(o, A.id, { duration: "1667", cycle: "2026-11" }, { db })).toEqual({ ok: false, error: "invalidDuration" });
    await addHourPurchase(o, A.id, { duration: "2", cycle: "2026-11" }, { db });
    expect((await db.select().from(hourPurchases)).map((r) => r.minutes).sort((a, b) => a - b)).toEqual([120, 99960]);
  });

  it("limits the purchase note to 500 characters", async () => {
    const o = await owner();
    expect(await addHourPurchase(o, A.id, { duration: "1h", cycle: "2026-11", note: "a".repeat(501) }, { db })).toEqual({ ok: false, error: "tooLong" });
    expect(await db.select().from(hourPurchases)).toEqual([]);
    expect((await addHourPurchase(o, A.id, { duration: "1h", cycle: "2026-11", note: "a".repeat(500) }, { db })).ok).toBe(true);
  });

  it("a purchase counts in its own cycle", async () => {
    const o = await owner();
    const res = await addHourPurchase(o, A.id, { duration: "2h", cycle: "2026-10", price: "1.200,50", note: "  Extra  " }, { db });
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(hourPurchases);
    expect(row).toMatchObject({ clientId: A.id, minutes: 120, cycle: "2026-10", priceCents: 120050, pending: false, note: "Extra", createdById: o.user.id });
    expect((await getHoursSummary(A.id, "2026-10", { db }))?.purchasedMinutes).toBe(120);
    expect((await getHoursSummary(A.id, "2026-11", { db }))?.purchasedMinutes).toBe(0);
  });

  it("deleting a purchase removes it from the balance; a pending one cannot be deleted", async () => {
    const o = await owner();
    const made = await addHourPurchase(o, A.id, { duration: "90min", cycle: "2026-11" }, { db });
    if (!made.ok) throw new Error(made.error);
    const [pending] = await db.insert(hourPurchases).values({ clientId: A.id, minutes: 30, cycle: "2026-11", pending: true }).returning();
    const [others] = await db.insert(hourPurchases).values({ clientId: B.id, minutes: 30, cycle: "2026-11" }).returning();
    expect((await getHoursSummary(A.id, "2026-11", { db }))?.balanceMinutes).toBe(690);
    expect(await deleteHourPurchase(o, A.id, pending.id, { db })).toEqual({ ok: false, error: "pending" });
    // a purchase of another client never resolves through this one
    expect(await deleteHourPurchase(o, A.id, others.id, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await deleteHourPurchase(o, A.id, "nope", { db })).toEqual({ ok: false, error: "notFound" });
    expect((await deleteHourPurchase(o, A.id, made.value.id, { db })).ok).toBe(true);
    expect((await getHoursSummary(A.id, "2026-11", { db }))?.balanceMinutes).toBe(600);
    expect(await db.select({ id: hourPurchases.id }).from(hourPurchases)).toHaveLength(2);
  });

  it("getClientHoursCycle lists every entry of the cycle and flags single tickets", async () => {
    const o = await owner();
    const support = await ticket(A.id, "support");
    const single = await ticket(A.id, "single");
    await db.insert(timeEntries).values([
      { ...entry(support, 60, "2026-11-02"), note: "Menu", createdById: o.user.id },
      entry(single, 30, "2026-11-20"),
    ]);
    await db.insert(hourPurchases).values([
      { clientId: A.id, minutes: 120, cycle: "2026-11", priceCents: 5000, note: "Pack" },
      { clientId: A.id, minutes: 30, cycle: "2026-11", pending: true },
    ]);
    const res = await getClientHoursCycle(o, A.id, "2026-11", { db });
    if (!res.ok) throw new Error(res.error);
    expect(res.value.summary).toMatchObject({ cycle: "2026-11", usedMinutes: 60, purchasedMinutes: 120, balanceMinutes: 660 });
    expect(res.value.entries.map((e) => [e.ticketNumber, e.ticketType, e.minutes, e.workedOn, e.note])).toEqual([
      [2, "single", 30, "2026-11-20", null],
      [1, "support", 60, "2026-11-02", "Menu"],
    ]);
    expect(res.value.entries[0]).toMatchObject({ ticketId: single.id, ticketTitle: "T" });
    expect(res.value.purchases.map((p) => [p.minutes, p.priceCents, p.pending]).sort()).toEqual([[120, 5000, false], [30, null, true]]);
    expect(await getClientHoursCycle(o, "00000000-0000-0000-0000-000000000000", "2026-11", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await getClientHoursCycle(o, A.id, "2026-13", { db })).toEqual({ ok: false, error: "invalidCycle" });
  });

  it("another cycle's entries and purchases are not listed", async () => {
    const o = await owner();
    const support = await ticket(A.id, "support");
    const theirs = await ticket(B.id, "support");
    await db.insert(timeEntries).values([
      entry(support, 10, "2026-10-31"),
      entry(support, 20, "2026-11-01"),
      entry(support, 30, "2026-11-30"),
      entry(support, 40, "2026-12-01"),
      entry(theirs, 50, "2026-11-10"),
    ]);
    await db.insert(hourPurchases).values([
      { clientId: A.id, minutes: 60, cycle: "2026-10" },
      { clientId: A.id, minutes: 70, cycle: "2026-11" },
      { clientId: B.id, minutes: 80, cycle: "2026-11" },
    ]);
    const res = await getClientHoursCycle(o, A.id, "2026-11", { db });
    if (!res.ok) throw new Error(res.error);
    expect(res.value.entries.map((e) => e.minutes)).toEqual([30, 20]);
    expect(res.value.purchases.map((p) => p.minutes)).toEqual([70]);
  });
});

describe("the agency's time zone", () => {
  const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
  // 08:00 on 1 February in Tokyo is 23:00 UTC on 31 January, still the 31st in São Paulo.
  const tokyoMorning = () => new Date("2026-01-31T23:00:00Z");

  it("an agency in Tokyo logging at 08:00 on 1 February puts the entry and the balance in February", async () => {
    await db.update(agency).set({ timeZone: "Asia/Tokyo" }).where(eq(agency.id, 1));
    const owner = asTeam((await db.select().from(users))[0]);
    const t = await ticket(A.id, "support");

    // no day: today in Tokyo, and the 1st is not in the future there
    expect((await addTimeEntry(owner, t.id, { duration: "1h" }, { db, now: tokyoMorning })).ok).toBe(true);
    expect((await addTimeEntry(owner, t.id, { duration: "30", workedOn: "2026-02-01" }, { db, now: tokyoMorning })).ok).toBe(true);
    expect(await addTimeEntry(owner, t.id, { duration: "30", workedOn: "2026-02-02" }, { db, now: tokyoMorning })).toEqual({
      ok: false,
      error: "futureDate",
    });
    expect((await db.select().from(timeEntries)).map((r) => r.workedOn)).toEqual(["2026-02-01", "2026-02-01"]);

    const summary = await getHoursSummary(A.id, undefined, { db, now: tokyoMorning });
    expect(summary).toMatchObject({ cycle: "2026-02", usedMinutes: 90, balanceMinutes: 510 });
  });

  it("the same instant is still January for an agency in São Paulo (the default)", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const t = await ticket(A.id, "support");
    expect(await addTimeEntry(owner, t.id, { duration: "30", workedOn: "2026-02-01" }, { db, now: tokyoMorning })).toEqual({
      ok: false,
      error: "futureDate",
    });
    await addTimeEntry(owner, t.id, { duration: "1h" }, { db, now: tokyoMorning });
    expect((await db.select().from(timeEntries)).map((r) => r.workedOn)).toEqual(["2026-01-31"]);
    expect((await getHoursSummary(A.id, undefined, { db, now: tokyoMorning }))?.cycle).toBe("2026-01");
  });

  it("changing the zone mid-month moves only the boundary from then on; nothing stored changes", async () => {
    const owner = asTeam((await db.select().from(users))[0]);
    const t = await ticket(A.id, "support");
    await addTimeEntry(owner, t.id, { duration: "1h", workedOn: "2026-01-20" }, { db, now: tokyoMorning });
    await addHourPurchase(owner, A.id, { duration: "2h", cycle: "2026-01" }, { db });
    const before = { entries: await db.select().from(timeEntries), purchases: await db.select().from(hourPurchases) };

    await db.update(agency).set({ timeZone: "Asia/Tokyo" }).where(eq(agency.id, 1));
    expect(await db.select().from(timeEntries)).toEqual(before.entries);
    expect(await db.select().from(hourPurchases)).toEqual(before.purchases);
    // the current cycle now turns over by Tokyo's clock; January's numbers are the same as before
    expect((await getHoursSummary(A.id, undefined, { db, now: tokyoMorning }))?.cycle).toBe("2026-02");
    expect(await getHoursSummary(A.id, "2026-01", { db })).toMatchObject({ usedMinutes: 60, purchasedMinutes: 120 });
  });

  it("a stored zone the runtime no longer knows falls back to São Paulo instead of breaking", async () => {
    await db.update(agency).set({ timeZone: "Mars/Base" }).where(eq(agency.id, 1));
    expect((await getHoursSummary(A.id, undefined, { db, now: tokyoMorning }))?.cycle).toBe("2026-01");
  });
});
