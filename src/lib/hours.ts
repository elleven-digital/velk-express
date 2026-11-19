const CYCLE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function zoneParts(at: Date, timeZone: string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** The cycle ("YYYY-MM") a moment falls in, in the agency's time zone. */
export function cycleKey(at: Date, timeZone: string): string {
  const { year, month } = zoneParts(at, timeZone);
  return `${year}-${month}`;
}

/** The calendar day ("YYYY-MM-DD") a moment falls on, in the agency's time zone. */
export function todayInCycleZone(at: Date, timeZone: string): string {
  const { year, month, day } = zoneParts(at, timeZone);
  return `${year}-${month}-${day}`;
}

/** Whether a string is a well-formed cycle: "YYYY-MM" with a real month. */
export function isCycle(raw: string): boolean {
  return CYCLE_PATTERN.test(raw);
}

/** The first and last day of a cycle, inclusive, as "YYYY-MM-DD". */
export function cycleRange(cycle: string): { start: string; end: string } {
  const match = CYCLE_PATTERN.exec(cycle);
  if (!match) throw new Error(`Invalid cycle: ${cycle}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${cycle}-01`, end: `${cycle}-${String(last).padStart(2, "0")}` };
}

/** The cycle `months` away from this one (negative goes back). */
export function shiftCycle(cycle: string, months: number): string {
  const match = CYCLE_PATTERN.exec(cycle);
  if (!match) throw new Error(`Invalid cycle: ${cycle}`);
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + months, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * A typed duration as whole minutes: "90", "45min", "1h", "1h30", "1:30", "1,5h" or "1.5h".
 * Null when it is not one of those or falls outside `min`..`max` minutes (1..1440 by default).
 */
export function parseDuration(raw: string, opts: { max?: number } = {}): number | null {
  const max = opts.max ?? 1440;
  const text = raw.trim().toLowerCase();
  let minutes: number | null = null;

  let m: RegExpExecArray | null;
  if ((m = /^(\d+)$/.exec(text)) || (m = /^(\d+)\s*(?:m|min|mins)$/.exec(text))) {
    minutes = Number(m[1]);
  } else if ((m = /^(\d+)\s*h$/.exec(text))) {
    minutes = Number(m[1]) * 60;
  } else if ((m = /^(\d+)\s*h\s*(\d{1,2})\s*(?:m|min|mins)?$/.exec(text))) {
    const extra = Number(m[2]);
    if (extra > 59) return null;
    minutes = Number(m[1]) * 60 + extra;
  } else if ((m = /^(\d+):([0-5]\d)$/.exec(text))) {
    minutes = Number(m[1]) * 60 + Number(m[2]);
  } else if ((m = /^(\d+)[.,](\d+)\s*h$/.exec(text))) {
    minutes = Math.round(Number(`${m[1]}.${m[2]}`) * 60);
  }

  if (minutes === null || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > max) return null;
  return minutes;
}

/** The most one purchase can register, in minutes. */
export const MAX_PURCHASE_MINUTES = 100000;

/**
 * The quantity typed in a purchase of hours, as minutes. A bare number ("10", "1,5") is hours,
 * because that is what is bought; every other form is read as `parseDuration` does.
 */
export function parsePurchaseQuantity(raw: string): number | null {
  const text = raw.trim();
  const bare = /^\d+(?:[.,]\d+)?$/.test(text);
  return parseDuration(bare ? `${text}h` : text, { max: MAX_PURCHASE_MINUTES });
}

/**
 * Minutes as hours for a form field: at most two decimals, no trailing zeros ("90" -> "1.5",
 * "100" -> "1.67"). Zero is empty. The included-hours action accepts up to two decimals back.
 */
export function minutesToHoursInput(minutes: number): string {
  if (!(minutes > 0)) return "";
  return String(Math.round((minutes / 60) * 100) / 100);
}
