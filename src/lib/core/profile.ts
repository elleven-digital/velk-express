import "server-only";
import { eq } from "drizzle-orm";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { db as appDb, clientUsers, users, type Db } from "@/lib/db";
import { isLocale, type Locale } from "@/lib/i18n";
import { fail, ok, type Result } from "./result";

/**
 * The signed-in person's own settings, on either side. Each person changes only their own row:
 * the session says whose.
 */

/**
 * The person's language: one of the supported locales, or null to follow the agency's. Anything
 * else is "invalidLocale" and nothing is saved.
 */
export async function setOwnLocale(
  session: TeamSession | PortalSession,
  locale: string | null,
  deps: { db?: Db } = {},
): Promise<Result<Locale | null>> {
  const db = deps.db ?? appDb;
  if (locale !== null && !isLocale(locale)) return fail("invalidLocale");
  if (session.userType === "agency") {
    await db.update(users).set({ locale }).where(eq(users.id, session.user.id));
  } else {
    await db.update(clientUsers).set({ locale }).where(eq(clientUsers.id, session.user.id));
  }
  return ok(locale);
}
