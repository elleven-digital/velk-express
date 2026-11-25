import type { ChargeView } from "@/lib/core/charges";
import type { CyclePurchase, CycleEntry, HoursSummary } from "@/lib/core/hours";
import type { CompanyUser } from "@/lib/core/portal-users";
import type { Client, Site } from "@/lib/db";
import { iso, panelBase, presentCharge, presentPerson } from "@/lib/mcp/present";

/**
 * Client data for the AI app: English snake_case keys, ISO dates, cents.
 * `staff` only leaves out what the panel hides from collaborators (money,
 * the client's team and rotation); the cores already decided who sees the
 * client at all.
 */

/** The client's page in the team panel. */
export function clientUrl(appUrl: string, clientId: string): string {
  return `${panelBase(appUrl)}/admin/clients/${clientId}`;
}

/** The client's Access tab, where the panel shows invite links to copy. */
export function clientAccessUrl(appUrl: string, clientId: string): string {
  return `${clientUrl(appUrl, clientId)}/access`;
}

export function presentSite(site: Site) {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    notes: site.notes,
    in_support_plan: site.includedInSupport,
  };
}

/** The support plan; the money and the rotation switch only for staff. */
function presentSupport(client: Client, staff: boolean, currency: string | null) {
  return {
    active: client.supportActive,
    track_hours: client.hoursTracked,
    show_hours_to_client: client.hoursVisible,
    // null without included hours (no balance)
    included_minutes_per_month: client.hoursLimited ? client.includedMinutes : null,
    client_can_buy_hours: client.hoursPurchasable,
    general_tickets: client.generalTicketsEnabled,
    ...(staff
      ? {
          monthly_cents: client.supportMonthlyCents,
          extra_hour_cents: client.extraHourCents,
          currency,
        }
      : {}),
  };
}

/** One cycle's figures: what was used, and with included hours the included, purchased and balance minutes. */
function hoursFigures(summary: HoursSummary) {
  if (!summary.tracked) return { cycle: summary.cycle };
  if (!summary.limited) return { cycle: summary.cycle, used_minutes: summary.usedMinutes };
  return {
    cycle: summary.cycle,
    included_minutes: summary.includedMinutes,
    purchased_minutes: summary.purchasedMinutes,
    used_minutes: summary.usedMinutes,
    balance_minutes: summary.balanceMinutes,
  };
}

/** How the hours are kept: tracked, shown to the client, and with included hours (a balance). */
function hoursFlags(summary: HoursSummary) {
  return {
    track_hours: summary.tracked,
    show_hours_to_client: summary.visible,
    has_included_hours: summary.limited,
  };
}

/** One cycle's hours as the client's page shows them: a balance only with included hours. */
export function presentHours(summary: HoursSummary) {
  return { ...hoursFlags(summary), ...hoursFigures(summary) };
}

export function presentClientRow(
  row: Client & { siteCount: number },
  appUrl: string,
  money: { staff: boolean; currency: string | null },
) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    sites: row.siteCount,
    support: presentSupport(row, money.staff, money.currency),
    created_at: iso(row.createdAt),
    url: clientUrl(appUrl, row.id),
  };
}

export type ClientDetail = {
  client: Client;
  sites: Site[];
  hours: HoursSummary | null;
  openTickets: number;
  /** Owners and managers only. */
  staff: {
    currency: string | null;
    team: { id: string; name: string }[];
    rotation: { enabled: boolean; people: { id: string; name: string }[] };
    supportCharge: ChargeView | null;
  } | null;
};

export function presentClientDetail(detail: ClientDetail, appUrl: string) {
  const { client, staff } = detail;
  return {
    id: client.id,
    name: client.name,
    email: client.email,
    phone: client.phone,
    notes: client.notes,
    created_at: iso(client.createdAt),
    support: presentSupport(client, Boolean(staff), staff?.currency ?? null),
    hours: detail.hours ? presentHours(detail.hours) : null,
    open_tickets: detail.openTickets,
    sites: detail.sites.map(presentSite),
    ...(staff
      ? {
          team: staff.team.map(presentPerson),
          rotation: { enabled: staff.rotation.enabled, people: staff.rotation.people.map(presentPerson) },
          support_charge: staff.supportCharge ? presentCharge(staff.supportCharge) : null,
        }
      : {}),
    url: clientUrl(appUrl, client.id),
  };
}

/**
 * The Hours tab for one cycle. `notice` is the panel's sentence for a client
 * whose hours are off (or kept for the team only); a cycle with hours off
 * still lists what it holds, as the panel does.
 */
export function presentClientHours(
  input: {
    client: Pick<Client, "id" | "name">;
    summary: HoursSummary;
    entries: CycleEntry[];
    purchases: (CyclePurchase & { charge: ChargeView | null })[];
    currency: string | null;
    notice: string | null;
  },
  appUrl: string,
) {
  const { summary } = input;
  return {
    client: { id: input.client.id, name: input.client.name, url: clientUrl(appUrl, input.client.id) },
    ...hoursFlags(summary),
    ...(input.notice ? { notice: input.notice } : {}),
    ...hoursFigures(summary),
    currency: input.currency,
    time_entries: input.entries.map((e) => ({
      id: e.id,
      minutes: e.minutes,
      worked_on: e.workedOn,
      note: e.note,
      ticket: { id: e.ticketId, number: e.ticketNumber, title: e.ticketTitle, type: e.ticketType },
      // Only support tickets count against the client's hours.
      counts_against_hours: e.ticketType === "support",
    })),
    hour_packages: input.purchases.map((p) => ({
      id: p.id,
      minutes: p.minutes,
      price_cents: p.priceCents,
      note: p.note,
      // Bought from the portal and not paid yet: not in the balance.
      pending_payment: p.pending,
      created_at: p.createdAt,
      charge: p.charge ? presentCharge(p.charge) : null,
    })),
  };
}

/** A portal login. Its invite link stays in the panel, never in the conversation. */
export function presentPortalLogin(login: CompanyUser) {
  return {
    id: login.id,
    name: login.name,
    email: login.email,
    role: login.role,
    status: login.pending ? ("invited" as const) : ("active" as const),
  };
}
