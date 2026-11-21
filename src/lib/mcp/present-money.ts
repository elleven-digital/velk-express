import type { ChargeView } from "@/lib/core/charges";
import type { QuoteDetail, QuoteRow } from "@/lib/core/quotes";
import type { Quote, QuoteItemConfig } from "@/lib/db";
import { iso, panelBase, presentCharge } from "@/lib/mcp/present";

/**
 * Quotes and charges as the AI app sees them: English snake_case keys, ISO
 * dates, money in cents with the currency. Both are staff business already
 * gated by the cores (quotes and a quote's charge the owner's).
 */

/** The quote's page in the team panel. */
export function quoteUrl(appUrl: string, quoteId: string): string {
  return `${panelBase(appUrl)}/admin/quotes/${quoteId}`;
}

/** The page the client approves the quote on: from when the quote is sent until it is archived, as the panel shows it. */
export function quotePublicUrl(appUrl: string, quote: Pick<Quote, "status" | "token">): string | null {
  return quote.status === "draft" || quote.status === "archived" ? null : `${panelBase(appUrl)}/q/${quote.token}`;
}

/** An item's sites and hours, in the tool's argument names. */
function presentConfig(config: QuoteItemConfig) {
  return {
    ...(config.siteId ? { site_id: config.siteId } : {}),
    ...(config.newSite ? { new_site: config.newSite } : {}),
    ...(config.siteIds?.length ? { site_ids: config.siteIds } : {}),
    ...(config.newSites?.length ? { new_sites: config.newSites } : {}),
    ...(config.hoursMode
      ? {
          hours: {
            mode: config.hoursMode,
            ...(config.hoursMode === "package"
              ? { included_minutes_per_month: config.includedMinutes ?? 0, extra_hour_cents: config.extraHourCents ?? null }
              : {}),
          },
        }
      : {}),
  };
}

type QuoteHead = Quote & { clientName: string | null; oneTimeCents: number; monthlyCents: number };

function presentQuoteHead(row: QuoteHead, appUrl: string) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    client: row.clientId ? { id: row.clientId, name: row.clientName } : null,
    prospect: row.clientId ? null : { name: row.prospectName, email: row.prospectEmail },
    one_time_cents: row.oneTimeCents,
    monthly_cents: row.monthlyCents,
    // The quote's own currency: the agency's when it was created.
    currency: row.currency,
    created_at: iso(row.createdAt),
    sent_at: iso(row.sentAt),
    accepted_at: iso(row.acceptedAt),
    executed_at: iso(row.executedAt),
    url: quoteUrl(appUrl, row.id),
  };
}

/** One row of the quote list. */
export function presentQuoteRow(row: QuoteRow, appUrl: string) {
  return presentQuoteHead(row, appUrl);
}

/** The quote's page: its items with what the client approved and what was executed, the public link and the charge. */
export function presentQuoteDetail(detail: QuoteDetail, appUrl: string, charge: ChargeView | null) {
  const { quote } = detail;
  return {
    ...presentQuoteHead(
      { ...quote, clientName: detail.client?.name ?? null, oneTimeCents: detail.totals.oneTimeCents, monthlyCents: detail.totals.monthlyCents },
      appUrl,
    ),
    notes: quote.notes,
    items: detail.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      description: item.description,
      billing: item.monthly ? "monthly" : "one_time",
      amount_cents: item.amountCents,
      ...presentConfig(item.config),
      client_approved: item.clientApproved,
      executed: item.executed,
    })),
    // The client's sites, for site_id and site_ids.
    client_sites: detail.sites.map((s) => ({ id: s.id, name: s.name })),
    editable: quote.status === "draft" || quote.status === "sent",
    public_url: quotePublicUrl(appUrl, quote),
    charge: charge ? presentCharge(charge) : null,
  };
}

/** Where a charge comes from, with the id create_charge took. */
function chargeSource(c: ChargeView) {
  if (c.source === "ticket") return { type: "ticket", id: c.ticketId };
  if (c.source === "support") return { type: "support", id: c.clientId };
  if (c.source === "hours") return { type: "hours", id: c.hourPurchaseId };
  if (c.source === "quote") return { type: "quote", id: c.quoteId };
  return { type: "none", id: null };
}

/** A charge as the Charges page shows it; the pay link is the agency's own page, made to send to the client. */
export function presentChargeDetail(c: ChargeView) {
  return {
    ...presentCharge(c),
    label: c.label,
    source: chargeSource(c),
    client: c.clientId ? { id: c.clientId, name: c.clientName } : null,
    has_fiscal_document: c.document !== null,
    created_at: c.createdAt,
    paid_at: c.paidAt,
    canceled_at: c.canceledAt,
  };
}
