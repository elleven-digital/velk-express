"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Select } from "@/components/ui";
import { DEFAULT_TIME_ZONE, type TimeZoneGroup } from "@/lib/time-zone";

const subscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const noZone = () => null;

/** This browser's spelling of a zone, or null when it does not know the name. */
function resolve(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The list entry naming the same zone as `zone`, even when the browser and the server spell it differently. */
export function matchInList(zone: string, known: Set<string>): string | null {
  if (known.has(zone)) return zone;
  const target = resolve(zone);
  if (!target) return null;
  for (const v of known) if (resolve(v) === target) return v;
  return null;
}

/**
 * A select of every supported time zone, grouped by region. `value` is what was just submitted; one
 * that is not in the list (forged) shows the saved `fallback` instead. A saved zone the list does
 * not have (an alias, or a name a newer runtime spells differently) is added as its own option, so
 * saving again never swaps it for another zone. With `preferBrowser` and no `value`, it starts on
 * the browser's own zone once hydrated, when the list has that zone under any spelling (the server
 * renders `fallback`, then the browser swaps in its zone).
 */
export function TimeZoneSelect({
  id,
  name,
  groups,
  value,
  fallback = DEFAULT_TIME_ZONE,
  preferBrowser = false,
}: {
  id: string;
  name: string;
  groups: TimeZoneGroup[];
  value?: string;
  fallback?: string;
  preferBrowser?: boolean;
}) {
  const known = useMemo(() => new Set(groups.flatMap((g) => g.zones.map((z) => z.value))), [groups]);
  const detected = useSyncExternalStore(subscribe, preferBrowser ? browserZone : noZone, noZone);
  const fromBrowser = useMemo(() => (detected ? matchInList(detected, known) : null), [detected, known]);
  const initial = value && known.has(value) ? value : (fromBrowser ?? fallback);
  return (
    // A select keeps the default it mounted with: the key remounts it when the starting zone changes.
    <Select key={initial} id={id} name={name} defaultValue={initial}>
      {known.has(fallback) ? null : <option value={fallback}>{fallback.replaceAll("_", " ")}</option>}
      {groups.map((g) =>
        g.region === "UTC" ? (
          g.zones.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))
        ) : (
          <optgroup key={g.region} label={g.region}>
            {g.zones.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </Select>
  );
}
