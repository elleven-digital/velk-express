import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { TeamSession } from "@/lib/auth/session";
import { authLink } from "@/lib/auth/tokens";
import {
  agency,
  clients,
  db as appDb,
  quoteItems,
  quotes,
  sites,
  type ClientUser,
  type Db,
  type QuoteItem,
  type QuoteLogEntry,
} from "@/lib/db";
import { configHoursPlan } from "@/lib/hours-plan";
import { isLocale, type Locale } from "@/lib/i18n";
import { sendMail } from "@/lib/mail/send";
import { linkQuoteChargesToClient } from "./charges";
import { ensurePortalLogin, tryMailInvite, tryMailLinked } from "./portal-users";
import { fail, ok, type Result } from "./result";
import { applySupportPlan } from "./support-plan";
import { insertTicket } from "./tickets";
import { Abort, transact } from "./tx";

/**
 * "Close and execute": turns a sent or accepted quote into real work in one transaction. A prospect
 * becomes a client (with a portal login when it has an e-mail), each ticked item creates its sites
 * and single tickets or sets the support plan, and the quote is closed with a log of what was made.
 *
 * Lock order (global): agency row (ticket numbers), quote row, the company's portal lock, client row,
 * client_users, ticket rows, then the quote's charges. A second click waits on the quote row and
 * finds it executed; a charge for the quote (or one of its tickets) waits there too.
 */

/** Test seams: the database and the mail sender. */
type Deps = { db?: Db; send?: typeof sendMail };

/** A login created by the execution: its set-password link, and whether the invite e-mail went out. */
export type ExecutedInvite = { name: string; email: string; link: string; emailed: boolean };

const uuid = z.uuid();

/** A unique violation on a portal login's e-mail: the same new e-mail was created elsewhere at the same moment. */
function isLoginEmailConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint_name ?? e?.cause?.constraint_name;
  return code === "23505" && constraint === "client_users_email_unique";
}

type Executed = {
  log: QuoteLogEntry[];
  invite: { name: string; email: string; token: string; locale: Locale } | null;
  /** An active login that was linked to the new client: told after the commit. */
  linked: { clientId: string; person: Pick<ClientUser, "name" | "email" | "locale"> } | null;
};

async function run(db: Db, actor: TeamSession, quoteId: string, itemIds: string[]): Promise<Result<Executed>> {
  return transact(db, async (tx) => {
    // 1. The agency row first: the ticket numbers come from it.
    const [brand] = await tx.select({ locale: agency.locale, currency: agency.currency }).from(agency).where(eq(agency.id, 1)).for("update");
    if (!brand) throw new Abort("notFound");
    const locale: Locale = isLocale(brand.locale) ? brand.locale : "en";

    // 2. The quote: a second click waits here and then finds it executed.
    const [quote] = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).for("update");
    if (!quote) throw new Abort("notFound");
    if (quote.status === "executed") throw new Abort("quoteExecuted");
    if (quote.status !== "sent" && quote.status !== "accepted") throw new Abort("quoteLocked");
    // The values are copied to tickets and the support plan, which read in the agency's current currency.
    if (quote.currency !== brand.currency) throw new Abort("currencyChanged");
    const items: QuoteItem[] =
      itemIds.length === 0
        ? []
        : await tx
            .select()
            .from(quoteItems)
            .where(and(eq(quoteItems.quoteId, quote.id), inArray(quoteItems.id, itemIds)))
            .orderBy(asc(quoteItems.position), asc(quoteItems.id));
    if (items.length === 0) throw new Abort("nothingSelected");

    const log: QuoteLogEntry[] = [];
    let invite: Executed["invite"] = null;
    let linked: Executed["linked"] = null;

    // 3. The client: the quote's own (row locked), or a new one from the prospect.
    let client: { id: string; name: string; supportActive: boolean };
    if (quote.clientId) {
      const [row] = await tx
        .select({ id: clients.id, name: clients.name, supportActive: clients.supportActive })
        .from(clients)
        .where(eq(clients.id, quote.clientId))
        .for("update");
      if (!row) throw new Abort("notFound");
      client = row;
    } else {
      const name = quote.prospectName?.trim() || quote.title;
      const email = quote.prospectEmail?.trim().toLowerCase() || null;
      const [row] = await tx
        .insert(clients)
        .values({ name, email })
        .returning({ id: clients.id, name: clients.name, supportActive: clients.supportActive });
      client = row;
      log.push({ action: "client", itemId: null, label: row.name, id: row.id });
      if (email) {
        // Takes the company's portal lock itself; nobody else can know this new client yet.
        const login = await ensurePortalLogin(tx, row.id, { name, email, locale });
        if (login.invite) {
          invite = { name, email, token: login.invite.token, locale };
          log.push({ action: "clientUser", itemId: null, label: email, id: login.clientUserId });
        } else {
          if (login.linkedActive) linked = { clientId: row.id, person: login.linkedActive };
          log.push({ action: "clientUser", itemId: null, label: email, id: login.clientUserId, note: "linked" });
        }
      }
    }

    const createSite = async (itemId: string, name: string, url: string | undefined, includedInSupport: boolean) => {
      const [site] = await tx
        .insert(sites)
        .values({ clientId: client.id, name, url: url || null, includedInSupport })
        .returning({ id: sites.id });
      log.push({ action: "site", itemId, label: name, id: site.id });
      return site.id;
    };

    /** A site of this client only (locked against deletion until the commit); anything else is no site. */
    const ownSite = async (siteId: string | undefined): Promise<string | null> => {
      if (!siteId || !uuid.safeParse(siteId).success) return null;
      const [site] = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, siteId), eq(sites.clientId, client.id)))
        .for("key share");
      return site?.id ?? null;
    };

    const workTicket = async (item: QuoteItem, siteId: string) => {
      const ticket = await insertTicket(tx, {
        clientId: client.id,
        siteId,
        type: "single",
        title: item.title,
        valueCents: item.amountCents > 0 ? item.amountCents : null,
        // Building a site is a project for the client; a job on an existing one is a ticket.
        isProject: item.kind === "site_creation",
        quoteItemId: item.id,
        createdBy: { type: "agency", id: actor.user.id },
      });
      log.push({ action: "ticket", itemId: item.id, label: `#${ticket.number} ${item.title}`, id: ticket.id });
    };

    // 4. The items, in their order on the quote.
    let hadSupport = client.supportActive;
    for (const item of items) {
      const config = item.config ?? {};
      if (item.kind === "site_creation") {
        const siteId = await createSite(item.id, config.newSite?.name || item.title, config.newSite?.url, false);
        await workTicket(item, siteId);
      } else if (item.kind === "maintenance") {
        const siteId =
          (await ownSite(config.siteId)) ?? (await createSite(item.id, config.newSite?.name || item.title, config.newSite?.url, false));
        await workTicket(item, siteId);
      } else {
        // The item's plan replaces the client's current one; general tickets stay as they are.
        await applySupportPlan(tx, client.id, {
          supportActive: true,
          monthlyCents: item.amountCents > 0 ? item.amountCents : null,
          hours: configHoursPlan(config),
        });
        log.push({
          action: "support",
          itemId: item.id,
          label: client.name,
          id: client.id,
          ...(hadSupport ? { note: "replaced" as const } : {}),
        });
        hadSupport = true;
        const covered = (config.siteIds ?? []).filter((id) => uuid.safeParse(id).success);
        if (covered.length > 0) {
          await tx
            .update(sites)
            .set({ includedInSupport: true })
            .where(and(eq(sites.clientId, client.id), inArray(sites.id, covered)));
        }
        for (const site of config.newSites ?? []) {
          if (site.name?.trim()) await createSite(item.id, site.name.trim(), site.url, true);
        }
      }
    }

    // 5. Close the quote: the ticked items are executed, the rest stay as they are. `clientApproved` is left
    // alone on purpose: an executed item the client did not approve is what the screens call "included by
    // the agency" (the totals already count `clientApproved || executed`).
    const now = new Date();
    await tx
      .update(quoteItems)
      .set({ executed: true })
      .where(inArray(quoteItems.id, items.map((i) => i.id)));
    await tx
      .update(quotes)
      .set({ status: "executed", executedAt: now, clientId: client.id, executionLog: log, updatedAt: now })
      .where(eq(quotes.id, quote.id));
    // 6. Last in the lock order: a prospect's charges now belong to the client it became.
    await linkQuoteChargesToClient(tx, quote.id, client.id);
    return { log, invite, linked };
  });
}

/**
 * Executes the ticked items of a sent or accepted quote (owner only). Items of other quotes are
 * ignored; none left is `nothingSelected`. The invite of a login created here is e-mailed after the
 * commit, in the agency's language, and its link is returned so the screen can show it.
 */
export async function executeQuote(
  actor: TeamSession,
  quoteId: string,
  itemIds: string[],
  deps: Deps = {},
): Promise<Result<{ log: QuoteLogEntry[]; invite: ExecutedInvite | null }>> {
  if (actor.user.role !== "owner") return fail("forbidden");
  if (!uuid.safeParse(quoteId).success) return fail("notFound");
  const db = deps.db ?? appDb;
  const ids = [...new Set(itemIds.filter((id) => typeof id === "string" && uuid.safeParse(id).success))];

  let result: Result<Executed>;
  try {
    result = await run(db, actor, quoteId, ids);
  } catch (err) {
    // The prospect's new e-mail got a login in another company at the same moment: now it exists, so link it.
    if (!isLoginEmailConflict(err)) throw err;
    result = await run(db, actor, quoteId, ids);
  }
  if (!result.ok) return result;

  const { log, invite, linked } = result.value;
  // After the commit: an active login that now also reaches the new company is told (a pending one gets no mail).
  if (linked) await tryMailLinked(db, deps.send ?? sendMail, linked.person, linked.clientId);
  if (!invite) return ok({ log, invite: null });
  // After the commit: a mail failure must not undo the execution (the link is shown anyway).
  const link = await authLink(invite.token);
  const emailed = await tryMailInvite(db, deps.send ?? sendMail, { name: invite.name, email: invite.email, locale: invite.locale }, link);
  return ok({ log, invite: { name: invite.name, email: invite.email, link, emailed } });
}
