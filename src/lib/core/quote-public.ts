import "server-only";
import { after } from "next/server";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getAppUrl } from "@/lib/app-url";
import { logoAbsoluteUrl } from "@/lib/agency";
import { agency, charges, clients, db as appDb, quoteItems, quotes, users, type Db, type QuoteItemKind, type QuoteStatus } from "@/lib/db";
import { getDict, isLocale } from "@/lib/i18n";
import { buildQuoteApprovedMail } from "@/lib/mail/messages/quote-approved";
import { sendMail } from "@/lib/mail/send";
import { decidedTotals } from "@/lib/quote-utils";
import { payPathOf } from "./portal-payments";
import { fail, ok, type Result } from "./result";
import { Abort, transact } from "./tx";

/**
 * The public side of a quote: whoever holds the link reads it and approves its items once. Approval
 * locks only the quote row, so the global lock order (agency, quote, ...) holds.
 */

/**
 * Test seams: the database, the mail sender and the scheduler that runs work after the response
 * (Next's `after` by default).
 */
type Deps = { db?: Db; send?: typeof sendMail; schedule?: (task: () => Promise<void>) => void };

/** Everything the public page may show. No prospect e-mail, item config, log, client id or token. */
export type PublicQuote = {
  title: string;
  notes: string | null;
  /** The client's name, or the prospect's. */
  forName: string;
  agencyName: string;
  currency: string;
  status: QuoteStatus;
  acceptedAt: Date | null;
  items: {
    id: string;
    kind: QuoteItemKind;
    title: string;
    description: string | null;
    amountCents: number;
    monthly: boolean;
    clientApproved: boolean;
    /** Executed by the agency although the client did not approve it. */
    includedByAgency: boolean;
  }[];
  /** Which state of the quote this page shows: sent back with the approval to spot a page that went stale. */
  version: string;
  totals: { oneTimeCents: number; monthlyCents: number };
  /** The quote's live or paid charge, shown to anyone with the link: paid, or pending (with a pay link when it has a provider). */
  charge: {
    status: "pending" | "paid";
    label: string;
    amountCents: number;
    currency: string;
    paidAt: Date | null;
    payPath: string | null;
  } | null;
};

const TOKEN_MAX = 200;
const uuid = z.uuid();

/** The quote's `updated_at` (every change to the quote sets it) as the text a page carries back; millisecond precision on both sides. */
const versionOf = (updatedAt: Date): string => String(updatedAt.getTime());

/** The quote behind a link, or null when the token is unknown or the quote is a draft or archived. */
export async function getPublicQuote(token: string, deps: Deps = {}): Promise<PublicQuote | null> {
  if (typeof token !== "string" || !token || token.length > TOKEN_MAX) return null;
  const db = deps.db ?? appDb;
  const [row] = await db
    .select({ quote: quotes, clientName: clients.name })
    .from(quotes)
    .leftJoin(clients, eq(clients.id, quotes.clientId))
    .where(eq(quotes.token, token));
  if (!row || row.quote.status === "draft" || row.quote.status === "archived") return null;
  const { quote } = row;

  const [items, [brand], [chargeRow]] = await Promise.all([
    db
      .select({
        id: quoteItems.id,
        kind: quoteItems.kind,
        title: quoteItems.title,
        description: quoteItems.description,
        amountCents: quoteItems.amountCents,
        monthly: quoteItems.monthly,
        clientApproved: quoteItems.clientApproved,
        executed: quoteItems.executed,
      })
      .from(quoteItems)
      .where(eq(quoteItems.quoteId, quote.id))
      .orderBy(asc(quoteItems.position), asc(quoteItems.id)),
    db.select({ name: agency.name }).from(agency).limit(1),
    db
      .select({
        status: charges.status,
        provider: charges.provider,
        payToken: charges.payToken,
        label: charges.label,
        amountCents: charges.amountCents,
        currency: charges.currency,
        paidAt: charges.paidAt,
      })
      .from(charges)
      .where(and(eq(charges.quoteId, quote.id), inArray(charges.status, ["pending", "paid"]))),
  ]);

  return {
    title: quote.title,
    notes: quote.notes,
    forName: row.clientName ?? quote.prospectName ?? "",
    agencyName: brand?.name ?? "Velk Express",
    currency: quote.currency,
    status: quote.status,
    acceptedAt: quote.acceptedAt,
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      description: item.description,
      amountCents: item.amountCents,
      monthly: item.monthly,
      clientApproved: item.clientApproved,
      includedByAgency: item.executed && !item.clientApproved,
    })),
    version: versionOf(quote.updatedAt),
    totals: decidedTotals(quote.status, items),
    charge: chargeRow
      ? {
          status: chargeRow.status as "pending" | "paid",
          label: chargeRow.label,
          amountCents: chargeRow.amountCents,
          currency: chargeRow.currency,
          paidAt: chargeRow.paidAt,
          payPath: chargeRow.status === "pending" && chargeRow.provider ? payPathOf(chargeRow.payToken) : null,
        }
      : null,
  };
}

/**
 * The client approves items from the link. Only a `sent` quote can be approved, once: a quote that was
 * already approved or executed is `alreadyDecided`; a missing, draft or archived one is `notFound`.
 * Ids that are not items of this quote are dropped; none left is `nothingSelected`. After the commit,
 * every owner with a password is told, in their own language, after the response.
 *
 * `version` is what the page carried (`PublicQuote.version`): when the quote changed since (the owner
 * edited it, or another approval came first) the answer is `quoteChanged`, so the visitor reloads and
 * decides on what is there now. Without it, the check is skipped.
 */
export async function approveQuote(token: string, itemIds: string[], deps: Deps = {}, version?: string): Promise<Result> {
  if (typeof token !== "string" || !token || token.length > TOKEN_MAX) return fail("notFound");
  const db = deps.db ?? appDb;
  const send = deps.send ?? sendMail;
  const wanted = [...new Set(itemIds.filter((id): id is string => typeof id === "string" && uuid.safeParse(id).success))];

  const done = await transact(db, async (tx) => {
    const [quote] = await tx.select().from(quotes).where(eq(quotes.token, token)).for("update");
    if (!quote || quote.status === "draft" || quote.status === "archived") throw new Abort("notFound");
    if (version !== undefined && version !== versionOf(quote.updatedAt)) throw new Abort("quoteChanged");
    if (quote.status !== "sent") throw new Abort("alreadyDecided");

    const valid = wanted.length
      ? await tx
          .select({ id: quoteItems.id })
          .from(quoteItems)
          .where(and(eq(quoteItems.quoteId, quote.id), inArray(quoteItems.id, wanted)))
      : [];
    if (valid.length === 0) throw new Abort("nothingSelected");

    await tx.update(quoteItems).set({ clientApproved: false }).where(eq(quoteItems.quoteId, quote.id));
    await tx
      .update(quoteItems)
      .set({ clientApproved: true })
      .where(
        and(
          eq(quoteItems.quoteId, quote.id),
          inArray(
            quoteItems.id,
            valid.map((v) => v.id),
          ),
        ),
      );
    const now = new Date();
    await tx.update(quotes).set({ status: "accepted", acceptedAt: now, updatedAt: now }).where(eq(quotes.id, quote.id));
    return { id: quote.id, title: quote.title, clientId: quote.clientId, prospectName: quote.prospectName };
  });
  if (!done.ok) return done;

  // The notice is a courtesy, scheduled after the commit and run after the response: whatever goes
  // wrong, the approval stands.
  const schedule = deps.schedule ?? ((task) => after(task));
  const quote = done.value;
  schedule(async () => {
    try {
      await notifyOwners(db, send, quote);
    } catch (err) {
      console.error("[mail] quote-approved notice failed:", err instanceof Error ? err.message : err);
    }
  });
  return ok();
}

/** Tells every owner with a password that a quote was approved, in their own language. */
export async function notifyOwners(
  db: Db,
  send: typeof sendMail,
  quote: { id: string; title: string; clientId: string | null; prospectName: string | null },
): Promise<void> {
  const owners = await db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(and(eq(users.role, "owner"), isNotNull(users.passwordHash)));
  if (owners.length === 0) return;

  const [brand] = await db.select().from(agency).limit(1);
  let name = quote.prospectName ?? "";
  if (quote.clientId) {
    const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, quote.clientId));
    if (client) name = client.name;
  }
  const logoUrl = await logoAbsoluteUrl(brand?.logoFileId ?? null);
  const link = `${await getAppUrl()}/admin/quotes/${quote.id}`;

  for (const owner of owners) {
    try {
      const locale = isLocale(owner.locale) ? owner.locale : isLocale(brand?.locale) ? brand.locale : "en";
      const dict = await getDict(locale);
      await send(
        buildQuoteApprovedMail(dict.quotes.approvedMail, {
          to: owner.email,
          name,
          agencyName: brand?.name ?? "Velk Express",
          logoUrl,
          title: quote.title,
          link,
        }),
      );
    } catch (err) {
      console.error("[mail] quote-approved notice failed:", err instanceof Error ? err.message : err);
    }
  }
}
