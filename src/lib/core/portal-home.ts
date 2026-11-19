import "server-only";
import { asc, eq } from "drizzle-orm";
import { clients, db as appDb, sites, type Db, type Site } from "@/lib/db";
import type { PortalSession } from "@/lib/auth/session";
import type { ChargeDeps } from "./charges";
import { getHoursSummary } from "./hours";
import { getPortalPaymentsHome, type PortalPaymentsHome } from "./portal-payments";
import { listPortalQuotes, type PortalQuoteRow } from "./portal-quotes";
import { listPortalTickets, type PortalTicketRow } from "./portal-tickets";

/** The package balance the client sees; nothing about entries, notes or authors. */
export type PortalHours = {
  cycle: string;
  includedMinutes: number;
  purchasedMinutes: number;
  usedMinutes: number;
  balanceMinutes: number;
};

export type PortalHome = {
  /** Only in the package mode; null for team-only and off. */
  hours: PortalHours | null;
  supportActive: boolean;
  /** null for portal collaborators: money is for admins only. */
  monthlyCents: number | null;
  generalTickets: boolean;
  /** The active company's, by name. */
  sites: Site[];
  coveredCount: number;
  /** Sent quotes waiting on the client, newest first; empty for portal collaborators. */
  proposals: PortalQuoteRow[];
  /** Money: only for the company's admins, null for portal collaborators. */
  payments: PortalPaymentsHome | null;
  /** Open tickets on the client's turn. */
  awaiting: PortalTicketRow[];
  /** The 5 with the newest activity. */
  recent: PortalTicketRow[];
};

const RECENT_TICKETS = 5;

/**
 * What the portal home shows. The company is always the session's own, so a person who belongs
 * to several companies only ever sees the active one; the plan is read fresh so a change by the
 * team shows up without signing in again.
 */
export async function getPortalHome(
  session: PortalSession,
  db: Db = appDb,
  deps: Pick<ChargeDeps, "providers"> = {},
): Promise<PortalHome> {
  const clientId = session.client.id;
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  const rows = await db.select().from(sites).where(eq(sites.clientId, clientId)).orderBy(asc(sites.name));
  // Two bounded reads instead of every ticket of the company: the newest few, and the ones that
  // wait on the client (those must be complete, wherever they sit in the history).
  const [recent, awaiting, proposalsRes, payments] = await Promise.all([
    listPortalTickets(session, db, { limit: RECENT_TICKETS }),
    listPortalTickets(session, db, { awaitingOnly: true }),
    session.role === "admin" ? listPortalQuotes(session, { db }, { status: "sent" }) : null,
    getPortalPaymentsHome(session, { db, providers: deps.providers }),
  ]);
  const summary = await getHoursSummary(clientId, undefined, { db });
  const hours: PortalHours | null =
    summary && summary.mode === "package"
      ? {
          cycle: summary.cycle,
          includedMinutes: summary.includedMinutes,
          purchasedMinutes: summary.purchasedMinutes,
          usedMinutes: summary.usedMinutes,
          balanceMinutes: summary.balanceMinutes,
        }
      : null;
  return {
    hours,
    supportActive: client?.supportActive ?? false,
    monthlyCents: session.role === "admin" && client?.supportActive ? (client.supportMonthlyCents ?? null) : null,
    generalTickets: client?.generalTicketsEnabled ?? false,
    sites: rows,
    coveredCount: rows.filter((s) => s.includedInSupport).length,
    proposals: proposalsRes?.ok ? proposalsRes.value : [],
    payments,
    awaiting,
    recent,
  };
}
