import { eq } from "drizzle-orm";
import { findUserForReset, normalizeEmail } from "@/lib/auth/credentials";
import { authLinkPath, issueAuthToken } from "@/lib/auth/tokens";
import type { Db } from "@/lib/db/client";
import { instance } from "@/lib/db";

export type ResetLinkResult =
  | { ok: true; name: string; /** Absolute when the public address is known, else the path only. */ link: string; absolute: boolean }
  | { ok: false; reason: "invalidEmail" | "notFound" };

/**
 * Issues a password link for an existing TEAM user (never a portal user), with the same issuer as
 * "forgot password": same purpose and validity, and earlier reset links of that user stop working.
 * `appUrl` is the APP_URL variable; when empty the address saved at install is used.
 */
export async function createResetLink(db: Db, rawEmail: string, appUrl: string | null): Promise<ResetLinkResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalidEmail" };
  const user = await findUserForReset("team", email, db);
  if (!user) return { ok: false, reason: "notFound" };

  const path = authLinkPath(await issueAuthToken("reset", user.userType, user.id, db));
  const [row] = await db.select({ appUrl: instance.appUrl }).from(instance).where(eq(instance.id, 1));
  const origin = appUrl ?? row?.appUrl ?? null;
  return origin ? { ok: true, name: user.name, link: `${origin}${path}`, absolute: true } : { ok: true, name: user.name, link: path, absolute: false };
}
