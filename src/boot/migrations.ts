import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "@/lib/db/client";

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

/** Removes the connection URL and its password from text that may be shown to the operator. */
export function scrub(text: string, databaseUrl: string): string {
  let out = text.split(databaseUrl).join("<database url>");
  try {
    const password = decodeURIComponent(new URL(databaseUrl).password);
    if (password) out = out.split(password).join("***");
  } catch {
    // an unparsable URL has nothing more to scrub
  }
  return out.trim();
}

/**
 * Builds the operator-facing message for a failed migration; never contains the database password.
 * Pending migrations run in one transaction, so a failure leaves the database as it was.
 */
export function migrationFailureMessage(error: unknown, databaseUrl: string): string {
  // Drizzle wraps the database error ("Failed query: ...") and keeps the real one in `cause`.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const reason = scrub(cause ? cause.message : error instanceof Error ? error.message : String(error), databaseUrl);
  return `Migration failed: ${reason}. The database was left unchanged; go back to the previous version and report the error.`;
}
