import "server-only";
import { and, between, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { isStaff } from "@/lib/access";
import type { TeamSession } from "@/lib/auth/session";
import { charges, clients, db as appDb, hourPurchases, tickets, timeEntries, type Db, type HoursMode } from "@/lib/db";
import { getDict, type Locale } from "@/lib/i18n";
import { cycleKey, cycleRange, isCycle, parseDuration, todayInCycleZone } from "@/lib/hours";
import { parseMoney } from "@/lib/format";
import { getClient } from "./clients";
import { actorKey, resolveActorNames } from "./messages";
import { fail, ok, type Result } from "./result";
import { findTicket } from "./tickets";
import { Abort, transact } from "./tx";

const uuid = z.uuid();

/** The longest note on a time entry or a purchase, in characters. */
const NOTE_MAX_CHARS = 500;

export type HoursSummary = {
  cycle: string;
  mode: HoursMode;
  /** The package's monthly minutes; 0 outside the package mode. */
  includedMinutes: number;
  /** Minutes bought for this cycle and already paid. */
  purchasedMinutes: number;
  /** Minutes logged on support tickets with a work day in this cycle. */
  usedMinutes: number;
  /** included + purchased - used; negative when over the package. */
  balanceMinutes: number;
};

/**
 * The hours of one client in one cycle (the current one by default), or null when the client does
 * not exist. It does not check access: the caller already did, and decides what each viewer sees.
 */
export async function getHoursSummary(
  clientId: string,
  cycle?: string,
  deps: { db?: Db; now?: () => Date } = {},
): Promise<HoursSummary | null> {
  const db = deps.db ?? appDb;
  const month = cycle ?? cycleKey(deps.now?.());
  const { start, end } = cycleRange(month);

  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) return null;

  const [used] = await db
    .select({ total: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int` })
    .from(timeEntries)
    .innerJoin(tickets, eq(tickets.id, timeEntries.ticketId))
    .where(and(eq(timeEntries.clientId, clientId), eq(tickets.type, "support"), between(timeEntries.workedOn, start, end)));

  const [bought] = await db
    .select({ total: sql<number>`coalesce(sum(${hourPurchases.minutes}), 0)::int` })
    .from(hourPurchases)
    .where(and(eq(hourPurchases.clientId, clientId), eq(hourPurchases.cycle, month), eq(hourPurchases.pending, false)));

  const includedMinutes = client.hoursMode === "package" ? client.includedMinutes : 0;
  const usedMinutes = used.total;
  const purchasedMinutes = bought.total;
  return {
    cycle: month,
    mode: client.hoursMode,
    includedMinutes,
    purchasedMinutes,
    usedMinutes,
    balanceMinutes: includedMinutes + purchasedMinutes - usedMinutes,
  };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether "YYYY-MM-DD" is a day that exists in the calendar (no 2026-02-31). */
function isRealDay(day: string): boolean {
  const m = DAY.exec(day);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/**
 * Logs time on a ticket the actor can see (any type, open or closed, any hours mode of the client).
 * `duration` is what was typed ("1h30"); `workedOn` defaults to today in the cycle zone and cannot
 * be after it. The client is always the ticket's.
 */
export async function addTimeEntry(
  actor: TeamSession,
  ticketId: string,
  input: { duration: string; workedOn?: string; note?: string },
  deps: { db?: Db; now?: () => Date } = {},
): Promise<Result<{ id: string }>> {
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  const minutes = parseDuration(String(input.duration ?? ""));
  if (minutes === null) return fail("invalidDuration");
  if ((input.note ?? "").trim().length > NOTE_MAX_CHARS) return fail("tooLong");
  const today = todayInCycleZone(deps.now?.());
  const workedOn = input.workedOn?.trim() || today;
  if (!isRealDay(workedOn)) return fail("invalidDate");
  // "YYYY-MM-DD" strings order the same as the days they name.
  if (workedOn > today) return fail("futureDate");
  const [row] = await db
    .insert(timeEntries)
    .values({
      ticketId: found.value.id,
      clientId: found.value.clientId,
      minutes,
      workedOn,
      note: input.note?.trim() || null,
      createdById: actor.user.id,
    })
    .returning({ id: timeEntries.id });
  return ok({ id: row.id });
}

/** Removes a time entry of a ticket the actor can see: its author or staff only. */
export async function deleteTimeEntry(
  actor: TeamSession,
  ticketId: string,
  entryId: string,
  deps: { db?: Db } = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  if (!uuid.safeParse(entryId).success) return fail("notFound");
  const [entry] = await db
    .select({ id: timeEntries.id, createdById: timeEntries.createdById })
    .from(timeEntries)
    .where(and(eq(timeEntries.id, entryId), eq(timeEntries.ticketId, found.value.id)));
  if (!entry) return fail("notFound");
  if (!isStaff(actor.user) && entry.createdById !== actor.user.id) return fail("forbidden");
  await db.delete(timeEntries).where(eq(timeEntries.id, entry.id));
  return ok();
}

export type TicketTimeEntry = {
  id: string;
  minutes: number;
  /** "YYYY-MM-DD". */
  workedOn: string;
  note: string | null;
  /** The author's name; the localized "removed user" label when the person is gone. */
  authorName: string;
  /** Logged by the viewer. */
  mine: boolean;
  /** ISO instant. */
  createdAt: string;
};

/** The time logged on a ticket the actor can see, newest work day first, with the total. */
export async function listTicketTime(
  actor: TeamSession,
  ticketId: string,
  deps: { db?: Db; locale?: Locale } = {},
): Promise<Result<{ entries: TicketTimeEntry[]; totalMinutes: number }>> {
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  const rows = await db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.ticketId, found.value.id))
    .orderBy(desc(timeEntries.workedOn), desc(timeEntries.createdAt), desc(timeEntries.id));
  const names = await resolveActorNames(
    rows.flatMap((r) => (r.createdById ? [{ type: "agency" as const, id: r.createdById }] : [])),
    db,
  );
  const removed = (await getDict(deps.locale ?? "en")).common.removedUser;
  const entries = rows.map((r) => ({
    id: r.id,
    minutes: r.minutes,
    workedOn: r.workedOn,
    note: r.note,
    authorName: (r.createdById && names.get(actorKey({ type: "agency", id: r.createdById }))) || removed,
    mine: r.createdById === actor.user.id,
    createdAt: r.createdAt.toISOString(),
  }));
  return ok({ entries, totalMinutes: entries.reduce((sum, e) => sum + e.minutes, 0) });
}

/** The longest single purchase, in minutes. */
const MAX_PURCHASE_MINUTES = 100000;

/** A client the actor may change the hours of: staff only; a missing one is "notFound". */
async function staffClient(actor: TeamSession, clientId: string, db: Db) {
  if (!isStaff(actor.user)) return fail("forbidden");
  return getClient(actor, clientId, { db });
}

/**
 * Registers hours the client bought for one cycle. It counts at once (`pending` is false). The
 * price is optional, in the agency's currency as typed; the note is optional. Staff only.
 */
export async function addHourPurchase(
  actor: TeamSession,
  clientId: string,
  input: { duration: string; cycle: string; price?: string; note?: string },
  deps: { db?: Db } = {},
): Promise<Result<{ id: string }>> {
  const db = deps.db ?? appDb;
  const client = await staffClient(actor, clientId, db);
  if (!client.ok) return client;
  const minutes = parseDuration(String(input.duration ?? ""), { max: MAX_PURCHASE_MINUTES });
  if (minutes === null) return fail("invalidDuration");
  const cycle = String(input.cycle ?? "");
  if (!isCycle(cycle)) return fail("invalidCycle");
  if ((input.note ?? "").trim().length > NOTE_MAX_CHARS) return fail("tooLong");
  const rawPrice = String(input.price ?? "").trim();
  const priceCents = rawPrice ? parseMoney(rawPrice) : null;
  if (rawPrice && priceCents === null) return fail("invalidPrice");
  const [row] = await db
    .insert(hourPurchases)
    .values({
      clientId: client.value.id,
      minutes,
      cycle,
      priceCents,
      note: input.note?.trim() || null,
      createdById: actor.user.id,
    })
    .returning({ id: hourPurchases.id });
  return ok({ id: row.id });
}

/**
 * Removes a purchase of the client. Staff only. A pending one (bought from the portal, not paid)
 * is refused with "pending": it belongs to its payment, not to the team. One with a live or paid
 * charge is refused with "chargeExists": cancel the charge first.
 */
export async function deleteHourPurchase(
  actor: TeamSession,
  clientId: string,
  purchaseId: string,
  deps: { db?: Db } = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  const client = await staffClient(actor, clientId, db);
  if (!client.ok) return client;
  if (!uuid.safeParse(purchaseId).success) return fail("notFound");
  const res = await transact(db, async (tx) => {
    // Its charges before the purchase, the order cancels and webhooks use. A charge being created
    // holds the purchase (key share), so the lock below waits for it and the check then sees it.
    await tx.select({ id: charges.id }).from(charges).where(eq(charges.hourPurchaseId, purchaseId)).for("update");
    const [purchase] = await tx
      .select({ id: hourPurchases.id, pending: hourPurchases.pending })
      .from(hourPurchases)
      .where(and(eq(hourPurchases.id, purchaseId), eq(hourPurchases.clientId, client.value.id)))
      .for("update");
    if (!purchase) throw new Abort("notFound");
    if (purchase.pending) throw new Abort("pending");
    const [live] = await tx
      .select({ id: charges.id })
      .from(charges)
      .where(and(eq(charges.hourPurchaseId, purchase.id), ne(charges.status, "canceled")))
      .limit(1);
    if (live) throw new Abort("chargeExists");
    await tx.delete(hourPurchases).where(eq(hourPurchases.id, purchase.id));
  });
  return res.ok ? ok() : res;
}

export type CycleEntry = {
  id: string;
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  ticketType: "support" | "single";
  minutes: number;
  /** "YYYY-MM-DD". */
  workedOn: string;
  note: string | null;
};

export type CyclePurchase = {
  id: string;
  minutes: number;
  priceCents: number | null;
  pending: boolean;
  note: string | null;
  /** ISO instant. */
  createdAt: string;
};

/**
 * What the Hours tab shows for one cycle: the summary, every time entry with a work day in it (of
 * any ticket type; the caller marks the `single` ones, which the summary leaves out) and the
 * purchases of that cycle. Staff only.
 */
export async function getClientHoursCycle(
  actor: TeamSession,
  clientId: string,
  cycle: string,
  deps: { db?: Db; now?: () => Date } = {},
): Promise<Result<{ summary: HoursSummary; entries: CycleEntry[]; purchases: CyclePurchase[] }>> {
  const db = deps.db ?? appDb;
  const client = await staffClient(actor, clientId, db);
  if (!client.ok) return client;
  if (!isCycle(cycle)) return fail("invalidCycle");
  const { start, end } = cycleRange(cycle);
  const summary = await getHoursSummary(client.value.id, cycle, { db, now: deps.now });
  if (!summary) return fail("notFound");

  const entryRows = await db
    .select({
      id: timeEntries.id,
      ticketId: tickets.id,
      ticketNumber: tickets.number,
      ticketTitle: tickets.title,
      ticketType: tickets.type,
      minutes: timeEntries.minutes,
      workedOn: timeEntries.workedOn,
      note: timeEntries.note,
    })
    .from(timeEntries)
    .innerJoin(tickets, eq(tickets.id, timeEntries.ticketId))
    .where(and(eq(timeEntries.clientId, client.value.id), between(timeEntries.workedOn, start, end)))
    .orderBy(desc(timeEntries.workedOn), desc(timeEntries.createdAt), desc(timeEntries.id));

  const purchaseRows = await db
    .select()
    .from(hourPurchases)
    .where(and(eq(hourPurchases.clientId, client.value.id), eq(hourPurchases.cycle, cycle)))
    .orderBy(desc(hourPurchases.createdAt), desc(hourPurchases.id));

  return ok({
    summary,
    entries: entryRows,
    purchases: purchaseRows.map((p) => ({
      id: p.id,
      minutes: p.minutes,
      priceCents: p.priceCents,
      pending: p.pending,
      note: p.note,
      createdAt: p.createdAt.toISOString(),
    })),
  });
}
