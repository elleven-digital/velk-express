import "server-only";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { isStaff } from "@/lib/access";
import type { TeamSession } from "@/lib/auth/session";
import { db as appDb, labels, ticketLabels, type Db, type Label } from "@/lib/db";
import { cleanLabelName, DEFAULT_LABEL_COLOR, LABEL_MAX, parseLabelColor } from "@/lib/labels";
import { fail, ok, type Result } from "./result";
import { findTicket } from "./tickets";
import { Abort, transact } from "./tx";

/**
 * Ticket labels: the agency's own words for where a ticket stands. Owner and manager create,
 * rename, recolor and delete them; anyone who can see a ticket applies or removes them.
 * Internal only: nothing here reaches the client portal.
 */

/** Test seam: the database. */
type Deps = { db?: Db };

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agency's labels by name, with how many tickets carry each. */
export async function listLabels(db: Db = appDb): Promise<(Label & { tickets: number })[]> {
  const rows = await db
    .select({ label: labels, tickets: count(ticketLabels.ticketId) })
    .from(labels)
    .leftJoin(ticketLabels, eq(ticketLabels.labelId, labels.id))
    .groupBy(labels.id)
    .orderBy(asc(sql`lower(${labels.name})`), asc(labels.id));
  return rows.map((r) => ({ ...r.label, tickets: Number(r.tickets) }));
}

/** A unique violation (name already used), however the driver wraps it. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Empty means gray; otherwise hex or a preset name. null when it is not a color. */
function colorInput(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return DEFAULT_LABEL_COLOR;
  return parseLabelColor(raw);
}

async function nameTaken(db: Db, name: string, exceptId?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(sql`lower(${labels.name}) = lower(${name})`, exceptId ? ne(labels.id, exceptId) : undefined))
    .limit(1);
  return Boolean(row);
}

export async function createLabel(
  actor: TeamSession,
  input: { name: string; color: string },
  deps: Deps = {},
): Promise<Result<{ labelId: string }>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const name = cleanLabelName(input.name);
  if (!name) return fail("invalid");
  const color = colorInput(input.color);
  if (!color) return fail("labelColorInvalid");
  const db = deps.db ?? appDb;
  try {
    return await transact(db, async (tx) => {
      // One lock for every create, so the count and the name check cannot race.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('velk:labels'))`);
      const [{ n }] = await tx.select({ n: count() }).from(labels);
      if (Number(n) >= LABEL_MAX) throw new Abort("labelLimit");
      if (await nameTaken(tx, name)) throw new Abort("labelTaken");
      const [row] = await tx.insert(labels).values({ name, color }).returning({ id: labels.id });
      return { labelId: row.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return fail("labelTaken");
    throw err;
  }
}

/** A field left undefined keeps its value; an empty color means gray. */
export async function updateLabel(
  actor: TeamSession,
  labelId: string,
  input: { name?: string; color?: string },
  deps: Deps = {},
): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  if (!uuidRe.test(labelId)) return fail("notFound");
  const db = deps.db ?? appDb;
  const patch: Partial<Pick<Label, "name" | "color">> = {};
  if (input.name !== undefined) {
    const name = cleanLabelName(input.name);
    if (!name) return fail("invalid");
    patch.name = name;
  }
  if (input.color !== undefined) {
    const color = colorInput(input.color);
    if (!color) return fail("labelColorInvalid");
    patch.color = color;
  }
  try {
    const res = await transact(db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('velk:labels'))`);
      const [label] = await tx.select().from(labels).where(eq(labels.id, labelId));
      if (!label) throw new Abort("notFound");
      if (patch.name && (await nameTaken(tx, patch.name, label.id))) throw new Abort("labelTaken");
      if (Object.keys(patch).length > 0) await tx.update(labels).set(patch).where(eq(labels.id, label.id));
    });
    return res.ok ? ok() : res;
  } catch (err) {
    if (isUniqueViolation(err)) return fail("labelTaken");
    throw err;
  }
}

/** The label leaves every ticket that had it. */
export async function deleteLabel(actor: TeamSession, labelId: string, deps: Deps = {}): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  if (!uuidRe.test(labelId)) return fail("notFound");
  const db = deps.db ?? appDb;
  const deleted = await db.delete(labels).where(eq(labels.id, labelId)).returning({ id: labels.id });
  return deleted.length > 0 ? ok() : fail("notFound");
}

/** Anyone who sees the ticket. Applying it twice changes nothing. */
export async function addTicketLabel(actor: TeamSession, ticketId: string, labelId: string, deps: Deps = {}): Promise<Result> {
  if (actor.userType !== "agency") return fail("forbidden");
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return fail(found.error);
  if (!uuidRe.test(labelId)) return fail("notFound");
  const [label] = await db.select({ id: labels.id }).from(labels).where(eq(labels.id, labelId));
  if (!label) return fail("notFound");
  try {
    await db.insert(ticketLabels).values({ ticketId: found.value.id, labelId: label.id }).onConflictDoNothing();
  } catch (err) {
    // The label was deleted between the check and the insert.
    const e = err as { code?: string; cause?: { code?: string } } | null;
    if (e?.code === "23503" || e?.cause?.code === "23503") return fail("notFound");
    throw err;
  }
  return ok();
}

export async function removeTicketLabel(
  actor: TeamSession,
  ticketId: string,
  labelId: string,
  deps: Deps = {},
): Promise<Result> {
  if (actor.userType !== "agency") return fail("forbidden");
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return fail(found.error);
  if (!uuidRe.test(labelId)) return fail("notFound");
  await db.delete(ticketLabels).where(and(eq(ticketLabels.ticketId, found.value.id), eq(ticketLabels.labelId, labelId)));
  return ok();
}

/** The labels of each ticket, by name. Tickets without any are absent from the map. */
export async function labelsByTicket(ticketIds: string[], db: Db = appDb): Promise<Map<string, Label[]>> {
  const map = new Map<string, Label[]>();
  if (ticketIds.length === 0) return map;
  const rows = await db
    .select({ ticketId: ticketLabels.ticketId, label: labels })
    .from(ticketLabels)
    .innerJoin(labels, eq(ticketLabels.labelId, labels.id))
    .where(inArray(ticketLabels.ticketId, ticketIds))
    .orderBy(asc(sql`lower(${labels.name})`), asc(labels.id));
  for (const r of rows) {
    const list = map.get(r.ticketId) ?? [];
    list.push(r.label);
    map.set(r.ticketId, list);
  }
  return map;
}
