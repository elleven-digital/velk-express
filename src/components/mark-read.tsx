"use client";

import { useEffect } from "react";

/**
 * Marks the ticket read once its page is on screen. `at` is when the server rendered it, so a
 * message arriving meanwhile stays unread. A new render (a reply, a refresh) brings a new `at` and
 * marks again. It runs from an effect, never while rendering, so a prefetch marks nothing.
 */
export function MarkRead({ action, at }: { action: (at: string) => Promise<void>; at: string }): null {
  useEffect(() => {
    void action(at).catch(() => {});
  }, [action, at]);
  return null;
}
