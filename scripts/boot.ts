import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { readConfig, type AppConfig } from "@/lib/config";
import { createDb } from "@/lib/db/client";
import { s3Storage } from "@/lib/storage/s3";
import { sql } from "drizzle-orm";
import { sweepOrphans } from "@/boot/orphans";
import { sweepPaymentEvents } from "@/boot/retention";
import { diskStorage } from "@/lib/storage/disk";
import { BootError, ensureInstance } from "@/boot/instance";
import { countPendingMigrations, migrationFailureMessage, runMigrations } from "@/boot/migrations";
import { waitForDb } from "@/boot/wait-for-db";

const log = (message: string) => console.log(`[boot] ${message}`);

/** Host only: never print the URL, which carries the password. */
function maskedHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparsable DATABASE_URL)";
  }
}

/** Housekeeping, never a reason to stop booting. */
async function sweepAbandonedUploads(db: Parameters<typeof sweepOrphans>[0]["db"], config: AppConfig) {
  try {
    const diskRoot = config.s3 ? null : path.join(config.dataDir, "files");
    const storage = config.s3 ? s3Storage(config.s3) : diskStorage(diskRoot!);
    const swept = await sweepOrphans({ db, storage, diskRoot });
    if (swept.files > 0 || swept.temps > 0) log(`removed ${swept.files} abandoned upload(s) and ${swept.temps} temporary file(s)`);
  } catch (err) {
    console.warn("[boot] warning: could not clean up abandoned uploads:", err instanceof Error ? err.message : err);
  }
}

async function sweepOldPaymentEvents(db: Parameters<typeof sweepPaymentEvents>[0]) {
  try {
    const removed = await sweepPaymentEvents(db);
    if (removed > 0) log(`removed ${removed} payment event(s) older than 90 days`);
  } catch (err) {
    console.warn("[boot] warning: could not clean up old payment events:", err instanceof Error ? err.message : err);
  }
}

async function main() {
  const config = readConfig(process.env);
  for (const warning of config.warnings) console.warn(`[boot] warning: ${warning}`);

  if (!config.s3) {
    try {
      await mkdir(config.dataDir, { recursive: true });
      await access(config.dataDir, constants.W_OK);
    } catch {
      console.warn(`[boot] warning: DATA_DIR ${config.dataDir} is not writable; local uploads will not work.`);
    }
  }

  const { db, close } = createDb(config.databaseUrl, { connectTimeout: 5, quietNotices: true });
  try {
    log(`waiting for the database at ${maskedHost(config.databaseUrl)}`);
    await waitForDb(async () => {
      await db.execute(sql`select 1`);
    });

    const migrationsFolder = path.resolve(process.cwd(), "drizzle");

    // A session-level advisory lock on a reserved connection keeps two booting
    // containers from migrating at the same time.
    const lockConn = await db.$client.reserve();
    try {
      await lockConn`select pg_advisory_lock(hashtext('velk:boot'))`;

      const pendingMigrations = await countPendingMigrations(db, migrationsFolder);
      if (pendingMigrations > 0) {
        log(`applying ${pendingMigrations} migration(s)`);
        try {
          await runMigrations(db, migrationsFolder);
        } catch (err) {
          throw new BootError(migrationFailureMessage(err, config.databaseUrl));
        }
        log("migrations applied");
      } else {
        log("database is up to date");
      }
    } finally {
      await lockConn`select pg_advisory_unlock(hashtext('velk:boot'))`.catch(() => {});
      lockConn.release();
    }

    await ensureInstance(db);
    await sweepAbandonedUploads(db, config);
    await sweepOldPaymentEvents(db);
    log("ready");
  } finally {
    await close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[boot] failed: ${message}`);
  process.exit(1);
});
