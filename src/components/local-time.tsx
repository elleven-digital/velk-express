"use client";

import { useSyncExternalStore } from "react";
import { formatMoment } from "@/lib/format";
import { CYCLE_TIME_ZONE } from "@/lib/hours";
import type { Locale } from "@/lib/i18n";

const subscribe = () => () => {};

/**
 * A moment in the viewer's own time zone. The server cannot know it, so it renders in the
 * installation's operating zone (`CYCLE_TIME_ZONE`) and the browser swaps in its own zone right after
 * hydrating (no mismatch warning, and the first paint already shows a plausible local time).
 * `iso` is an ISO instant, so nothing about the server's zone leaks into the page.
 */
export function LocalTime({ iso, locale }: { iso: string; locale: Locale }) {
  const text = useSyncExternalStore(
    subscribe,
    () => formatMoment(new Date(iso), locale),
    () => formatMoment(new Date(iso), locale, new Date(), CYCLE_TIME_ZONE),
  );
  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}
