import { randomBytes } from "node:crypto";
import type { QuoteStatus } from "@/lib/db/schema";

/** Sums the one-time and the monthly items of a quote (integer cents, no discounts or taxes). */
export function quoteTotals(items: { monthly: boolean; amountCents: number }[]): {
  oneTimeCents: number;
  monthlyCents: number;
} {
  let oneTimeCents = 0;
  let monthlyCents = 0;
  for (const item of items) {
    if (item.monthly) monthlyCents += item.amountCents;
    else oneTimeCents += item.amountCents;
  }
  return { oneTimeCents, monthlyCents };
}

/**
 * What the client is billed for once the quote is decided: from `accepted` on only the items the
 * client approved or that were executed count; while it is `sent` (or anything earlier) every item does.
 */
export function decidedTotals(
  status: QuoteStatus,
  items: { monthly: boolean; amountCents: number; clientApproved: boolean; executed: boolean }[],
): { oneTimeCents: number; monthlyCents: number } {
  const decided = status === "accepted" || status === "executed";
  return quoteTotals(decided ? items.filter((i) => i.clientApproved || i.executed) : items);
}

/** How a status is shown: a badge tone and the key of its label in the dictionary. */
export function quoteStatusMeta(status: QuoteStatus): {
  tone: "muted" | "info" | "ok" | "ink" | "warn";
  key: QuoteStatus;
} {
  const tone = { draft: "muted", sent: "info", accepted: "ok", executed: "ink", archived: "warn" } as const;
  return { tone: tone[status], key: status };
}

/** The secret of a quote's public link: 24 random bytes, URL-safe. */
export function newQuoteToken(): string {
  return randomBytes(24).toString("base64url");
}
