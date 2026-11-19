import "server-only";
import { getStorage, storageDiskRoot } from "@/lib/storage";
import { sweepOrphans } from "@/boot/orphans";
import { sweepPaymentEvents } from "@/boot/retention";
import { db as appDb, type Db } from "@/lib/db";
import type { Storage } from "@/lib/storage";

/** Removes a stored object after its row is gone. A leftover object is harmless (nothing points at it), so a failure is only logged. */
export async function removeStoredObject(storage: Storage, key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await storage.remove(key);
  } catch (err) {
    console.error("Could not remove a stored file:", err);
  }
}

const SWEEP_EVERY_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

/**
 * Runs the orphan sweep and the payment event retention at most once an hour per process. Fire and forget: called after an
 * upload, never allowed to fail the request.
 */
export function maybeSweepOrphans(deps: { db?: Db; storage?: Storage; now?: number } = {}): void {
  const now = deps.now ?? Date.now();
  if (now - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = now;
  const db = deps.db ?? appDb;
  sweepOrphans({
    db,
    storage: deps.storage ?? getStorage(),
    diskRoot: storageDiskRoot(),
  }).catch((err) => console.error("Orphan sweep failed:", err));
  sweepPaymentEvents(db).catch((err) => console.error("Payment event retention failed:", err));
}

/** Test seam: forgets the last run. */
export function resetSweepThrottle(): void {
  lastSweepAt = 0;
}
