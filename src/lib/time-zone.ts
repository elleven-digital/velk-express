/**
 * The agency's time zone: it sets which month (hours cycle) and which day a moment falls in, and
 * the zone server-rendered times are shown in before the browser swaps in the viewer's own.
 */

/** The zone of an agency that never picked one (every install before the setting existed). */
export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

let supported: Set<string> | null = null;

/** The IANA names the runtime lists, plus UTC (some runtimes leave it out). Only for the select. */
function supportedZones(): Set<string> {
  supported ??= new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);
  return supported;
}

/** An IANA-shaped name: "UTC", "Europe/Lisbon", "America/Argentina/Buenos_Aires", "Etc/GMT+3". No offsets. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const MAX_ZONE_LENGTH = 64;

/**
 * The runtime's own spelling of a time zone name ("Asia/Kolkata" may come back as "Asia/Calcutta"),
 * or null when it is not a zone the runtime accepts. Not limited to `Intl.supportedValuesOf`, which
 * lists one spelling per zone and changes between runtime versions: an alias stays valid.
 */
export function canonicalTimeZone(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > MAX_ZONE_LENGTH || !ZONE_NAME.test(raw)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Whether `raw` names a time zone the runtime accepts (see `canonicalTimeZone`). */
export function isTimeZone(raw: string): boolean {
  return canonicalTimeZone(raw) !== null;
}

/** A stored zone in the runtime's spelling while it is still valid, else the default (a bad value never breaks a page). */
export function timeZoneOrDefault(raw: string | null | undefined): string {
  return (raw && canonicalTimeZone(raw)) || DEFAULT_TIME_ZONE;
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
