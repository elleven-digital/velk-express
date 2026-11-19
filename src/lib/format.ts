import type { Currency } from "@/lib/core/settings";
import type { Locale } from "@/lib/i18n";

const INTL_LOCALE: Record<Locale, string> = { en: "en-US", pt: "pt-BR", es: "es-ES" };

/** The largest amount in cents a Postgres `integer` column holds. */
const MAX_CENTS = 2_147_483_647;

/** Integer cents in the agency's currency, styled for the viewer's language. */
export function formatMoney(cents: number, currency: Currency, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], { style: "currency", currency }).format(cents / 100);
}

/** A money input in the convention people type it ("1.200,50" or "1,200.50"), as integer cents. */
export function parseMoney(raw: string): number | null {
  const text = raw.trim();
  if (text.startsWith("-")) return null;
  // An optional currency symbol before or after (not both), around only digits, spaces and the two
  // separators: anything else is garbage.
  const match = /^(?:(?:R\$|US\$|\$|€)\s*([\d\s.,]+)|([\d\s.,]+?)\s*(?:R\$|US\$|\$|€)|([\d\s.,]+))$/.exec(text);
  if (!match) return null;
  const s = (match[1] ?? match[2] ?? match[3]).replace(/\s/g, "");
  if (!/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let integer = s;
  let decimal = "";
  if (lastComma !== -1 || lastDot !== -1) {
    // With both marks the last one is the decimal; a lone one is decimal unless it
    // repeats ("1.200.300") or leaves three digits after it ("1.200"): then it groups.
    const at = Math.max(lastComma, lastDot);
    const tail = s.slice(at + 1);
    const both = lastComma !== -1 && lastDot !== -1;
    const repeated = s.indexOf(s[at]) !== at;
    // "0,005" / "0.001": a leading zero before one separator is a decimal, never a group.
    const leadingZero = !both && !repeated && s.slice(0, at) === "0";
    // With both marks the decimal one comes last and only once ("1.500,50.20" is garbage).
    if (both && repeated) return null;
    if (!repeated && (both || tail.length <= 2 || leadingZero)) {
      integer = s.slice(0, at);
      decimal = tail;
    }
  }
  integer = integer.replace(/[.,]/g, "");
  decimal = decimal.replace(/[.,]/g, "").slice(0, 2).padEnd(2, "0");

  const cents = Number(integer || "0") * 100 + Number(decimal);
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return cents;
}

/** Cents as the plain text a money input starts with, in the viewer's convention ("1500,50" / "1500.50"). */
export function moneyInputValue(cents: number | null, locale: Locale): string {
  if (cents === null) return "";
  const text = (cents / 100).toFixed(2);
  return locale === "en" ? text : text.replace(".", ",");
}

/** What an empty money input hints, in the viewer's convention. */
export function moneyPlaceholder(locale: Locale): string {
  return locale === "en" ? "1,200.00" : "1.200,00";
}

/** A file size for people: "900 B", "2,4 MB" (binary units, one decimal). */
export function formatBytes(bytes: number, locale: Locale): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    value /= 1024;
    unit = u;
    if (value < 1024) break;
  }
  const number = new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: value >= 100 ? 0 : 1 }).format(value);
  return `${number} ${unit}`;
}

/**
 * A moment for a message or a file: short date and time, with the year only when it is not this one.
 * `timeZone` is an IANA name; left out, the runtime's zone (the browser's, in client components).
 */
export function formatMoment(at: Date, locale: Locale, now: Date = new Date(), timeZone?: string): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    ...(timeZone ? { timeZone } : {}),
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

/** Minutes as "45min", "1h", "1h30", "2h05"; a negative balance keeps its sign. The same in every language. */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m}min`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h${String(m).padStart(2, "0")}`;
}

/** A cycle ("YYYY-MM") as month and year: "novembro de 2026". */
export function formatCycle(cycle: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: "UTC", month: "long", year: "numeric" }).format(
    new Date(`${cycle}-01T12:00:00Z`),
  );
}

/** The first day of the cycle after this one: "1 de dezembro". */
export function formatNextCycleStart(cycle: string, locale: Locale): string {
  const [year, month] = cycle.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1, 12));
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: "UTC", day: "numeric", month: "long" }).format(next);
}

/** A calendar day ("YYYY-MM-DD") for people, without shifting it across time zones. */
export function formatDay(isoDay: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${isoDay}T12:00:00Z`));
}
