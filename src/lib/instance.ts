import { eq } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import { db, instance } from "@/lib/db";
import { normalizeAppUrl } from "@/lib/app-url";
import { fail, ok, type Result } from "@/lib/core/result";

/** The instance row; the SECRET_KEY variable overrides the stored key. */
export async function getInstance(): Promise<{ secretKey: string; appUrl: string | null }> {
  const [row] = await db.select().from(instance).where(eq(instance.id, 1));
  if (!row) throw new Error("The instance row is missing: the boot step has not run and no install happened.");
  return { secretKey: getConfig().secretKey ?? row.secretKey, appUrl: row.appUrl };
}

/** Saves the public address. Refused ("lockedByEnv") when APP_URL is set. */
export async function setAppUrl(url: string): Promise<Result> {
  if (getConfig().appUrl) return fail("lockedByEnv");
  const normalized = normalizeAppUrl(url);
  if (!normalized) return fail("invalid");
  await db.update(instance).set({ appUrl: normalized }).where(eq(instance.id, 1));
  return ok();
}
