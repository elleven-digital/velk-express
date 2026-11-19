import { en } from "./en";

type DeepString<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepString<T[K]>;
};

export type Dict = DeepString<typeof en>;

export const LOCALES = ["en", "pt", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  pt: "Português",
  es: "Español",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

let dicts: Record<Locale, Dict> | null = null;

/** Loads (and caches) the dictionaries; an unknown locale falls back to en. */
export async function getDict(locale: Locale): Promise<Dict> {
  if (!dicts) {
    const [{ pt }, { es }] = await Promise.all([import("./pt"), import("./es")]);
    dicts = { en: en as Dict, pt, es };
  }
  return dicts[locale] ?? (en as Dict);
}

/**
 * Looks a message up by a key that may come from a query string: only the map's own keys count,
 * so `constructor`, `toString` or `__proto__` find nothing instead of an inherited member.
 */
export function lookup(map: Record<string, string>, key: string | null | undefined): string | undefined {
  return key !== null && key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Replaces {placeholders} in a translated string. */
export function fmt(
  template: string,
  vars: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{${key}}`
  );
}

/** Options of the cookie that remembers a visitor's language (a year); secure on an https address. */
export function localeCookieOptions(secure: boolean) {
  return { path: "/", maxAge: 365 * 24 * 3600, sameSite: "lax" as const, secure };
}
