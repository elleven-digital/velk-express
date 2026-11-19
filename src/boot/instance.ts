import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootError";
  }
}

/** Creates the single instance row with a random secret key. Safe when two containers boot at once. */
export async function ensureInstance(db: Db): Promise<void> {
  const secretKey = randomBytes(32).toString("hex");
  await db.execute(sql`INSERT INTO instance (id, secret_key) VALUES (1, ${secretKey}) ON CONFLICT DO NOTHING`);
}
