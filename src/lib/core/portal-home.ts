import "server-only";
import { asc, eq } from "drizzle-orm";
import { clients, db as appDb, sites, type Db, type Site } from "@/lib/db";
import type { PortalSession } from "@/lib/auth/session";
import type { ChargeDeps } from "./charges";
import { getHoursSummary } from "./hours";
import { getPortalPaymentsHome, type PortalPaymentsHome } from "./portal-payments";
import { listPortalQuotes, type PortalQuoteRow } from "./portal-quotes";
import { listPortalTickets, portalSections, type PortalTicketRow } from "./portal-tickets";

/** The hours the client sees; nothing about entries, notes or authors. */
export type PortalHours = {
  cycle: string;
  /** With included hours there is a balance; without, only the hours used. */
  limited: boolean;
  includedMinutes: number;
  purchasedMinutes: number;
  usedMinutes: number;
  balanceMinutes: number;
};

export type PortalHome = {
  /** Only while the hours are shown to the client; null otherwise. */
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
  /** Open projects, newest activity first. */
  projects: PortalTicketRow[];
  /** Open tickets that are not projects, newest activity first, at most OPEN_TICKETS_ON_HOME. */
  openTickets: PortalTicketRow[];
  /** Whether the company gets the tickets part and the projects part at all. */
  sections: { tickets: boolean; projects: boolean };
};

export const OPEN_TICKETS_ON_HOME = 10;

/**
 * What the portal home shows. The company is always the session's own, so a person who belongs
 * to several companies only ever sees the active one; the plan is read fresh so a change by the
 * team shows up without signing in again.
 */
export async function getPortalHome(
  session: PortalSession,
  db: Db = appDb,
  deps: Pick<ChargeDeps, "providers"> & { now?: () => Date } = {},
): Promise<PortalHome> {
  const clientId = session.client.id;
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  const rows = await db.select().from(sites).where(eq(sites.clientId, clientId)).orderBy(asc(sites.name));
  // Bounded reads instead of every ticket of the company: the open ones of each kind.
  const [openTickets, projects, sections, proposalsRes, payments] = await Promise.all([
    listPortalTickets(session, db, { openOnly: true, kind: "tickets", limit: OPEN_TICKETS_ON_HOME }),
    listPortalTickets(session, db, { openOnly: true, kind: "projects" }),
    portalSections(session, db),
    session.role === "admin" ? listPortalQuotes(session, { db }, { status: "sent" }) : null,
    getPortalPaymentsHome(session, { db, providers: deps.providers }),
  ]);
  const summary = await getHoursSummary(clientId, undefined, { db, now: deps.now });
  const hours: PortalHours | null =
    summary && summary.tracked && summary.visible
      ? {
          cycle: summary.cycle,
          limited: summary.limited,
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
    projects,
    openTickets,
    sections,
  };
}
