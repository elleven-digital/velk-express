import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PortalSession } from "@/lib/auth/session";
import { clientMemberships, db as appDb, quoteItems, quotes, type Db, type QuoteStatus } from "@/lib/db";
import { decidedTotals } from "@/lib/quote-utils";
import { fail, ok, type Result } from "./result";

/**
 * The client portal's view of quotes: only the company admin's, only the ones the client may see
 * (sent, accepted, executed; never a draft or an archived one). The company is always the session's.
 * Each row carries the token of the public page it links to, and nothing else about the quote.
 */

type Deps = { db?: Db };

export type PortalQuoteRow = {
  id: string;
  token: string;
  title: string;
  status: Extract<QuoteStatus, "sent" | "accepted" | "executed">;
  currency: string;
  createdAt: Date;
  sentAt: Date | null;
  oneTimeCents: number;
  monthlyCents: number;
};

const VISIBLE = ["sent", "accepted", "executed"] as const;

export const PORTAL_QUOTES_PER_PAGE = 50;

/** The role is re-read, so a demotion since the session was resolved already applies. */
export async function isCompanyAdmin(db: Db, session: PortalSession): Promise<boolean> {
  if (session.role !== "admin") return false;
  const [row] = await db
    .select({ role: clientMemberships.role })
    .from(clientMemberships)
    .where(and(eq(clientMemberships.clientUserId, session.user.id), eq(clientMemberships.clientId, session.client.id)));
  return row?.role === "admin";
}

/** The company's visible quotes, newest first (by when they were sent, else created), 50 to a page. */
export async function listPortalQuotes(
  session: PortalSession,
  deps: Deps = {},
  opts: { status?: "sent"; page?: number } = {},
): Promise<Result<PortalQuoteRow[]>> {
  const db = deps.db ?? appDb;
  if (!(await isCompanyAdmin(db, session))) return fail("forbidden");
  const page = Number.isSafeInteger(opts.page) && opts.page! > 1 ? opts.page! : 1;
  const rows = await db
    .select({
      id: quotes.id,
      token: quotes.token,
      title: quotes.title,
      status: quotes.status,
      currency: quotes.currency,
      createdAt: quotes.createdAt,
      sentAt: quotes.sentAt,
    })
    .from(quotes)
    .where(
      and(
        eq(quotes.clientId, session.client.id),
        opts.status ? eq(quotes.status, opts.status) : inArray(quotes.status, [...VISIBLE]),
      ),
    )
    .orderBy(desc(sql`coalesce(${quotes.sentAt}, ${quotes.createdAt})`), desc(quotes.createdAt), desc(quotes.id))
    .limit(PORTAL_QUOTES_PER_PAGE)
    .offset((page - 1) * PORTAL_QUOTES_PER_PAGE);
  if (rows.length === 0) return ok([]);
  const items = await db
    .select({
      quoteId: quoteItems.quoteId,
      amountCents: quoteItems.amountCents,
      monthly: quoteItems.monthly,
      clientApproved: quoteItems.clientApproved,
      executed: quoteItems.executed,
    })
    .from(quoteItems)
    .where(
      inArray(
        quoteItems.quoteId,
        rows.map((r) => r.id),
      ),
    );
  return ok(
    rows.map((r) => ({
      ...r,
      status: r.status as PortalQuoteRow["status"],
      ...decidedTotals(
        r.status as PortalQuoteRow["status"],
        items.filter((i) => i.quoteId === r.id),
      ),
    })),
  );
}

/** How many sent quotes wait on the company's admin; 0 for anyone else. */
export async function countSentPortalQuotes(session: PortalSession, deps: Deps = {}): Promise<number> {
  const db = deps.db ?? appDb;
  if (!(await isCompanyAdmin(db, session))) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(quotes)
    .where(and(eq(quotes.clientId, session.client.id), eq(quotes.status, "sent")));
  return row?.n ?? 0;
}

/** How many quotes the company's admin can see in all (for the pages of the list); 0 for anyone else. */
export async function countPortalQuotes(session: PortalSession, deps: Deps = {}): Promise<number> {
  const db = deps.db ?? appDb;
  if (!(await isCompanyAdmin(db, session))) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(quotes)
    .where(and(eq(quotes.clientId, session.client.id), inArray(quotes.status, [...VISIBLE])));
  return row?.n ?? 0;
}
