import "server-only";
import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  getDict,
  isLocale,
  type Dict,
  type Locale,
} from "./index";
import { getAgency } from "@/lib/agency";
import { getPortalSession, getTeamSession } from "@/lib/auth/session";
import { AREA_HEADER } from "@/lib/area";

export const LOCALE_COOKIE = "vx_locale";

/** First supported language in an Accept-Language header, in header order. */
export function localeFromAcceptLanguage(header: string | null): Locale | null {
  for (const part of (header ?? "").split(",")) {
    const code = part.split(";")[0]?.trim().slice(0, 2).toLowerCase();
    if (isLocale(code)) return code;
  }
  return null;
}

/** The agency's language, or null before the install or when the database can't be reached. */
async function agencyLocale(): Promise<Locale | null> {
  try {
    const agency = await getAgency();
    return isLocale(agency?.locale) ? agency.locale : null;
  } catch {
    return null;
  }
}

/**
 * Locale for logged-out surfaces: cookie (the person's own choice, or a page's language picker) →
 * Accept-Language → `fallback` → the agency's language → en.
 */
export async function getPublicLocale(fallback?: Locale): Promise<Locale> {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const accept = (await headers()).get("accept-language");
  return localeFromAcceptLanguage(accept) ?? fallback ?? (await agencyLocale()) ?? DEFAULT_LOCALE;
}

export async function getPublicDict(fallback?: Locale): Promise<{ t: Dict; locale: Locale }> {
  const locale = await getPublicLocale(fallback);
  return { t: await getDict(locale), locale };
}

/** Locale for a signed-in team user: their own → the agency's → the logged-out rules. */
export async function getUserLocale(): Promise<Locale> {
  const session = await getTeamSession();
  if (isLocale(session?.user.locale)) return session.user.locale;
  const agency = await getAgency();
  if (isLocale(agency?.locale)) return agency.locale;
  return getPublicLocale();
}

export async function getUserDict(): Promise<{ t: Dict; locale: Locale }> {
  const locale = await getUserLocale();
  return { t: await getDict(locale), locale };
}

/** Locale for a signed-in portal person: their own → the agency's → the logged-out rules. */
export async function getPortalLocale(): Promise<Locale> {
  const session = await getPortalSession();
  if (isLocale(session?.user.locale)) return session.user.locale;
  const agency = await getAgency();
  if (isLocale(agency?.locale)) return agency.locale;
  return getPublicLocale();
}

export async function getPortalDict(): Promise<{ t: Dict; locale: Locale }> {
  const locale = await getPortalLocale();
  return { t: await getDict(locale), locale };
}

/** Locale of the current request by the area the proxy tagged it with; logged-out rules when missing. */
export async function getRequestLocale(): Promise<Locale> {
  const area = (await headers()).get(AREA_HEADER);
  try {
    if (area === "team") return await getUserLocale();
    if (area === "portal") return await getPortalLocale();
  } catch {
    // The database is unreachable: the root layout must still render, so fall back.
  }
  return getPublicLocale();
}
