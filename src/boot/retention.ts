import { lt } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { paymentEvents } from "@/lib/db/schema";

/*
 * Payment webhook event ids only exist to ignore a provider's redelivery. Providers retry for days,
 * not months, so older ones are dead weight. Runs at boot and on the same hourly cadence as the
 * orphan sweep.
 */

export const PAYMENT_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Deletes payment events received more than 90 days ago; returns how many. */
export async function sweepPaymentEvents(db: Db, now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - PAYMENT_EVENT_RETENTION_MS);
  const gone = await db.delete(paymentEvents).where(lt(paymentEvents.receivedAt, cutoff)).returning({ id: paymentEvents.id });
  return gone.length;
}
