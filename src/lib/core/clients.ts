import "server-only";
import { cache } from "react";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { canAccessClient, isStaff, visibleClientsWhere } from "@/lib/access";
import type { TeamSession } from "@/lib/auth/session";
import { db as appDb, clients, sites, type Client, type Db, type Site } from "@/lib/db";
import type { HoursPlan } from "@/lib/hours-plan";
import { fail, ok, type Result } from "./result";
import { applySupportPlan } from "./support-plan";

/**
 * Clients, their support plan and their sites. Owners and managers write;
 * collaborators read the clients they may see. Every read and write goes
 * through `src/lib/access.ts`, so a client hidden from someone does not exist
 * for them, not even by id.
 */

/** Test seam: the database. */
type Deps = { db?: Db };

export type ClientInput = { name: string; email?: string | null; phone?: string | null; notes?: string | null };
export type SupportInput = {
  supportActive: boolean;
  monthlyCents: number | null;
  generalTickets: boolean;
  siteIdsInPlan: string[];
  hours: HoursPlan;
};
export type SiteInput = { name: string; url?: string | null; notes?: string | null; includedInSupport?: boolean };

const MAX_URL = 2048;
const MAX_CENTS = 2_147_483_647;

/** Optional text: trimmed, empty becomes null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const clientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .nullish()
    .transform((v) => v || null)
    .pipe(z.email().nullable()),
  phone: optionalText(40),
  notes: optionalText(5000),
});

const supportSchema = z.object({
  supportActive: z.boolean(),
  monthlyCents: z.number().int().min(0).max(MAX_CENTS).nullable(),
  generalTickets: z.boolean(),
  siteIdsInPlan: z.array(z.string()),
  hours: z.object({
    tracked: z.boolean(),
    visible: z.boolean(),
    limited: z.boolean(),
    includedMinutes: z.number().int().min(0).max(100_000),
    extraHourCents: z.number().int().min(0).max(MAX_CENTS).nullable(),
    purchasable: z.boolean(),
  }),
});

const siteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  notes: optionalText(5000),
});

/** An address as people type it ("acme.com") to a full http(s) one; empty is null. */
export function normalizeSiteUrl(raw: string | null | undefined): Result<string | null> {
  const text = (raw ?? "").trim();
  if (!text) return ok(null);
  // "localhost:3000" has a port, not a scheme; "javascript:x" and "ftp://x" have one.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(text);
  const full = hasScheme ? text : `https://${text}`;
  if (full.length > MAX_URL) return fail("invalid");
  try {
    const url = new URL(full);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return fail("invalid");
  } catch {
    return fail("invalid");
  }
  return ok(full);
}

/** Clients this member may see, by name, with how many sites each has. */
export async function listClients(actor: TeamSession, deps: Deps = {}): Promise<(Client & { siteCount: number })[]> {
  const db = deps.db ?? appDb;
  const where = await visibleClientsWhere(actor, db);
  const rows = await db
    .select({ client: clients, siteCount: count(sites.id) })
    .from(clients)
    .leftJoin(sites, eq(sites.clientId, clients.id))
    .where(where)
    .groupBy(clients.id)
    .orderBy(asc(clients.name), asc(clients.id));
  return rows.map((r) => ({ ...r.client, siteCount: r.siteCount }));
}

/** "notFound" when the client does not exist or this member may not see it. */
export async function getClient(actor: TeamSession, clientId: string, deps: Deps = {}): Promise<Result<Client>> {
  const db = deps.db ?? appDb;
  if (!(await canAccessClient(actor, clientId, db))) return fail("notFound");
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  return client ? ok(client) : fail("notFound");
}

/** `getClient` once per request: the layout and the page of a client share one lookup. */
export const getClientCached: (actor: TeamSession, clientId: string) => Promise<Result<Client>> = cache(
  (actor: TeamSession, clientId: string) => getClient(actor, clientId),
);

/** A client the actor may change: staff only; a hidden or missing one is "notFound". */
async function writableClient(actor: TeamSession, clientId: string, db: Db): Promise<Result<Client>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  return getClient(actor, clientId, { db });
}

export async function createClient(
  actor: TeamSession,
  input: ClientInput,
  deps: Deps = {},
): Promise<Result<{ clientId: string }>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const parsed = clientSchema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const db = deps.db ?? appDb;
  const [row] = await db.insert(clients).values(parsed.data).returning({ id: clients.id });
  return ok({ clientId: row.id });
}

export async function updateClient(
  actor: TeamSession,
  clientId: string,
  input: ClientInput,
  deps: Deps = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  const found = await writableClient(actor, clientId, db);
  if (!found.ok) return found;
  const parsed = clientSchema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  await db.update(clients).set(parsed.data).where(eq(clients.id, clientId));
  return ok();
}

/**
 * Replaces the support plan. Without support there is no monthly value, no
 * general tickets, no hours and no site in the plan. Only this client's sites change.
 */
export async function updateSupport(
  actor: TeamSession,
  clientId: string,
  input: SupportInput,
  deps: Deps = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  const found = await writableClient(actor, clientId, db);
  if (!found.ok) return found;
  const parsed = supportSchema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const { supportActive, siteIdsInPlan } = parsed.data;
  const inPlan = supportActive ? siteIdsInPlan.filter((id) => z.uuid().safeParse(id).success) : [];

  await db.transaction(async (tx) => {
    await applySupportPlan(tx as unknown as Db, clientId, parsed.data);
    await tx.update(sites).set({ includedInSupport: false }).where(eq(sites.clientId, clientId));
    if (inPlan.length > 0) {
      await tx
        .update(sites)
        .set({ includedInSupport: true })
        .where(and(eq(sites.clientId, clientId), inArray(sites.id, inPlan)));
    }
  });
  return ok();
}

export async function listSites(actor: TeamSession, clientId: string, deps: Deps = {}): Promise<Result<Site[]>> {
  const db = deps.db ?? appDb;
  const found = await getClient(actor, clientId, { db });
  if (!found.ok) return found;
  return ok(await db.select().from(sites).where(eq(sites.clientId, clientId)).orderBy(asc(sites.createdAt), asc(sites.id)));
}

function parseSite(input: SiteInput): Result<{ name: string; notes: string | null; url: string | null }> {
  const parsed = siteSchema.safeParse(input);
  const url = normalizeSiteUrl(input.url);
  if (!parsed.success || !url.ok) return fail("invalid");
  return ok({ ...parsed.data, url: url.value });
}

export async function addSite(
  actor: TeamSession,
  clientId: string,
  input: SiteInput,
  deps: Deps = {},
): Promise<Result<{ siteId: string }>> {
  const db = deps.db ?? appDb;
  const found = await writableClient(actor, clientId, db);
  if (!found.ok) return found;
  const data = parseSite(input);
  if (!data.ok) return data;
  const [row] = await db
    .insert(sites)
    .values({
      ...data.value,
      clientId,
      includedInSupport: found.value.supportActive && Boolean(input.includedInSupport),
    })
    .returning({ id: sites.id });
  return ok({ siteId: row.id });
}

export async function updateSite(
  actor: TeamSession,
  clientId: string,
  siteId: string,
  input: SiteInput,
  deps: Deps = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  const found = await writableClient(actor, clientId, db);
  if (!found.ok) return found;
  if (!z.uuid().safeParse(siteId).success) return fail("notFound");
  const data = parseSite(input);
  if (!data.ok) return data;
  const updated = await db
    .update(sites)
    .set({
      ...data.value,
      // The flag only means something while the client has support.
      includedInSupport: found.value.supportActive && Boolean(input.includedInSupport),
    })
    .where(and(eq(sites.id, siteId), eq(sites.clientId, clientId)))
    .returning({ id: sites.id });
  return updated.length > 0 ? ok() : fail("notFound");
}

export async function deleteSite(
  actor: TeamSession,
  clientId: string,
  siteId: string,
  deps: Deps = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  const found = await writableClient(actor, clientId, db);
  if (!found.ok) return found;
  if (!z.uuid().safeParse(siteId).success) return fail("notFound");
  const removed = await db
    .delete(sites)
    .where(and(eq(sites.id, siteId), eq(sites.clientId, clientId)))
    .returning({ id: sites.id });
  return removed.length > 0 ? ok() : fail("notFound");
}
