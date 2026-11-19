import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "@/lib/db/client";
import { scrub } from "./backup";

/** True while the `agency` table does not exist yet (nothing has ever been installed). */
export async function isDatabaseEmpty(db: Db): Promise<boolean> {
  const rows = await db.execute(sql`SELECT to_regclass('public.agency') AS t`);
  return (rows[0] as { t: string | null }).t === null;
}

/** Journal entries minus the migrations drizzle has already recorded. */
export async function countPendingMigrations(db: Db, migrationsFolder: string): Promise<number> {
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  const exists = await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`);
  if ((exists[0] as { t: string | null }).t === null) return journal.entries.length;
  const rows = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
  return Math.max(0, journal.entries.length - (rows[0] as { n: number }).n);
}

export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export type BackupOutcome = { location: string } | { none: "empty database" | "SKIP_PRE_MIGRATION_BACKUP=true" };

/** Builds the operator-facing message for a failed migration; never contains the database password. */
export function migrationFailureMessage(error: unknown, databaseUrl: string, backup: BackupOutcome): string {
  const reason = scrub(error instanceof Error ? error.message : String(error), databaseUrl);
  const tail =
    "location" in backup
      ? `A backup taken before the migration is at ${backup.location}.`
      : `No backup was taken (${backup.none}).`;
  return `Migration failed: ${reason}. ${tail}`;
}
