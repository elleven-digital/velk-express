import "server-only";
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { TeamSession } from "@/lib/auth/session";
import { getAppUrl } from "@/lib/app-url";
import { logoAbsoluteUrl } from "@/lib/agency";
import {
  agency,
  clientMemberships,
  clients,
  clientUsers,
  db as appDb,
  quoteItems,
  quotes,
  sites,
  type Client,
  type Db,
  type Quote,
  type QuoteItem,
  type QuoteItemConfig,
  type QuoteItemKind,
  type Site,
} from "@/lib/db";
import { getDict, isLocale } from "@/lib/i18n";
import { buildQuoteSentMail } from "@/lib/mail/messages/quote-sent";
import { sendMail } from "@/lib/mail/send";
import { newQuoteToken, quoteTotals } from "@/lib/quote-utils";
import { normalizeSiteUrl } from "./clients";
import { fail, ok, type Result } from "./result";
import { Abort, transact } from "./tx";

/**
 * Quotes (proposals): owner only. Editing and sending lock the quote row; they never touch the
 * agency row, so the global lock order (agency, quote, portal company, client, ...) holds.
 */

/** Test seams: the database and the mail sender. */
type Deps = { db?: Db; send?: typeof sendMail };

export type QuoteItemInput = {
  kind: QuoteItemKind;
  title: string;
  description?: string;
  amountCents: number;
  config: QuoteItemConfig;
};

export type QuoteInput = {
  quoteId?: string;
  clientId: string | null;
  prospectName?: string;
  prospectEmail?: string;
  title: string;
  notes?: string;
  items: QuoteItemInput[];
};

export const QUOTE_TITLE_MAX = 200;
export const QUOTE_NOTES_MAX = 10_000;
export const QUOTE_DESCRIPTION_MAX = 5_000;
export const QUOTE_ITEMS_MAX = 50;
const MAX_CENTS = 2_147_483_647;
const NAME_MAX = 120;
const EMAIL_MAX = 254;

const uuid = z.uuid();
const isOwner = (actor: TeamSession) => actor.user.role === "owner";

type Site1 = { name: string; url?: string };

/** One "new site" shortcut: a name and an optional address; null when malformed. */
function cleanNewSite(raw: unknown): Site1 | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, url } = raw as { name?: unknown; url?: unknown };
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX) return null;
  if (url === undefined || url === null || url === "") return { name: trimmed };
  if (typeof url !== "string") return null;
  const normalized = normalizeSiteUrl(url);
  if (!normalized.ok || !normalized.value) return null;
  return { name: trimmed, url: normalized.value };
}

/**
 * Normalizes an item's config. `siteIds` carries the ids found in `siteId`/`siteIds` so the caller
 * can check them against the client. Hours settings only exist on support items and follow the
 * support form: outside the package there is nothing to include or charge.
 */
function cleanConfig(kind: QuoteItemKind, raw: QuoteItemConfig): Result<{ config: QuoteItemConfig; siteRefs: string[] }> {
  const input: QuoteItemConfig = raw && typeof raw === "object" ? raw : {};
  const config: QuoteItemConfig = {};
  const siteRefs: string[] = [];

  if (input.siteId !== undefined) {
    if (typeof input.siteId !== "string" || !uuid.safeParse(input.siteId).success) return fail("invalidSite");
    config.siteId = input.siteId;
    siteRefs.push(input.siteId);
  }
  if (input.siteIds !== undefined) {
    if (!Array.isArray(input.siteIds) || input.siteIds.length > QUOTE_ITEMS_MAX) return fail("invalidSite");
    for (const id of input.siteIds) {
      if (typeof id !== "string" || !uuid.safeParse(id).success) return fail("invalidSite");
    }
    config.siteIds = [...new Set(input.siteIds)];
    siteRefs.push(...config.siteIds);
  }
  if (input.newSite !== undefined) {
    const site = cleanNewSite(input.newSite);
    if (!site) return fail("required");
    config.newSite = site;
  }
  if (input.newSites !== undefined) {
    if (!Array.isArray(input.newSites) || input.newSites.length > QUOTE_ITEMS_MAX) return fail("required");
    const list: Site1[] = [];
    for (const s of input.newSites) {
      const site = cleanNewSite(s);
      if (!site) return fail("required");
      list.push(site);
    }
    config.newSites = list;
  }

  if (kind === "support") {
    const mode = input.hoursMode ?? "off";
    if (mode !== "off" && mode !== "internal" && mode !== "package") return fail("required");
    const minutes = input.includedMinutes ?? 0;
    const extra = input.extraHourCents ?? null;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 100_000) return fail("required");
    if (extra !== null && (!Number.isInteger(extra) || extra < 0 || extra > MAX_CENTS)) return fail("required");
    config.hoursMode = mode;
    config.includedMinutes = mode === "package" ? minutes : 0;
    config.extraHourCents = mode === "package" ? extra : null;
  }
  return ok({ config, siteRefs });
}

const text = z.string().trim();
/** The shape of a save request; limits and meaning are checked after, so each case keeps its own error code. */
const saveShape = z.object({
  quoteId: z.string().optional(),
  clientId: z.string().nullable(),
  prospectName: text.nullish(),
  prospectEmail: text.nullish(),
  title: text,
  notes: text.nullish(),
  items: z.array(
    z.object({
      kind: z.enum(["site_creation", "maintenance", "support"]),
      title: text,
      description: text.nullish(),
      amountCents: z.number(),
      config: z.record(z.string(), z.unknown()),
    }),
  ),
});

/**
 * Creates a quote, or replaces the one in `quoteId` (draft or sent only: fields and items are
 * rewritten in one transaction). The currency is the agency's at creation and never changes.
 */
export async function saveQuote(actor: TeamSession, rawInput: QuoteInput, deps: Deps = {}): Promise<Result<{ id: string }>> {
  if (!isOwner(actor)) return fail("forbidden");
  const db = deps.db ?? appDb;
  // Forged payloads (wrong types) are a plain "required", never an exception.
  const shape = saveShape.safeParse(rawInput);
  if (!shape.success) return fail("required");
  const input = shape.data;
  if (input.quoteId !== undefined && !uuid.safeParse(input.quoteId).success) return fail("notFound");

  const title = input.title;
  if (!title) return fail("required");
  const notes = input.notes ?? "";
  if (title.length > QUOTE_TITLE_MAX || notes.length > QUOTE_NOTES_MAX) return fail("tooLong");
  const rawItems = input.items;
  if (rawItems.length === 0) return fail("quoteNeedsItems");
  if (rawItems.length > QUOTE_ITEMS_MAX) return fail("tooLong");

  const isProspect = input.clientId === null;
  let prospectName: string | null = null;
  let prospectEmail: string | null = null;
  if (isProspect) {
    prospectName = input.prospectName ?? "";
    if (!prospectName) return fail("quoteNeedsClient");
    if (prospectName.length > NAME_MAX) return fail("tooLong");
    const email = (input.prospectEmail ?? "").toLowerCase();
    if (email) {
      if (email.length > EMAIL_MAX || !z.email().safeParse(email).success) return fail("invalidEmail");
      prospectEmail = email;
    }
  } else if (!uuid.safeParse(input.clientId).success) {
    return fail("quoteNeedsClient");
  }

  const items: {
    kind: QuoteItemKind;
    title: string;
    description: string | null;
    monthly: boolean;
    amountCents: number;
    config: QuoteItemConfig;
  }[] = [];
  const siteRefs = new Set<string>();
  for (const item of rawItems) {
        const itemTitle = item.title;
    if (!itemTitle) return fail("required");
    const description = item.description ?? "";
    if (itemTitle.length > QUOTE_TITLE_MAX || description.length > QUOTE_DESCRIPTION_MAX) return fail("tooLong");
    if (!Number.isInteger(item.amountCents) || item.amountCents < 0 || item.amountCents > MAX_CENTS) return fail("required");
    const cleaned = cleanConfig(item.kind, item.config as QuoteItemConfig);
    if (!cleaned.ok) return cleaned;
    for (const ref of cleaned.value.siteRefs) siteRefs.add(ref);
    items.push({
      kind: item.kind,
      title: itemTitle,
      description: description || null,
      monthly: item.kind === "support",
      amountCents: item.amountCents,
      config: cleaned.value.config,
    });
  }
  // A prospect has no sites yet: only "new site" shortcuts make sense.
  if (isProspect && siteRefs.size > 0) return fail("invalidSite");

  return transact(db, async (tx) => {
    if (input.clientId !== null) {
      const [client] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, input.clientId));
      if (!client) throw new Abort("quoteNeedsClient");
      if (siteRefs.size > 0) {
        const own = await tx
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.clientId, input.clientId), inArray(sites.id, [...siteRefs])));
        if (own.length !== siteRefs.size) throw new Abort("invalidSite");
      }
    }

    const fields = {
      clientId: input.clientId,
      prospectName,
      prospectEmail,
      title,
      notes: notes || null,
      updatedAt: new Date(),
    };
    let id: string;
    if (input.quoteId === undefined) {
      const [brand] = await tx.select({ currency: agency.currency }).from(agency).limit(1);
      if (!brand) throw new Abort("notFound");
      const [row] = await tx
        .insert(quotes)
        .values({ ...fields, token: newQuoteToken(), currency: brand.currency, createdById: actor.user.id })
        .returning({ id: quotes.id });
      id = row.id;
    } else {
      const [existing] = await tx.select().from(quotes).where(eq(quotes.id, input.quoteId)).for("update");
      if (!existing) throw new Abort("notFound");
      if (existing.status === "executed") throw new Abort("quoteExecuted");
      if (existing.status !== "draft" && existing.status !== "sent") throw new Abort("quoteLocked");
      await tx.update(quotes).set(fields).where(eq(quotes.id, existing.id));
      await tx.delete(quoteItems).where(eq(quoteItems.quoteId, existing.id));
      id = existing.id;
    }
    await tx.insert(quoteItems).values(items.map((item, position) => ({ ...item, quoteId: id, position })));
    return { id };
  });
}

type Recipient = { to: string; name: string; locale: string | null };

/** Who gets the "quote sent" e-mail, or null: prospect e-mail; client e-mail; else the first active portal admin. */
async function resolveRecipient(db: Db, quote: Quote): Promise<Recipient | null> {
  const lookupLocale = async (email: string): Promise<string | null> => {
    const [person] = await db.select({ locale: clientUsers.locale }).from(clientUsers).where(eq(clientUsers.email, email));
    return person?.locale ?? null;
  };
  if (!quote.clientId) {
    const to = quote.prospectEmail?.trim();
    return to ? { to, name: quote.prospectName ?? "", locale: await lookupLocale(to.toLowerCase()) } : null;
  }
  const [client] = await db.select().from(clients).where(eq(clients.id, quote.clientId));
  if (!client) return null;
  const direct = client.email?.trim();
  if (direct) return { to: direct, name: client.name, locale: await lookupLocale(direct.toLowerCase()) };
  const [admin] = await db
    .select({ email: clientUsers.email, locale: clientUsers.locale })
    .from(clientMemberships)
    .innerJoin(clientUsers, eq(clientUsers.id, clientMemberships.clientUserId))
    .where(
      and(
        eq(clientMemberships.clientId, client.id),
        eq(clientMemberships.role, "admin"),
        isNotNull(clientUsers.passwordHash),
      ),
    )
    .orderBy(asc(clientMemberships.createdAt), asc(clientUsers.id))
    .limit(1);
  return admin ? { to: admin.email, name: client.name, locale: admin.locale } : null;
}

/**
 * Marks the quote as sent (draft or sent; `sentAt` keeps its first date) and e-mails the public
 * link to the client or prospect in the recipient's language. `emailedTo` is null when nobody
 * could be e-mailed or the mail was not sent (for instance, no SMTP): the quote is sent either way.
 */
export async function sendQuote(
  actor: TeamSession,
  quoteId: string,
  deps: Deps = {},
): Promise<Result<{ emailedTo: string | null }>> {
  if (!isOwner(actor)) return fail("forbidden");
  if (!uuid.safeParse(quoteId).success) return fail("notFound");
  const db = deps.db ?? appDb;
  const send = deps.send ?? sendMail;

  const marked = await transact(db, async (tx) => {
    const [quote] = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).for("update");
    if (!quote) throw new Abort("notFound");
    if (quote.status === "executed") throw new Abort("quoteExecuted");
    if (quote.status !== "draft" && quote.status !== "sent") throw new Abort("quoteLocked");
    const now = new Date();
    // A resend changes nothing on the quote: keep `updatedAt`, so pages clients have open do not go stale.
    const [row] = await tx
      .update(quotes)
      .set({ status: "sent", sentAt: quote.sentAt ?? now, ...(quote.status === "draft" ? { updatedAt: now } : {}) })
      .where(eq(quotes.id, quoteId))
      .returning();
    return row;
  });
  if (!marked.ok) return marked;

  // The mail is a courtesy, sent after the commit: whatever goes wrong, the quote stays sent.
  let emailedTo: string | null = null;
  try {
    const recipient = await resolveRecipient(db, marked.value);
    if (recipient) {
      const [brand] = await db.select().from(agency).limit(1);
      const locale = isLocale(recipient.locale) ? recipient.locale : isLocale(brand?.locale) ? brand.locale : "en";
      const dict = await getDict(locale);
      const msg = buildQuoteSentMail(dict.quotes.sentMail, {
        to: recipient.to,
        name: recipient.name,
        agencyName: brand?.name ?? "Velk Express",
        logoUrl: await logoAbsoluteUrl(brand?.logoFileId ?? null),
        title: marked.value.title,
        link: `${await getAppUrl()}/q/${marked.value.token}`,
      });
      if ((await send(msg)).sent) emailedTo = recipient.to;
    }
  } catch (err) {
    console.error("[mail] quote-sent notice failed:", err instanceof Error ? err.message : err);
  }
  return ok({ emailedTo });
}

/** Archives a quote in any status but executed. Already archived is a no-op (`changed: false`). */
export async function archiveQuote(actor: TeamSession, quoteId: string, deps: Deps = {}): Promise<Result<{ changed: boolean }>> {
  if (!isOwner(actor)) return fail("forbidden");
  if (!uuid.safeParse(quoteId).success) return fail("notFound");
  return transact(deps.db ?? appDb, async (tx) => {
    const [quote] = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).for("update");
    if (!quote) throw new Abort("notFound");
    if (quote.status === "executed") throw new Abort("quoteExecuted");
    if (quote.status === "archived") return { changed: false };
    await tx.update(quotes).set({ status: "archived", updatedAt: new Date() }).where(eq(quotes.id, quoteId));
    return { changed: true };
  });
}

/** Deletes a draft (its items go with it). An executed quote is `quoteExecuted`, a sent one `quoteSent`; any other status is `quoteLocked`. */
export async function deleteQuote(actor: TeamSession, quoteId: string, deps: Deps = {}): Promise<Result> {
  if (!isOwner(actor)) return fail("forbidden");
  if (!uuid.safeParse(quoteId).success) return fail("notFound");
  const res = await transact(deps.db ?? appDb, async (tx) => {
    const [quote] = await tx.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)).for("update");
    if (!quote) throw new Abort("notFound");
    if (quote.status === "executed") throw new Abort("quoteExecuted");
    if (quote.status === "sent") throw new Abort("quoteSent");
    if (quote.status !== "draft") throw new Abort("quoteLocked");
    await tx.delete(quotes).where(eq(quotes.id, quoteId));
  });
  return res.ok ? ok() : res;
}

export type QuoteRow = Quote & {
  clientName: string | null;
  oneTimeCents: number;
  monthlyCents: number;
};

export const QUOTES_PER_PAGE = 50;

/** One page of quotes (50), newest first, with the client name and the totals, and how many there are in all. Owner only. */
export async function listQuotes(
  actor: TeamSession,
  deps: Deps = {},
  page = 1,
): Promise<Result<{ rows: QuoteRow[]; total: number }>> {
  if (!isOwner(actor)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const pageNumber = Number.isSafeInteger(page) && page > 1 ? page : 1;
  const [{ total }] = await db.select({ total: count() }).from(quotes);
  const rows = await db
    .select({ quote: quotes, clientName: clients.name })
    .from(quotes)
    .leftJoin(clients, eq(clients.id, quotes.clientId))
    .orderBy(desc(quotes.createdAt), desc(quotes.id))
    .limit(QUOTES_PER_PAGE)
    .offset((pageNumber - 1) * QUOTES_PER_PAGE);
  if (rows.length === 0) return ok({ rows: [], total });
  const sums = await db
    .select({
      quoteId: quoteItems.quoteId,
      monthly: quoteItems.monthly,
      cents: sql<number>`coalesce(sum(${quoteItems.amountCents}), 0)::int`,
    })
    .from(quoteItems)
    .where(inArray(quoteItems.quoteId, rows.map((r) => r.quote.id)))
    .groupBy(quoteItems.quoteId, quoteItems.monthly);
  const byQuote = new Map<string, { monthly: boolean; amountCents: number }[]>();
  for (const s of sums) {
    const list = byQuote.get(s.quoteId) ?? [];
    list.push({ monthly: s.monthly, amountCents: s.cents });
    byQuote.set(s.quoteId, list);
  }
  return ok({
    rows: rows.map((r) => ({ ...r.quote, clientName: r.clientName, ...quoteTotals(byQuote.get(r.quote.id) ?? []) })),
    total,
  });
}

export type QuoteDetail = {
  quote: Quote;
  items: QuoteItem[];
  client: Pick<Client, "id" | "name"> | null;
  /** The client's sites, for the shortcuts; empty for a prospect. */
  sites: Site[];
  totals: { oneTimeCents: number; monthlyCents: number };
};

/** One quote with its items (in order), its client and that client's sites. Owner only. */
export async function getQuote(actor: TeamSession, quoteId: string, deps: Deps = {}): Promise<Result<QuoteDetail>> {
  if (!isOwner(actor)) return fail("forbidden");
  if (!uuid.safeParse(quoteId).success) return fail("notFound");
  const db = deps.db ?? appDb;
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
  if (!quote) return fail("notFound");
  const items = await db
    .select()
    .from(quoteItems)
    .where(eq(quoteItems.quoteId, quote.id))
    .orderBy(asc(quoteItems.position), asc(quoteItems.id));
  let client: QuoteDetail["client"] = null;
  let clientSites: Site[] = [];
  if (quote.clientId) {
    const [row] = await db.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.id, quote.clientId));
    client = row ?? null;
    clientSites = await db
      .select()
      .from(sites)
      .where(eq(sites.clientId, quote.clientId))
      .orderBy(asc(sites.createdAt), asc(sites.id));
  }
  return ok({ quote, items, client, sites: clientSites, totals: quoteTotals(items) });
}
