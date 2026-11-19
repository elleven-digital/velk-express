import type { ChargeSource, ChargeStatus } from "@/lib/db";
import type { BadgeTone } from "@/components/ui";

/** The status of a charge as the screens name and color it: amber waits on the client, red needs fixing, gray is done. */
export function chargeStatusMeta(status: ChargeStatus): {
  key: "statusPending" | "statusPaid" | "statusActive" | "statusPastDue" | "statusCanceled";
  tone: BadgeTone;
} {
  switch (status) {
    case "paid":
      return { key: "statusPaid", tone: "ok" };
    case "active":
      return { key: "statusActive", tone: "ok" };
    case "past_due":
      return { key: "statusPastDue", tone: "danger" };
    case "canceled":
      return { key: "statusCanceled", tone: "muted" };
    default:
      return { key: "statusPending", tone: "warn" };
  }
}

/** A live charge can still change: neither paid nor canceled. */
export function isLiveStatus(status: ChargeStatus): boolean {
  return status !== "paid" && status !== "canceled";
}

/** A monthly charge that is billing the client at the provider right now (active or past due). */
export function isBillingSubscription(charge: { kind: string; status: ChargeStatus }): boolean {
  return charge.kind === "subscription" && (charge.status === "active" || charge.status === "past_due");
}

export function chargeSourceKey(source: ChargeSource): "sourceQuote" | "sourceTicket" | "sourceSupport" | "sourceHours" | "sourceOneOff" {
  switch (source) {
    case "quote":
      return "sourceQuote";
    case "ticket":
      return "sourceTicket";
    case "support":
      return "sourceSupport";
    case "hours":
      return "sourceHours";
    default:
      return "sourceOneOff";
  }
}

/** Where a charge's source lives in the panel; the quote's is the owner's, so a manager gets none. */
export function chargeSourceHref(
  charge: { source: ChargeSource; ticketId: string | null; quoteId: string | null; clientId: string | null },
  owner: boolean,
): string | null {
  switch (charge.source) {
    case "ticket":
      return charge.ticketId ? `/admin/tickets/${charge.ticketId}` : null;
    case "quote":
      return owner && charge.quoteId ? `/admin/quotes/${charge.quoteId}` : null;
    case "support":
      return charge.clientId ? `/admin/clients/${charge.clientId}` : null;
    case "hours":
      return charge.clientId ? `/admin/clients/${charge.clientId}/hours` : null;
    default:
      return null;
  }
}
