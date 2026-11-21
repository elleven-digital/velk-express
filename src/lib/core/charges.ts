import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import { isStaff } from "@/lib/access";
import { DOCUMENT_MAX_BYTES, DOCUMENT_MIMES } from "@/lib/attachments";
import { getAppUrl } from "@/lib/app-url";
import type { TeamSession } from "@/lib/auth/session";
import {
  agency,
  charges,
  clients,
  db as appDb,
  files,
  hourPurchases,
  quoteItems,
  quotes,
  tickets,
  type Charge,
  type ChargeKind,
  type ChargeSource,
  type ChargeStatus,
  type Db,
  type FileRow,
} from "@/lib/db";
import { formatMinutes } from "@/lib/format";
import { fmt, getDict, isLocale, type Locale } from "@/lib/i18n";
import { getProviders, type PaymentProvider, type ProviderName, type WebhookEvent } from "@/lib/payments";
import type { CheckoutCurrency } from "@/lib/payments/types";
import { decidedTotals } from "@/lib/quote-utils";
import { getStorage, type Storage } from "@/lib/storage";
import { applyEffect } from "./charge-state";
import { fail, ok, type Result } from "./result";
import { Abort, transact } from "./tx";

/**
 * Charges: one amount to collect, from a ticket, the support plan, an hour purchase, a quote or
 * nothing. Staff (owner and manager) run them; a quote's charge is the owner's; collaborators never
 * see money. A charge is a record first: with no provider it is settled by "mark as paid"; with one,
 * the client pays through `/pay/[token]` and only the provider's webhook confirms it.
 *
 * One live or paid charge per source is enforced by partial unique indexes; a conflict is
 * `chargeExists`. Lock order (global): agency, quote, portal company, client, client_users, users,
 * ticket, then charge. Webhooks lock only the charge, then what it releases (the hour purchase).
 */

/** Test seams: the database, the configured providers (the environment's by default) and storage. */
export type ChargeDeps = {
  db?: Db;
  providers?: PaymentProvider[] | (() => PaymentProvider[]);
  storage?: Storage;
};

export type ChargeInput = {
  source: ChargeSource;
  /** The ticket, client (support), hour purchase or quote; unused for "none". */
  sourceId?: string;
  /** Only for "none" (support also accepts it in place of `sourceId`). */
  clientId?: string;
  /** Only for "none": the other sources build their own. */
  label?: string;
  /** Only for "none": the other sources take theirs from the source. */
  amountCents?: number;
  /** Only for "none" (one-time by default): support is always monthly, the rest one-time. */
  kind?: ChargeKind;
  /** Null records the charge without a provider (settled by "mark as paid"). */
  provider: ProviderName | null;
};

/** A charge as the screens show it. Dates are ISO instants. */
export type ChargeView = {
  id: string;
  source: ChargeSource;
  kind: ChargeKind;
  status: ChargeStatus;
  provider: ProviderName | null;
  label: string;
  amountCents: number;
  currency: string;
  clientId: string | null;
  clientName: string | null;
  ticketId: string | null;
  hourPurchaseId: string | null;
  quoteId: string | null;
  document: { id: string; name: string } | null;
  payUrl: string;
  paidAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  /** Whether the viewer may cancel, mark as paid or attach a document (a quote's charge is the owner's). */
  canAct: boolean;
};

const uuid = z.uuid();
const MAX_CENTS = 2_147_483_647;
const LABEL_MAX = 200;
const SOURCES: readonly ChargeSource[] = ["ticket", "support", "hours", "quote", "none"];
const KINDS: readonly ChargeKind[] = ["one_time", "subscription"];
const STATUSES: readonly ChargeStatus[] = ["pending", "paid", "active", "past_due", "canceled"];
const PROVIDER_ORDER: readonly ProviderName[] = ["stripe", "mercadopago"];
const CHARGEABLE_QUOTE = new Set(["sent", "accepted", "executed"]);
const LIVE_INDEXES = new Set([
  "charges_ticket_live_idx",
  "charges_hour_purchase_live_idx",
  "charges_quote_live_idx",
  "charges_support_live_idx",
]);

/** The fiscal document: PDF or image, up to 8 MB, uploaded by staff under `documents/`. */
export { DOCUMENT_MAX_BYTES, DOCUMENT_MIMES };

const isOwner = (actor: TeamSession) => actor.user.role === "owner";

/** Staff acts on charges; a quote's charge (even once its quote is gone) is the owner's. */
function canActOn(actor: TeamSession, source: ChargeSource): boolean {
  return source === "quote" ? isOwner(actor) : isStaff(actor.user);
}

/** The secret of a charge's payment link: 24 random bytes, URL-safe. */
export function newPayToken(): string {
  return randomBytes(24).toString("base64url");
}

export function payUrlFor(appUrl: string, payToken: string): string {
  return `${appUrl}/pay/${payToken}`;
}

export function providersOf(deps: Pick<ChargeDeps, "providers">): PaymentProvider[] {
  const p = deps.providers;
  return typeof p === "function" ? p() : (p ?? getProviders());
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | null;
  return { code: e?.code ?? e?.cause?.code, constraint: e?.constraint_name ?? e?.cause?.constraint_name };
}

/** A second live or paid charge for the same source. */
export function isLiveChargeConflict(err: unknown): boolean {
  const { code, constraint } = pgError(err);
  return code === "23505" && LIVE_INDEXES.has(constraint ?? "");
}

/** What a provider error may say in a log: its class and code, never its message (it can carry keys or bodies). */
export function errorTag(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const { code, status, statusCode, type } = err as { code?: unknown; status?: unknown; statusCode?: unknown; type?: unknown };
  // Stripe's errors keep the name "Error" and carry their class in `type` and the HTTP status in `statusCode`.
  const parts = [err.name === "Error" && typeof type === "string" && /^\w+$/.test(type) ? type : err.name];
  if (typeof code === "string" || typeof code === "number") parts.push(`code ${code}`);
  const httpStatus = typeof status === "number" ? status : statusCode;
  if (typeof httpStatus === "number") parts.push(`status ${httpStatus}`);
  return parts.join(", ");
}

async function bestEffort(what: string, provider: ProviderName, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`[charges] ${what} failed at ${provider}:`, errorTag(err));
  }
}

/**
 * The providers that can take a charge, in a fixed order, then null (the manual record, always
 * offered). Mercado Pago takes BRL only, and a monthly charge only with the payer's e-mail.
 */
export function availableProviders(
  charge: { currency: string; kind: ChargeKind; clientEmail: string | null },
  deps: Pick<ChargeDeps, "providers"> = {},
): (ProviderName | null)[] {
  const offered = new Set(
    providersOf(deps)
      .filter((p) => p.supports({ currency: charge.currency as CheckoutCurrency, kind: charge.kind, payerEmail: charge.clientEmail }))
      .map((p) => p.name),
  );
  return [...PROVIDER_ORDER.filter((name) => offered.has(name)), null];
}

export type NewCharge = {
  source: ChargeSource;
  kind: ChargeKind;
  provider: ProviderName | null;
  clientId: string | null;
  label: string;
  amountCents: number;
  currency: string;
  ticketId?: string | null;
  hourPurchaseId?: string | null;
  quoteId?: string | null;
  createdById: string | null;
};

/**
 * Inserts a pending charge with a fresh pay token inside the caller's transaction. A second live
 * charge for the source aborts with `chargeExists`; a source deleted meanwhile with `notFound`.
 */
export async function insertCharge(tx: Db, values: NewCharge): Promise<{ id: string; payToken: string }> {
  const payToken = newPayToken();
  try {
    const [row] = await tx
      .insert(charges)
      .values({ ...values, status: "pending", payToken })
      .returning({ id: charges.id });
    return { id: row.id, payToken };
  } catch (err) {
    if (isLiveChargeConflict(err)) throw new Abort("chargeExists");
    if (pgError(err).code === "23503") throw new Abort("notFound");
    throw err;
  }
}

/** Whether a live or paid charge matches the condition. */
async function hasLive(tx: Db, where: SQL): Promise<boolean> {
  const [row] = await tx
    .select({ id: charges.id })
    .from(charges)
    .where(and(where, ne(charges.status, "canceled")))
    .limit(1);
  return Boolean(row);
}

async function quoteOfItem(tx: Db, itemId: string): Promise<string | null> {
  const [row] = await tx.select({ quoteId: quoteItems.quoteId }).from(quoteItems).where(eq(quoteItems.id, itemId));
  return row?.quoteId ?? null;
}

async function clientEmail(tx: Db, clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  const [row] = await tx.select({ email: clients.email }).from(clients).where(eq(clients.id, clientId));
  return row?.email ?? null;
}

/** Control characters and runs of whitespace collapse to single spaces. */
const cleanText = (raw: unknown) => (typeof raw === "string" ? raw.replace(/[\p{Cc}\s]+/gu, " ").trim() : "");

type Target = Omit<NewCharge, "source" | "provider" | "createdById"> & { payerEmail: string | null };
type Context = { currency: string; locale: Locale };

function sourceIdOf(raw: string | undefined): string {
  if (!raw) throw new Abort("required");
  if (!uuid.safeParse(raw).success) throw new Abort("notFound");
  return raw;
}

async function ticketTarget(tx: Db, rawId: string | undefined, ctx: Context): Promise<Target> {
  const id = sourceIdOf(rawId);
  const [plain] = await tx.select({ quoteItemId: tickets.quoteItemId }).from(tickets).where(eq(tickets.id, id));
  if (!plain) throw new Abort("notFound");
  // The quote before the ticket (global order). Both sides of the double-billing check lock it,
  // so a quote charge and a charge for one of its tickets cannot be created at the same time.
  const lockedQuote = plain.quoteItemId ? await quoteOfItem(tx, plain.quoteItemId) : null;
  if (lockedQuote) await tx.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, lockedQuote)).for("update");
  // Key share: blocks a value change (which locks the ticket for update) but not new messages.
  const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, id)).for("key share");
  if (!ticket) throw new Abort("notFound");
  if (ticket.type !== "single" || !ticket.valueCents || ticket.valueCents <= 0) throw new Abort("nothingToCharge");
  if (await hasLive(tx, eq(charges.ticketId, ticket.id))) throw new Abort("chargeExists");
  const quoteId = ticket.quoteItemId === plain.quoteItemId ? lockedQuote : ticket.quoteItemId ? await quoteOfItem(tx, ticket.quoteItemId) : null;
  if (quoteId && (await hasLive(tx, eq(charges.quoteId, quoteId)))) throw new Abort("billedOnQuote");
  return {
    clientId: ticket.clientId,
    kind: "one_time",
    label: `#${ticket.number} ${ticket.title}`,
    amountCents: ticket.valueCents,
    currency: ctx.currency,
    ticketId: ticket.id,
    payerEmail: await clientEmail(tx, ticket.clientId),
  };
}

async function supportTarget(tx: Db, rawId: string | undefined, ctx: Context): Promise<Target> {
  const id = sourceIdOf(rawId);
  const [client] = await tx.select().from(clients).where(eq(clients.id, id));
  if (!client) throw new Abort("notFound");
  if (!client.supportActive || !client.supportMonthlyCents || client.supportMonthlyCents <= 0) throw new Abort("nothingToCharge");
  if (await hasLive(tx, and(eq(charges.clientId, client.id), eq(charges.source, "support")) as SQL)) throw new Abort("chargeExists");
  const t = await getDict(ctx.locale);
  return {
    clientId: client.id,
    kind: "subscription",
    label: fmt(t.charges.supportLabel, { name: client.name }),
    amountCents: client.supportMonthlyCents,
    currency: ctx.currency,
    payerEmail: client.email,
  };
}

async function hoursTarget(tx: Db, rawId: string | undefined, ctx: Context): Promise<Target> {
  const id = sourceIdOf(rawId);
  // Key share: a concurrent delete waits for this charge and then sees it.
  const [purchase] = await tx.select().from(hourPurchases).where(eq(hourPurchases.id, id)).for("key share");
  if (!purchase) throw new Abort("notFound");
  if (!purchase.priceCents || purchase.priceCents <= 0) throw new Abort("nothingToCharge");
  if (await hasLive(tx, eq(charges.hourPurchaseId, purchase.id))) throw new Abort("chargeExists");
  const t = await getDict(ctx.locale);
  return {
    clientId: purchase.clientId,
    kind: "one_time",
    label: fmt(t.charges.purchaseLabel, { minutes: formatMinutes(purchase.minutes), cycle: purchase.cycle }),
    amountCents: purchase.priceCents,
    currency: ctx.currency,
    hourPurchaseId: purchase.id,
    payerEmail: await clientEmail(tx, purchase.clientId),
  };
}

async function quoteTarget(tx: Db, rawId: string | undefined): Promise<Target> {
  const id = sourceIdOf(rawId);
  // A second click, the execution and the tickets' charges all wait here.
  const [quote] = await tx.select().from(quotes).where(eq(quotes.id, id)).for("update");
  if (!quote) throw new Abort("notFound");
  if (!CHARGEABLE_QUOTE.has(quote.status)) throw new Abort("nothingToCharge");
  if (await hasLive(tx, eq(charges.quoteId, quote.id))) throw new Abort("chargeExists");
  const items = await tx
    .select({
      monthly: quoteItems.monthly,
      amountCents: quoteItems.amountCents,
      clientApproved: quoteItems.clientApproved,
      executed: quoteItems.executed,
    })
    .from(quoteItems)
    .where(eq(quoteItems.quoteId, quote.id));
  const amountCents = decidedTotals(quote.status, items).oneTimeCents;
  if (amountCents <= 0) throw new Abort("nothingToCharge");
  const [billedTicket] = await tx
    .select({ id: charges.id })
    .from(charges)
    .innerJoin(tickets, eq(tickets.id, charges.ticketId))
    .innerJoin(quoteItems, eq(quoteItems.id, tickets.quoteItemId))
    .where(and(eq(quoteItems.quoteId, quote.id), ne(charges.status, "canceled")))
    .limit(1);
  if (billedTicket) throw new Abort("billedOnTickets");
  return {
    clientId: quote.clientId,
    kind: "one_time",
    label: quote.title,
    amountCents,
    // The quote's own currency: its values were written in it.
    currency: quote.currency,
    quoteId: quote.id,
    payerEmail: (await clientEmail(tx, quote.clientId)) ?? quote.prospectEmail ?? null,
  };
}

async function freeTarget(tx: Db, input: ChargeInput, ctx: Context): Promise<Target> {
  const label = cleanText(input.label);
  if (!input.clientId || !label || input.amountCents === undefined || input.amountCents === null) throw new Abort("required");
  if (label.length > LABEL_MAX) throw new Abort("tooLong");
  const amount = input.amountCents;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CENTS) throw new Abort("invalidAmount");
  const kind = input.kind ?? "one_time";
  if (!KINDS.includes(kind)) throw new Abort("invalid");
  const clientId = sourceIdOf(input.clientId);
  const [client] = await tx.select({ id: clients.id, email: clients.email }).from(clients).where(eq(clients.id, clientId));
  if (!client) throw new Abort("notFound");
  return { clientId: client.id, kind, label, amountCents: amount, currency: ctx.currency, payerEmail: client.email };
}

/**
 * Creates a charge from its source, with the amount as it is now (a snapshot):
 * - ticket: its value (single tickets only), "#N title";
 * - support: the client's monthly fee, always monthly;
 * - hours: the purchase's price;
 * - quote: its one-time items by `decidedTotals` (sent, accepted or executed), in the quote's currency;
 * - none: the typed amount, label and kind, for a client.
 * Labels are in the creator's language; the currency is the agency's (the quote's for a quote).
 * A ticket born from a quote whose charge is live or paid is `billedOnQuote`, and the other way
 * round `billedOnTickets`. A named provider must be configured and take this charge.
 */
export async function createCharge(
  actor: TeamSession,
  input: ChargeInput,
  deps: ChargeDeps = {},
): Promise<Result<{ id: string; payUrl: string }>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const source = input?.source;
  if (!SOURCES.includes(source)) return fail("required");
  if (source === "quote" && !isOwner(actor)) return fail("forbidden");
  const provider = input.provider ?? null;
  if (provider !== null && !PROVIDER_ORDER.includes(provider)) return fail("providerUnavailable");
  const db = deps.db ?? appDb;
  const appUrl = await getAppUrl();

  const res = await transact(db, async (tx) => {
    const [brand] = await tx.select({ currency: agency.currency, locale: agency.locale }).from(agency).where(eq(agency.id, 1));
    if (!brand) throw new Abort("notFound");
    const locale: Locale = isLocale(actor.user.locale) ? actor.user.locale : isLocale(brand.locale) ? brand.locale : "en";
    const ctx = { currency: brand.currency, locale };
    const target =
      source === "ticket"
        ? await ticketTarget(tx, input.sourceId, ctx)
        : source === "support"
          ? await supportTarget(tx, input.sourceId ?? input.clientId, ctx)
          : source === "hours"
            ? await hoursTarget(tx, input.sourceId, ctx)
            : source === "quote"
              ? await quoteTarget(tx, input.sourceId)
              : await freeTarget(tx, input, ctx);
    if (provider) {
      const offered = availableProviders({ currency: target.currency, kind: target.kind, clientEmail: target.payerEmail }, deps);
      if (!offered.includes(provider)) throw new Abort("providerUnavailable");
    }
    return insertCharge(tx, {
      source,
      kind: target.kind,
      provider,
      clientId: target.clientId,
      label: target.label,
      amountCents: target.amountCents,
      currency: target.currency,
      ticketId: target.ticketId ?? null,
      hourPurchaseId: target.hourPurchaseId ?? null,
      quoteId: target.quoteId ?? null,
      createdById: actor.user.id,
    });
  });
  if (!res.ok) return res;
  return ok({ id: res.value.id, payUrl: payUrlFor(appUrl, res.value.payToken) });
}

/** Locks a charge the actor may act on: `notFound` for a bad or unknown id, `forbidden` for a manager on a quote's. */
async function lockCharge(tx: Db, actor: TeamSession, chargeId: string): Promise<Charge> {
  if (!uuid.safeParse(chargeId).success) throw new Abort("notFound");
  const [charge] = await tx.select().from(charges).where(eq(charges.id, chargeId)).for("update");
  if (!charge) throw new Abort("notFound");
  if (!canActOn(actor, charge.source)) throw new Abort("forbidden");
  return charge;
}

async function releasePurchase(tx: Db, purchaseId: string): Promise<void> {
  await tx.update(hourPurchases).set({ pending: false }).where(eq(hourPurchases.id, purchaseId));
}

function configured(name: ProviderName, deps: ChargeDeps): PaymentProvider | null {
  const provider = providersOf(deps).find((p) => p.name === name) ?? null;
  if (!provider) console.error(`[charges] ${name} is not configured: nothing was closed there.`);
  return provider;
}

/** Closes the last open checkout, so the charge cannot be paid again (best effort, after the commit). */
export async function expireOpenCheckout(charge: Charge, deps: ChargeDeps): Promise<void> {
  if (!charge.provider || !charge.externalCheckoutId) return;
  const provider = configured(charge.provider, deps);
  const checkoutId = charge.externalCheckoutId;
  if (provider) await bestEffort("expiring a checkout", provider.name, () => provider.expireCheckout(checkoutId));
}

/**
 * Records a one-time pending charge as paid outside the provider (Pix, transfer, cash): `paid_at`
 * is now and an hour purchase waiting for it enters the balance. Anything else is `chargeNotPending`.
 */
export async function markChargePaid(actor: TeamSession, chargeId: string, deps: ChargeDeps = {}): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const res = await transact(deps.db ?? appDb, async (tx) => {
    const charge = await lockCharge(tx, actor, chargeId);
    if (charge.kind !== "one_time" || charge.status !== "pending") throw new Abort("chargeNotPending");
    const now = new Date();
    await tx.update(charges).set({ status: "paid", paidAt: now, updatedAt: now }).where(eq(charges.id, charge.id));
    if (charge.hourPurchaseId) await releasePurchase(tx, charge.hourPurchaseId);
    return charge;
  });
  if (!res.ok) return res;
  await expireOpenCheckout(res.value, deps);
  return ok();
}

/**
 * Cancels a live charge: a paid one is `alreadyPaid`, a canceled one changes nothing. An hour
 * purchase still waiting for this payment is deleted. After the commit, the provider's subscription
 * is canceled and the open checkout expired (best effort, logged).
 */
export async function cancelCharge(
  actor: TeamSession,
  chargeId: string,
  deps: ChargeDeps = {},
): Promise<Result<{ changed: boolean }>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const res = await transact(deps.db ?? appDb, async (tx) => {
    const charge = await lockCharge(tx, actor, chargeId);
    if (charge.status === "canceled") return { charge, changed: false };
    if (charge.status === "paid") throw new Abort("alreadyPaid");
    const now = new Date();
    await tx.update(charges).set({ status: "canceled", canceledAt: now, updatedAt: now }).where(eq(charges.id, charge.id));
    // Charge, then purchase: the order webhooks use. A manual purchase (already counted) stays.
    if (charge.hourPurchaseId) {
      await tx.delete(hourPurchases).where(and(eq(hourPurchases.id, charge.hourPurchaseId), eq(hourPurchases.pending, true)));
    }
    return { charge, changed: true };
  });
  if (!res.ok) return res;
  const { charge, changed } = res.value;
  if (changed && charge.provider) {
    const subscriptionId = charge.kind === "subscription" ? charge.externalSubscriptionId : null;
    if (subscriptionId) {
      const provider = configured(charge.provider, deps);
      if (provider) await bestEffort("canceling a subscription", provider.name, () => provider.cancelSubscription(subscriptionId));
    }
    await expireOpenCheckout(charge, deps);
  }
  return ok({ changed });
}

function isDocument(file: FileRow): boolean {
  return (
    file.storageKey.startsWith("documents/") &&
    file.uploadedByType === "agency" &&
    file.ticketId === null &&
    file.messageId === null &&
    DOCUMENT_MIMES.includes(file.mime) &&
    file.sizeBytes <= DOCUMENT_MAX_BYTES
  );
}

async function removeStored(deps: ChargeDeps, key: string | null): Promise<void> {
  if (!key) return;
  try {
    await (deps.storage ?? getStorage()).remove(key);
  } catch (err) {
    // An orphaned object is harmless; no row points at it any more.
    console.error("Could not remove a stored file:", err);
  }
}

/**
 * Attaches the fiscal document (a staff upload under `documents/`, PDF or image up to 8 MB, not
 * attached elsewhere) to a charge in any status. The previous document and its object go.
 */
export async function attachChargeDocument(
  actor: TeamSession,
  chargeId: string,
  fileId: string,
  deps: ChargeDeps = {},
): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const res = await transact(deps.db ?? appDb, async (tx) => {
    const charge = await lockCharge(tx, actor, chargeId);
    if (!uuid.safeParse(fileId).success) throw new Abort("invalidFile");
    const [file] = await tx.select().from(files).where(eq(files.id, fileId)).for("update");
    if (!file || !isDocument(file)) throw new Abort("invalidFile");
    if (charge.documentFileId === file.id) return null;
    const [taken] = await tx.select({ id: charges.id }).from(charges).where(eq(charges.documentFileId, file.id)).limit(1);
    if (taken) throw new Abort("invalidFile");
    await tx.update(charges).set({ documentFileId: file.id, updatedAt: new Date() }).where(eq(charges.id, charge.id));
    if (!charge.documentFileId) return null;
    const [old] = await tx.delete(files).where(eq(files.id, charge.documentFileId)).returning({ key: files.storageKey });
    return old?.key ?? null;
  });
  if (!res.ok) return res;
  await removeStored(deps, res.value);
  return ok();
}

/** Takes the fiscal document off a charge and deletes it. No document is fine. */
export async function removeChargeDocument(actor: TeamSession, chargeId: string, deps: ChargeDeps = {}): Promise<Result> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const res = await transact(deps.db ?? appDb, async (tx) => {
    const charge = await lockCharge(tx, actor, chargeId);
    if (!charge.documentFileId) return null;
    await tx.update(charges).set({ documentFileId: null, updatedAt: new Date() }).where(eq(charges.id, charge.id));
    const [old] = await tx.delete(files).where(eq(files.id, charge.documentFileId)).returning({ key: files.storageKey });
    return old?.key ?? null;
  });
  if (!res.ok) return res;
  await removeStored(deps, res.value);
  return ok();
}

type ViewRow = { charge: Charge; clientName: string | null; documentName: string | null };

/** The charges matching `where` with what their view needs, newest first. */
function selectViews(db: Db, where: SQL | undefined): Promise<ViewRow[]> {
  return db
    .select({ charge: charges, clientName: clients.name, documentName: files.name })
    .from(charges)
    .leftJoin(clients, eq(clients.id, charges.clientId))
    .leftJoin(files, eq(files.id, charges.documentFileId))
    .where(where)
    .orderBy(desc(charges.createdAt), desc(charges.id));
}

function toView(actor: TeamSession, appUrl: string, { charge: c, clientName, documentName }: ViewRow): ChargeView {
  return {
    id: c.id,
    source: c.source,
    kind: c.kind,
    status: c.status,
    provider: c.provider,
    label: c.label,
    amountCents: c.amountCents,
    currency: c.currency,
    clientId: c.clientId,
    clientName,
    ticketId: c.ticketId,
    hourPurchaseId: c.hourPurchaseId,
    quoteId: c.quoteId,
    document: c.documentFileId && documentName !== null ? { id: c.documentFileId, name: documentName } : null,
    payUrl: payUrlFor(appUrl, c.payToken),
    paidAt: c.paidAt?.toISOString() ?? null,
    canceledAt: c.canceledAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    canAct: canActOn(actor, c.source),
  };
}

/**
 * Every charge, newest first, optionally of one client and in one status. Staff only; quote charges
 * are the owner's (quotes are owner-only), so a manager never sees them.
 */
export async function listCharges(
  actor: TeamSession,
  filter: { clientId?: string; status?: string },
  deps: ChargeDeps = {},
): Promise<Result<ChargeView[]>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const where: SQL[] = [];
  if (!isOwner(actor)) where.push(ne(charges.source, "quote"));
  if (filter.clientId) {
    if (!uuid.safeParse(filter.clientId).success) return ok([]);
    where.push(eq(charges.clientId, filter.clientId));
  }
  if (filter.status) {
    if (!STATUSES.includes(filter.status as ChargeStatus)) return ok([]);
    where.push(eq(charges.status, filter.status as ChargeStatus));
  }
  const rows = await selectViews(db, where.length ? and(...where) : undefined);
  const appUrl = await getAppUrl();
  return ok(rows.map((r) => toView(actor, appUrl, r)));
}

/**
 * One charge, as `listCharges` shows it. Staff only; a quote's charge is the owner's, so for a
 * manager it does not exist (`notFound`), as in the list.
 */
export async function getCharge(actor: TeamSession, chargeId: string, deps: ChargeDeps = {}): Promise<Result<ChargeView>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  if (!uuid.safeParse(chargeId).success) return fail("notFound");
  const db = deps.db ?? appDb;
  const [row] = await selectViews(db, eq(charges.id, chargeId));
  // Who may see a charge is who may act on it: staff, and for a quote's only the owner.
  if (!row || !canActOn(actor, row.charge.source)) return fail("notFound");
  return ok(toView(actor, await getAppUrl(), row));
}

/**
 * The live or paid charge of a source (at most one exists), or null, for the panels. Staff only;
 * a quote's is the owner's. Support takes the client id.
 */
export async function chargeFor(
  actor: TeamSession,
  target: { source: Exclude<ChargeSource, "none">; sourceId: string },
  deps: ChargeDeps = {},
): Promise<Result<ChargeView | null>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  if (target.source === "quote" && !isOwner(actor)) return fail("forbidden");
  if (!uuid.safeParse(target.sourceId).success) return fail("notFound");
  const id = target.sourceId;
  const bySource: Record<string, SQL | undefined> = {
    ticket: eq(charges.ticketId, id),
    hours: eq(charges.hourPurchaseId, id),
    quote: eq(charges.quoteId, id),
    support: and(eq(charges.clientId, id), eq(charges.source, "support")),
  };
  const where = bySource[target.source];
  if (!where) return fail("notFound");
  const db = deps.db ?? appDb;
  const [row] = await selectViews(db, and(where, ne(charges.status, "canceled")));
  if (!row) return ok(null);
  return ok(toView(actor, await getAppUrl(), row));
}

/**
 * Whether a ticket born from a quote is billed on that quote (the quote has a live or paid charge),
 * else null. The ticket panel shows "billed on the quote" instead of its own charge. Only the owner
 * gets the quote's id and title: quotes are owner-only, so a manager learns just the fact.
 */
export async function ticketBilledOnQuote(
  actor: TeamSession,
  ticketId: string,
  deps: ChargeDeps = {},
): Promise<Result<{ billed: true; quote?: { id: string; title: string } } | null>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  if (!uuid.safeParse(ticketId).success) return fail("notFound");
  const db = deps.db ?? appDb;
  const [row] = await db
    .select({ quoteId: quotes.id, title: quotes.title })
    .from(tickets)
    .innerJoin(quoteItems, eq(quoteItems.id, tickets.quoteItemId))
    .innerJoin(quotes, eq(quotes.id, quoteItems.quoteId))
    .where(eq(tickets.id, ticketId));
  if (!row || !(await hasLive(db, eq(charges.quoteId, row.quoteId)))) return ok(null);
  return ok(isOwner(actor) ? { billed: true, quote: { id: row.quoteId, title: row.title } } : { billed: true });
}

/** The charge a verified event is about, locked: by its id (a uuid of this provider), else by the subscription id. */
async function lockEventCharge(tx: Db, event: WebhookEvent, provider: ProviderName): Promise<Charge | null> {
  if (event.chargeId && uuid.safeParse(event.chargeId).success) {
    const [charge] = await tx
      .select()
      .from(charges)
      .where(and(eq(charges.id, event.chargeId), eq(charges.provider, provider)))
      .for("update");
    if (charge) return charge;
  }
  if (event.externalSubscriptionId) {
    const [found] = await tx
      .select({ id: charges.id })
      .from(charges)
      .where(and(eq(charges.externalSubscriptionId, event.externalSubscriptionId), eq(charges.provider, provider)))
      .orderBy(desc(charges.createdAt))
      .limit(1);
    if (found) {
      const [charge] = await tx.select().from(charges).where(eq(charges.id, found.id)).for("update");
      return charge ?? null;
    }
  }
  return null;
}

/** A payment for a canceled one-time charge whose source already has another live or paid charge. */
async function sourceTaken(tx: Db, charge: Charge): Promise<boolean> {
  const where = charge.ticketId
    ? eq(charges.ticketId, charge.ticketId)
    : charge.hourPurchaseId
      ? eq(charges.hourPurchaseId, charge.hourPurchaseId)
      : charge.quoteId
        ? eq(charges.quoteId, charge.quoteId)
        : null;
  if (!where) return false;
  return hasLive(tx, and(where, ne(charges.id, charge.id)) as SQL);
}

/**
 * Applies a verified provider event inside the caller's transaction. Charges of another provider,
 * unknown ids and foreign references (not a uuid) are ignored. The charge is locked, then
 * `applyEffect` decides; the first payment sets `paid_at`, the provider's ids are kept, and a paid
 * hour purchase enters the balance. `changed` is whether the status moved.
 *
 * A canceled subscription ignores everything, but a payment, activation or renewal failure for it
 * means the provider's subscription is still alive (say the checkout completed just before staff
 * canceled): it is logged and its id returned as `orphanSubscriptionId`, so the caller cancels it at
 * the provider after the commit.
 */
export async function applyWebhookEffect(
  tx: Db,
  event: WebhookEvent,
  provider: ProviderName,
): Promise<{ changed: boolean; orphanSubscriptionId?: string }> {
  if (event.effect === "ignore") return { changed: false };
  const charge = await lockEventCharge(tx, event, provider);
  if (!charge) return { changed: false };
  if (charge.kind === "subscription" && charge.status === "canceled") {
    // A "canceled" event only confirms it; anything else says the provider still bills the client.
    if (event.effect === "canceled") return { changed: false };
    const live = event.externalSubscriptionId ?? null;
    console.error(
      `[charges] a ${event.effect} event for the canceled subscription charge ${charge.id} was ignored; ` +
        `subscription ${live ?? charge.externalSubscriptionId ?? "unknown"} at ${provider} may still be billing.`,
    );
    return live ? { changed: false, orphanSubscriptionId: live } : { changed: false };
  }

  if (charge.kind === "subscription") {
    const other = event.externalSubscriptionId;
    // Only the subscription in use can cancel the charge. A canceled event for another one (say the
    // checkout that closing a superseded click cancelled) says nothing about this charge, and a
    // pending charge has no subscription yet, so it never stores the id of a canceled one.
    if (event.effect === "canceled" && (!charge.externalSubscriptionId || other !== charge.externalSubscriptionId)) {
      return { changed: false };
    }
    // A second subscription for a charge that already has one (two checkouts completed): never ours.
    if (event.effect !== "canceled" && charge.externalSubscriptionId && other && other !== charge.externalSubscriptionId) {
      console.error(
        `[charges] a second subscription for charge ${charge.id}: ${other} arrived while ${charge.externalSubscriptionId} is the one in use; ` +
          `it is canceled at ${provider}, but its first invoice may already have been charged and need a refund.`,
      );
      return { changed: false, orphanSubscriptionId: other };
    }
  }
  if (charge.kind === "one_time" && charge.status === "paid" && event.effect === "paid" && event.externalPaymentId && event.externalPaymentId !== charge.externalPaymentId) {
    console.error(
      charge.externalPaymentId
        ? `[charges] possible duplicate payment for charge ${charge.id}: payment ${event.externalPaymentId} arrived after ${charge.externalPaymentId} at ${provider}; refund one if the client paid twice.`
        : `[charges] payment ${event.externalPaymentId} arrived after the charge ${charge.id} was marked paid by hand at ${provider}; refund it if the client paid twice.`,
    );
    return { changed: false };
  }

  const next = applyEffect(charge, event.effect);
  const now = new Date();
  const set: Partial<typeof charges.$inferInsert> = {};
  if (event.externalSubscriptionId && !charge.externalSubscriptionId) set.externalSubscriptionId = event.externalSubscriptionId;
  if (event.externalPaymentId && (next?.status === "paid" || !charge.externalPaymentId)) set.externalPaymentId = event.externalPaymentId;

  let release = false;
  if (next) {
    set.status = next.status;
    if (next.setPaidAt && !charge.paidAt) set.paidAt = now;
    if (next.status === "canceled") set.canceledAt = now;
    if (next.status === "paid") {
      set.canceledAt = null;
      release = Boolean(charge.hourPurchaseId);
      // The money came in for a canceled charge whose source was charged again meanwhile: record the
      // payment without the source, since one source has at most one live or paid charge.
      if (charge.status === "canceled" && (await sourceTaken(tx, charge))) {
        console.error(`[charges] a payment arrived for the canceled charge ${charge.id}, whose source has another charge; it is recorded without its source.`);
        Object.assign(set, { ticketId: null, hourPurchaseId: null, quoteId: null });
        release = false;
      }
    }
  }
  if (Object.keys(set).length === 0) return { changed: false };
  await tx
    .update(charges)
    .set({ ...set, updatedAt: now })
    .where(eq(charges.id, charge.id));
  if (release && charge.hourPurchaseId) await releasePurchase(tx, charge.hourPurchaseId);
  return { changed: Boolean(next) };
}

/** For the quote execution: charges of a prospect's quote follow the client it becomes. */
export async function linkQuoteChargesToClient(tx: Db, quoteId: string, clientId: string): Promise<void> {
  await tx
    .update(charges)
    .set({ clientId, updatedAt: new Date() })
    .where(and(eq(charges.quoteId, quoteId), isNull(charges.clientId)));
}
