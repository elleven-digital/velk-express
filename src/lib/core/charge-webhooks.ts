import "server-only";
import { db as appDb, paymentEvents, type Db } from "@/lib/db";
import type { PaymentProvider, ProviderName, WebhookEvent, WebhookRequest } from "@/lib/payments";
import { applyWebhookEffect, errorTag, providersOf, type ChargeDeps } from "./charges";

/**
 * The payment webhooks. The provider verifies the signature and reads each object from its own API
 * (the body is never trusted); then, per event and in one transaction, `(provider, event_id)` is
 * recorded in `payment_events` and, only when it is new, the effect is applied. A replay finds the
 * row and changes nothing.
 *
 * Statuses: 501 when the provider has no keys, 400 for a bad signature, 500 when the database or a
 * provider lookup fails (the event row rolls back with the effect, so the provider's retry is
 * processed), 200 otherwise, including events for charges that are not ours.
 *
 * A subscription that the core finds still billing for a canceled charge is canceled at the provider
 * after the commit, best effort and logged. Logs carry the error's class and code only: never the
 * body, the headers or a key.
 */

export type WebhookStatus = 200 | 400 | 500 | 501;

export type WebhookDeps = Pick<ChargeDeps, "db" | "providers"> & {
  /** Runs follow-up provider calls; the route passes `after`, so the response does not wait for them. */
  defer?: (work: () => Promise<void>) => void;
};

/** Records the event and applies it; null when it was already recorded (a replay). */
async function recordAndApply(db: Db, name: ProviderName, event: WebhookEvent): Promise<{ orphan: string | null } | null> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(paymentEvents)
      .values({ provider: name, eventId: event.eventId })
      .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.eventId] })
      .returning({ id: paymentEvents.id });
    if (inserted.length === 0) return null;
    const result = await applyWebhookEffect(tx as unknown as Db, event, name);
    return { orphan: result.orphanSubscriptionId ?? null };
  });
}

async function cancelOrphans(provider: PaymentProvider, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await provider.cancelSubscription(id);
    } catch (err) {
      console.error(`[webhooks] canceling the orphan subscription ${id} failed at ${provider.name}:`, errorTag(err));
    }
  }
}

export async function handleWebhook(name: ProviderName, req: WebhookRequest, deps: WebhookDeps = {}): Promise<{ status: WebhookStatus }> {
  let provider: PaymentProvider | null;
  try {
    provider = providersOf(deps).find((p) => p.name === name) ?? null;
  } catch (err) {
    console.error(`[webhooks] loading the ${name} provider failed:`, errorTag(err));
    return { status: 500 };
  }
  if (!provider) return { status: 501 };

  let events: WebhookEvent[] | "invalid";
  try {
    events = await provider.parseWebhook(req);
  } catch (err) {
    console.error(`[webhooks] reading a ${name} event failed:`, errorTag(err));
    return { status: 500 };
  }
  if (events === "invalid") return { status: 400 };

  const db = deps.db ?? appDb;
  const orphans: string[] = [];
  let status: WebhookStatus = 200;
  for (const event of events) {
    try {
      const applied = await recordAndApply(db, name, event);
      if (applied?.orphan && !orphans.includes(applied.orphan)) orphans.push(applied.orphan);
    } catch (err) {
      console.error(`[webhooks] recording a ${name} event failed:`, errorTag(err));
      status = 500;
      break;
    }
  }

  // Also after a failure: the events committed before it are skipped on the retry, so their orphans
  // are canceled now or never.
  if (orphans.length > 0) {
    const work = () => cancelOrphans(provider, orphans);
    if (deps.defer) deps.defer(work);
    else await work();
  }
  return { status };
}
