import "server-only";
import { eq } from "drizzle-orm";
import { getAgency } from "@/lib/agency";
import type { TeamSession } from "@/lib/auth/session";
import { db as appDb, users, type Db } from "@/lib/db";
import { DEFAULT_LOCALE, isLocale, type Dict, type Locale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { es } from "@/lib/i18n/es";
import { pt } from "@/lib/i18n/pt";

/**
 * The actor of a connector request: the person behind the token, re-read on
 * every call. Removed from the team (the user row is gone), they have no
 * actor; demoted, the new role applies on the next call.
 */
export async function actorForUser(userId: string, db: Db = appDb): Promise<TeamSession | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user ? { userType: "agency", user } : null;
}

/** The agency's language: what a person who never picked their own reads. */
export async function agencyLocale(): Promise<Locale> {
  const brand = await getAgency();
  return isLocale(brand?.locale) ? brand.locale : DEFAULT_LOCALE;
}

const DICTS: Record<Locale, Dict> = { en: en as Dict, pt, es };

/** The dictionary of a language, synchronously: tool answers are built without awaiting it. */
export function dictOf(locale: Locale): Dict {
  return DICTS[locale] ?? (en as Dict);
}
