import "server-only";
import { cache } from "react";
import { db, agency } from "@/lib/db";
import { getAppUrl } from "@/lib/app-url";

export type AgencyBrand = { name: string; logoFileId: string | null; locale: string; currency: string };

/** The one agency of this install, or null before the install. */
export const getAgency = cache(async (): Promise<AgencyBrand | null> => {
  const [row] = await db.select().from(agency).limit(1);
  return row ? { name: row.name, logoFileId: row.logoFileId, locale: row.locale, currency: row.currency } : null;
});

/** Relative logo path for pages on this site, or null. */
export function logoPath(logoFileId: string | null): string | null {
  return logoFileId ? `/api/files/${logoFileId}` : null;
}

/** Absolute logo URL for e-mails (clients do not resolve relative paths), or null. */
export async function logoAbsoluteUrl(logoFileId: string | null): Promise<string | null> {
  return logoFileId ? `${await getAppUrl()}/api/files/${logoFileId}` : null;
}
