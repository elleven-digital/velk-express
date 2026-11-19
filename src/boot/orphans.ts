import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { and, inArray, isNull, like, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { agency, charges, files } from "@/lib/db/schema";
import type { Storage } from "@/lib/storage/types";

/*
 * Clean-up of what uploads leave behind: a file is uploaded first and claimed later, so one that
 * nobody claimed within a day (the message was never sent) is an orphan, and a crashed streaming
 * write leaves a `*.tmp`. Used at boot and, at most once an hour, after uploads.
 */

export const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Removes `*.tmp` files under `root` older than `maxAgeMs`; returns how many. A missing root is fine. */
export async function sweepStaleTemps(root: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  let removed = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".tmp")) {
        try {
          if (now - (await stat(full)).mtimeMs > maxAgeMs) {
            await rm(full, { force: true });
            removed++;
          }
        } catch {
          // Gone or unreadable meanwhile: nothing to do.
        }
      }
    }
  }
  await walk(path.resolve(root));
  return removed;
}

/**
 * Deletes the rows matching all `conditions` (at least one) that nobody holds: the candidates are locked with SKIP LOCKED,
 * so a row a claim is attaching right now is left for the next round, and only those still matching
 * go. Returns their storage keys.
 */
async function sweepRows(db: Db, conditions: [SQL, ...SQL[]]): Promise<{ storageKey: string }[]> {
  const where = and(...conditions);
  return db.transaction(async (tx) => {
    const candidates = await tx.select({ id: files.id }).from(files).where(where).for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    const ids = candidates.map((c) => c.id);
    return tx.delete(files).where(and(inArray(files.id, ids), where)).returning({ storageKey: files.storageKey });
  });
}

/**
 * Deletes unattached upload rows (stored under `attachments/`, no ticket, no message, not the
 * logo) older than a day, then their objects. Fiscal documents (stored under `documents/`) get the
 * same treatment when no charge references them: staff upload one before attaching it, so an
 * abandoned upload is an orphan too; one a charge holds is kept. Files of other kinds that never have a ticket
 * (future features) are left alone. Also removes stale temporary files on disk. Returns the counts.
 */
export async function sweepOrphans(opts: {
  db: Db;
  storage: Storage;
  /** The disk storage root, when files live on disk. */
  diskRoot?: string | null;
  now?: number;
  maxAgeMs?: number;
}): Promise<{ files: number; temps: number }> {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? ORPHAN_MAX_AGE_MS;
  const cutoff = new Date(now - maxAgeMs);

  const attachments: [SQL, ...SQL[]] = [
    like(files.storageKey, "attachments/%"),
    isNull(files.ticketId),
    isNull(files.messageId),
    lt(files.createdAt, cutoff),
    sql`${files.id} not in (select ${agency.logoFileId} from ${agency} where ${agency.logoFileId} is not null)`,
  ];
  const documents: [SQL, ...SQL[]] = [
    like(files.storageKey, "documents/%"),
    lt(files.createdAt, cutoff),
    sql`not exists (select 1 from ${charges} where ${charges.documentFileId} = ${files.id})`,
  ];
  const gone = [...(await sweepRows(opts.db, attachments)), ...(await sweepRows(opts.db, documents))];
  for (const row of gone) {
    try {
      await opts.storage.remove(row.storageKey);
    } catch (err) {
      console.error("Could not remove an orphaned file:", err);
    }
  }
  const temps = opts.diskRoot ? await sweepStaleTemps(opts.diskRoot, maxAgeMs, now) : 0;
  return { files: gone.length, temps };
}
