// Development helper: applies pending migrations to DATABASE_URL with the same code the boot uses,
// without the pre-migration backup. Production containers migrate at boot (dist/boot.mjs).
import path from "node:path";
import { createDb } from "@/lib/db/client";
import { countPendingMigrations, runMigrations } from "@/boot/migrations";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required.");
  const folder = path.resolve(process.cwd(), "drizzle");
  const { db, close } = createDb(url, { connectTimeout: 5, quietNotices: true });
  try {
    const pending = await countPendingMigrations(db, folder);
    await runMigrations(db, folder);
    console.log(pending > 0 ? `Applied ${pending} migration(s).` : "Database is up to date.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(`Migration failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
