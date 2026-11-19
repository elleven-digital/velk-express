import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { createDb, type Db } from "@/lib/db/client";

/**
 * Both helpers drop `public`: refuse anything that is not clearly a throwaway
 * database, so a mistaken TEST_DATABASE_URL can never wipe a real one.
 */
function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests.");
  let name = "";
  try {
    name = new URL(url).pathname.replace(/^\//, "");
  } catch {
    // reported below
  }
  if (!name.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must point to a database whose name ends in _test; refusing to drop its schema.");
  }
  return url;
}

/**
 * Rebuilds the test database from scratch (drops `public` and drizzle's own
 * `drizzle` schema, recreates `public`, applies every migration) and returns a
 * db bound to TEST_DATABASE_URL. Close it with `db.$client.end()`.
 */
export async function resetTestDb(): Promise<Db> {
  const { db } = createDb(testDatabaseUrl());
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

/**
 * Drops `public` and `drizzle` and recreates an empty `public`, without
 * migrating. Returns a db bound to TEST_DATABASE_URL.
 */
export async function emptyTestDb(): Promise<Db> {
  const { db } = createDb(testDatabaseUrl());
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  return db;
}
