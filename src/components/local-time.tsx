"use client";

import { useSyncExternalStore } from "react";
import { useAgencyTimeZone } from "@/components/agency-time-zone";
import { formatMoment } from "@/lib/format";
import type { Locale } from "@/lib/i18n";

const subscribe = () => () => {};

/**
 * A moment in the viewer's own time zone. The server cannot know it, so it renders in the agency's
 * time zone (from `AgencyTimeZoneProvider`) and the browser swaps in its own zone right after
 * hydrating (no mismatch warning, and the first paint already shows a plausible local time).
 * `iso` is an ISO instant, so nothing about the server's zone leaks into the page.
 */
export function LocalTime({ iso, locale }: { iso: string; locale: Locale }) {
  const timeZone = useAgencyTimeZone();
  const text = useSyncExternalStore(
    subscribe,
    () => formatMoment(new Date(iso), locale),
    () => formatMoment(new Date(iso), locale, new Date(), timeZone),
  );
  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}
