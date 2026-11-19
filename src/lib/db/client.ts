import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig } from "@/lib/config";
import * as schema from "./schema";

export type SslMode = "require" | "verify-ca" | "verify-full";

/** Returns the SSL mode the URL asks for, or null (no SSL). Passed through unchanged so verify-* keeps verifying. */
export function sslModeFor(url: string): SslMode | null {
  try {
    const mode = new URL(url).searchParams.get("sslmode");
    return mode === "require" || mode === "verify-ca" || mode === "verify-full" ? mode : null;
  } catch {
    return null;
  }
}

/**
 * Maps the URL's sslmode to postgres.js's `ssl` option. postgres.js has no
 * "verify-ca" string, so it becomes an explicit verifying TLS config.
 */
export function sslOptionFor(url: string): false | "require" | "verify-full" | { rejectUnauthorized: true } {
  const mode = sslModeFor(url);
  if (mode === null) return false;
  if (mode === "verify-ca") return { rejectUnauthorized: true };
  return mode;
}

/**
 * Creates a fresh drizzle instance. The underlying postgres.js client is
 * available as `db.$client`; call `close()` (or `db.$client.end()`) to release
 * the pool. The boot script and tests use this; the app uses the lazy `db`.
 */
export function createDb(url: string, options: { connectTimeout?: number; quietNotices?: boolean } = {}) {
  const client = postgres(url, {
    max: 10,
    ssl: sslOptionFor(url),
    ...(options.connectTimeout ? { connect_timeout: options.connectTimeout } : {}),
    ...(options.quietNotices ? { onnotice: () => {} } : {}),
  });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];

let instance: Db | null = null;

function getDb(): Db {
  instance ??= createDb(getConfig().databaseUrl).db;
  return instance;
}

/**
 * Lazy handle: nothing connects (or reads config) until the first property
 * access, so importing this module is safe during `next build`.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
