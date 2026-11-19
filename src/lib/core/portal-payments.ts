import "server-only";
import { and, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { getAppUrl } from "@/lib/app-url";
import type { PortalSession } from "@/lib/auth/session";
import { agency, charges, clients, db as appDb, hourPurchases, type ChargeKind, type ChargeStatus, type Db } from "@/lib/db";
import { cycleKey } from "@/lib/hours";
import { formatMinutes } from "@/lib/format";
import { fmt, getDict, isLocale, type Locale } from "@/lib/i18n";
import { availableProviders, expireOpenCheckout, insertCharge, payUrlFor, type ChargeDeps } from "./charges";
import { isCompanyAdmin } from "./portal-quotes";
import { fail, type Result } from "./result";
import { Abort, transact } from "./tx";

/**
 * Money in the client portal. Only the company's admin sees any of it, and the company is always
 * the session's own. Every "Pay" is the charge's own `/pay/[token]` link, which opens a fresh
 * checkout at the provider; a charge without a provider is a manual record with nothing to pay here.
 */

type Deps = Pick<ChargeDeps, "db" | "providers">;

/** One charge as the portal shows it. */
export type PortalPaymentRow = {
  id: string;
  label: string;
  kind: ChargeKind;
  status: ChargeStatus;
  amountCents: number;
  currency: string;
  createdAt: Date;
  paidAt: Date | null;
  /** `/pay/[token]`, only while the charge is pending and has a provider to pay through. */
  payPath: string | null;
  /** The fiscal document's file id, served by `/api/files/{id}` to this company's admins. */
  documentId: string | null;
};

const columns = {
  id: charges.id,
  label: charges.label,
  kind: charges.kind,
  status: charges.status,
  provider: charges.provider,
  amountCents: charges.amountCents,
  currency: charges.currency,
  createdAt: charges.createdAt,
  paidAt: charges.paidAt,
  payToken: charges.payToken,
  documentId: charges.documentFileId,
};

export const payPathOf = (payToken: string) => `/pay/${payToken}`;

function toRow(r: {
  id: string;
  label: string;
  kind: ChargeKind;
  status: ChargeStatus;
  provider: string | null;
  amountCents: number;
  currency: string;
  createdAt: Date;
  paidAt: Date | null;
  payToken: string;
  documentId: string | null;
}): PortalPaymentRow {
  const { provider, payToken, ...rest } = r;
  return { ...rest, payPath: r.status === "pending" && provider ? payPathOf(payToken) : null };
}

/** The company's charges, newest first, without the canceled ones that were never paid. Admin only. */
export async function listPortalPayments(session: PortalSession, deps: Deps = {}): Promise<Result<PortalPaymentRow[]>> {
  const db = deps.db ?? appDb;
  if (!(await isCompanyAdmin(db, session))) return fail("forbidden");
  const rows = await db
    .select(columns)
    .from(charges)
    .where(and(eq(charges.clientId, session.client.id), or(ne(charges.status, "canceled"), isNotNull(charges.paidAt))))
    .orderBy(desc(charges.createdAt), desc(charges.id));
  return { ok: true, value: rows.map(toRow) };
}

/** How many charges wait on the company's admin to pay through a provider; 0 for anyone else. */
export async function countPendingPortalPayments(session: PortalSession, deps: Deps = {}): Promise<number> {
  const db = deps.db ?? appDb;
  if (!(await isCompanyAdmin(db, session))) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(charges)
    .where(and(eq(charges.clientId, session.client.id), eq(charges.status, "pending"), isNotNull(charges.provider)));
  return row?.n ?? 0;
}

/** What the portal home needs about money; null for portal collaborators. */
export type PortalPaymentsHome = {
  /** One task per pending charge with a provider, oldest first. */
  tasks: PortalPaymentRow[];
  /** The pending monthly support charge to set up, when the plan is active. */
  setupPayPath: string | null;
  /** The support subscription is past due. */
  pastDue: boolean;
  /** The extra-hours purchase, when the package has a price and a provider accepts the agency's currency (Mercado Pago only BRL). */
  buyHours: { unitCents: number; currency: string } | null;
};

export async function getPortalPaymentsHome(session: PortalSession, deps: Deps = {}): Promise<PortalPaymentsHome | null> {
  const db = deps.db ?? appDb;
  if (!(await isCompanyAdmin(db, session))) return null;
  const clientId = session.client.id;
  const [pending, [support], [client], [brand]] = await Promise.all([
    db
      .select(columns)
      .from(charges)
      .where(and(eq(charges.clientId, clientId), eq(charges.status, "pending"), isNotNull(charges.provider)))
      .orderBy(charges.createdAt, charges.id),
    db
      .select({ status: charges.status, provider: charges.provider, payToken: charges.payToken })
      .from(charges)
      .where(and(eq(charges.clientId, clientId), eq(charges.source, "support"), ne(charges.status, "canceled"))),
    db.select().from(clients).where(eq(clients.id, clientId)),
    db.select({ currency: agency.currency }).from(agency).where(eq(agency.id, 1)),
  ]);
  const currency = brand?.currency ?? "BRL";
  const online = availableProviders({ currency, kind: "one_time", clientEmail: null }, deps).some((p) => p !== null);
  const canBuy = Boolean(client?.supportActive && client.hoursMode === "package" && (client.extraHourCents ?? 0) > 0 && online);
  return {
    tasks: pending.map(toRow),
    setupPayPath:
      client?.supportActive && support?.status === "pending" && support.provider ? payPathOf(support.payToken) : null,
    pastDue: Boolean(support && support.status === "past_due"),
    buyHours: canBuy ? { unitCents: client!.extraHourCents!, currency } : null,
  };
}

const MAX_HOURS = 100;
const MAX_CENTS = 2_147_483_647;

/**
 * The company's admin buys extra hours: a pending purchase (left out of the balance until paid) and
 * its charge are created together, and the caller sends the browser to the returned pay link.
 * Needs the package mode with a price per extra hour, 1 to 100 whole hours, and a provider that
 * can take the agency's currency (the manual record cannot be paid by the client). The charge goes
 * to the agency's default provider when it can take it, else the first that can.
 */
export async function buyHours(
  session: PortalSession,
  hours: number,
  deps: ChargeDeps = {},
): Promise<Result<{ payUrl: string }>> {
  const db = deps.db ?? appDb;
  if (!(await isCompanyAdmin(db, session))) return fail("forbidden");
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) return fail("invalidHours");
  const appUrl = await getAppUrl();

  const res = await transact(db, async (tx) => {
    const [brand] = await tx
      .select({ currency: agency.currency, locale: agency.locale, defaultProvider: agency.defaultPaymentProvider })
      .from(agency)
      .where(eq(agency.id, 1));
    if (!brand) throw new Abort("notFound");
    const [client] = await tx.select().from(clients).where(eq(clients.id, session.client.id)).for("update");
    if (!client) throw new Abort("notFound");
    const unit = client.extraHourCents ?? 0;
    if (!client.supportActive || client.hoursMode !== "package" || unit <= 0) throw new Abort("nothingToCharge");
    const priceCents = hours * unit;
    if (priceCents > MAX_CENTS) throw new Abort("invalidHours");

    const online = availableProviders({ currency: brand.currency, kind: "one_time", clientEmail: null }, deps).filter(
      (p): p is NonNullable<typeof p> => p !== null,
    );
    if (online.length === 0) throw new Abort("providerUnavailable");
    const provider = brand.defaultProvider && online.includes(brand.defaultProvider) ? brand.defaultProvider : online[0];

    // A repeated click (or a reload) must not pile up charges: of the pending purchases made here for
    // the same hours in the same cycle, one whose charge still waits is reused while its price per
    // hour, its currency and its provider are still usable now. Every other is discarded like a
    // canceled charge: the charge canceled (its checkout closed after the commit) and the purchase
    // deleted. The client row is locked, so two clicks cannot both miss it.
    const cycle = cycleKey();
    const candidates = await tx
      .select({ charge: charges, purchaseId: hourPurchases.id, priceCents: hourPurchases.priceCents })
      .from(charges)
      .innerJoin(hourPurchases, eq(hourPurchases.id, charges.hourPurchaseId))
      .where(
        and(
          eq(charges.clientId, client.id),
          eq(charges.source, "hours"),
          eq(charges.status, "pending"),
          isNull(charges.createdById),
          eq(hourPurchases.pending, true),
          isNull(hourPurchases.createdById),
          eq(hourPurchases.cycle, cycle),
          eq(hourPurchases.minutes, hours * 60),
        ),
      )
      .orderBy(charges.createdAt)
      .for("update", { of: charges });
    const reused = candidates.find(
      (c) =>
        c.priceCents === priceCents &&
        c.charge.currency === brand.currency &&
        c.charge.provider !== null &&
        online.includes(c.charge.provider),
    );
    const stale = candidates.filter((c) => c !== reused);
    const now = new Date();
    for (const { charge, purchaseId } of stale) {
      await tx.update(charges).set({ status: "canceled", canceledAt: now, updatedAt: now }).where(eq(charges.id, charge.id));
      // Charge, then purchase: the order webhooks use.
      await tx.delete(hourPurchases).where(and(eq(hourPurchases.id, purchaseId), eq(hourPurchases.pending, true)));
    }
    const discarded = stale.map((c) => c.charge);
    if (reused) return { payToken: reused.charge.payToken, discarded };

    const locale: Locale = isLocale(session.user.locale) ? session.user.locale : isLocale(brand.locale) ? brand.locale : "en";
    const t = await getDict(locale);
    const minutes = hours * 60;
    const [purchase] = await tx
      .insert(hourPurchases)
      .values({
        clientId: client.id,
        minutes,
        cycle,
        priceCents,
        pending: true,
        note: t.hours.portalPurchaseNote,
        createdById: null,
      })
      .returning({ id: hourPurchases.id });
    const created = await insertCharge(tx as Db, {
      source: "hours",
      kind: "one_time",
      provider,
      clientId: client.id,
      label: fmt(t.charges.purchaseLabel, { minutes: formatMinutes(minutes), cycle }),
      amountCents: priceCents,
      currency: brand.currency,
      hourPurchaseId: purchase.id,
      createdById: null,
    });
    return { payToken: created.payToken, discarded };
  });
  if (!res.ok) return res;
  for (const stale of res.value.discarded) await expireOpenCheckout(stale, deps);
  return { ok: true, value: { payUrl: payUrlFor(appUrl, res.value.payToken) } };
}
