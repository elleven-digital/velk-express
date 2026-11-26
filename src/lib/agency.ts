import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db as appDb, agency, type Db } from "@/lib/db";
import { getAppUrl } from "@/lib/app-url";
import { timeZoneOrDefault } from "@/lib/time-zone";

export type AgencyBrand = {
  name: string;
  logoFileId: string | null;
  locale: string;
  currency: string;
  timeZone: string;
  /** How a client who can't sign in reaches the agency (portal login); null when not set. */
  supportEmail: string | null;
  supportPhone: string | null;
};

/** The one agency of this install, or null before the install. Read once per request. */
export const getAgency = cache(async (): Promise<AgencyBrand | null> => {
  const [row] = await appDb.select().from(agency).limit(1);
  return row
    ? {
        name: row.name,
        logoFileId: row.logoFileId,
        locale: row.locale,
        currency: row.currency,
        timeZone: timeZoneOrDefault(row.timeZone),
        supportEmail: row.supportEmail,
        supportPhone: row.supportPhone,
      }
    : null;
});

/**
 * The agency's time zone read through `db` (core functions pass their own database or transaction),
 * the default before the install or when the stored name is no longer supported.
 */
export async function agencyTimeZone(db: Db = appDb): Promise<string> {
  const [row] = await db.select({ timeZone: agency.timeZone }).from(agency).where(eq(agency.id, 1));
  return timeZoneOrDefault(row?.timeZone);
}

/** Relative logo path for pages on this site, or null. */
export function logoPath(logoFileId: string | null): string | null {
  return logoFileId ? `/api/files/${logoFileId}` : null;
}

/** Absolute logo URL for e-mails (clients do not resolve relative paths), or null. */
export async function logoAbsoluteUrl(logoFileId: string | null): Promise<string | null> {
  return logoFileId ? `${await getAppUrl()}/api/files/${logoFileId}` : null;
}
