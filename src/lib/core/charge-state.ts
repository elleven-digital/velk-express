import type { ChargeKind, ChargeStatus } from "@/lib/db/schema";
import type { WebhookEffect } from "@/lib/payments/types";

/**
 * What a provider event does to a charge, as a pure rule (no database). Null means nothing
 * changes: a replay, an event that does not apply to this kind, or a canceled subscription.
 *
 * - One-time: only a payment counts. It also wins over a cancel, because the money came in.
 * - Subscription: a payment or an activation makes it active, a failed renewal past due, a
 *   provider cancel canceled. Canceled is final: everything after it is ignored.
 *
 * `setPaidAt` means "the money came in": the caller records `paid_at` only while it is empty, so a
 * subscription keeps the date of its first payment.
 */
export function applyEffect(
  current: { kind: ChargeKind; status: ChargeStatus },
  effect: WebhookEffect,
): { status: ChargeStatus; setPaidAt: boolean } | null {
  const { kind, status } = current;
  if (effect === "ignore") return null;

  if (kind === "one_time") {
    if (effect === "paid" && (status === "pending" || status === "canceled")) return { status: "paid", setPaidAt: true };
    return null;
  }

  if (status === "canceled" || status === "paid") return null;
  switch (effect) {
    case "paid":
    case "active":
      return status === "active" ? null : { status: "active", setPaidAt: true };
    case "past_due":
      return status === "past_due" ? null : { status: "past_due", setPaidAt: false };
    case "canceled":
      return { status: "canceled", setPaidAt: false };
  }
}
