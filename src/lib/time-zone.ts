/**
 * The agency's time zone: it sets which month (hours cycle) and which day a moment falls in, and
 * the zone server-rendered times are shown in before the browser swaps in the viewer's own.
 */

/** The zone of an agency that never picked one (every install before the setting existed). */
export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

let supported: Set<string> | null = null;

/** The IANA names the runtime knows, plus UTC (some runtimes leave it out of the list). */
function supportedZones(): Set<string> {
  supported ??= new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);
  return supported;
}

/** Whether `raw` is an IANA time zone name the runtime supports, spelled exactly as it lists it. */
export function isTimeZone(raw: string): boolean {
  if (typeof raw !== "string" || !supportedZones().has(raw)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: raw });
    return true;
  } catch {
    return false;
  }
}

/** A stored zone when it is still valid, else the default (so a bad value never breaks a page). */
export function timeZoneOrDefault(raw: string | null | undefined): string {
  return raw && isTimeZone(raw) ? raw : DEFAULT_TIME_ZONE;
}

export type TimeZoneGroup = { region: string; zones: { value: string; label: string }[] };

/**
 * Every supported zone for a select, grouped by region ("America", "Europe"...) with UTC first.
 * The label is the rest of the name, readable: "America/Argentina/Buenos_Aires" is "Argentina / Buenos Aires".
 */
export function timeZoneGroups(): TimeZoneGroup[] {
  const groups = new Map<string, TimeZoneGroup>();
  for (const zone of [...supportedZones()].filter((z) => z !== "UTC").sort()) {
    const slash = zone.indexOf("/");
    const region = slash === -1 ? zone : zone.slice(0, slash);
    const label = (slash === -1 ? zone : zone.slice(slash + 1)).replaceAll("_", " ").replaceAll("/", " / ");
    const group = groups.get(region) ?? { region, zones: [] };
    group.zones.push({ value: zone, label });
    groups.set(region, group);
  }
  return [{ region: "UTC", zones: [{ value: "UTC", label: "UTC" }] }, ...groups.values()];
}
