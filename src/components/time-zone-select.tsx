"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Select } from "@/components/ui";
import { DEFAULT_TIME_ZONE, type TimeZoneGroup } from "@/lib/time-zone";

const subscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A select of every supported time zone, grouped by region. `value` is what to show (the saved zone,
 * or what was just submitted); one that is not in the list shows the saved `fallback` instead. With
 * `preferBrowser` and no `value`, it starts on the browser's own zone once hydrated, when the list
 * has it (the server renders `fallback`, then the browser swaps in its zone).
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
  const detected = useSyncExternalStore(subscribe, preferBrowser ? browserZone : () => null, () => null);
  const initial =
    value && known.has(value) ? value : detected && known.has(detected) ? detected : known.has(fallback) ? fallback : DEFAULT_TIME_ZONE;
  return (
    // A select keeps the default it mounted with: the key remounts it when the starting zone changes.
    <Select key={initial} id={id} name={name} defaultValue={initial}>
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
