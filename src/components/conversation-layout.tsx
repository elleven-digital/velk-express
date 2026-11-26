"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { StickyFill } from "./sticky-fill";
import { cn } from "./ui";

/**
 * A ticket's page around its conversation, the same for the team and the client: one white box
 * with the title and the thread and, beside it, a column on the gray page. On wide screens the
 * box runs the window's height right next to the sidebar (`data-bleed` lifts the page's padding)
 * and only the messages scroll; when the column is taller than the window, the page scrolls it
 * while the box stays put.
 *
 * On phones the page is the screen's height and the box fills it edge to edge down to the tab bar
 * (the frame does that), so only the messages scroll; the column hides behind a `SideToggle` the
 * page puts on its title's line, which opens it as a sheet over the conversation. The column is rendered once, so its forms and ids exist once. The frame hides its
 * top bar for such a page.
 */
const SideContext = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null);

/** The phone's button that opens the column (hidden on wide screens, where the column shows). */
export function SideToggle({ label, icon, count }: { label: string; icon: IconName; count?: number }) {
  const side = useContext(SideContext);
  if (!side) return null;
  return (
    <button
      type="button"
      onClick={() => side.setOpen(true)}
      aria-expanded={side.open}
      aria-controls="conversation-side"
      className="lg:hidden inline-flex h-8 items-center gap-1.5 rounded-field border border-line bg-white px-2.5 text-[0.8125rem] font-medium text-ink"
    >
      <Icon name={icon} size={14} />
      {label}
      {count ? <span className="tabular text-muted">{count}</span> : null}
    </button>
  );
}

export function ConversationLayout({
  box,
  side,
  closeLabel,
}: {
  box: ReactNode;
  side: ReactNode;
  /** The label of the sheet's close button and of the backdrop (phones). */
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // a sheet left open on a phone closes when the window grows to the wide layout
    const wide = window.matchMedia("(min-width: 1024px)");
    const onWide = () => {
      if (wide.matches) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [open]);

  return (
    <SideContext.Provider value={{ open, setOpen }}>
      <div data-bleed className="grid max-lg:h-full max-lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,56rem)_320px] items-start">
        <StickyFill
          top={0}
          bottom={0}
          className={
            "max-lg:sticky max-lg:top-0 min-w-0 flex flex-col bg-white px-4 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-3 max-lg:h-full " +
            "lg:sticky lg:top-0 lg:h-dvh lg:border-r lg:border-line lg:px-8 lg:pt-7 lg:pb-6"
          }
        >
          {box}
        </StickyFill>

        {open ? (
          <button
            type="button"
            aria-label={closeLabel}
            onClick={() => setOpen(false)}
            className="lg:hidden fixed inset-0 z-40 bg-black/30"
          />
        ) : null}
        <div
          id="conversation-side"
          className={cn(
            "min-w-0 space-y-6 lg:p-6",
            open
              ? "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-50 max-lg:max-h-[85dvh] max-lg:overflow-y-auto max-lg:overscroll-contain max-lg:rounded-t-[16px] max-lg:bg-paper max-lg:px-4 max-lg:pt-14 max-lg:pb-[max(env(safe-area-inset-bottom),16px)] max-lg:shadow-[0_-12px_32px_-12px_rgb(0_0_0/0.25)]"
              : "max-lg:hidden",
          )}
        >
          {open ? (
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={closeLabel}
              className="lg:hidden absolute right-3 top-3 inline-flex size-9 items-center justify-center rounded-field text-muted hover:text-ink"
            >
              <Icon name="x" />
            </button>
          ) : null}
          {side}
        </div>
      </div>
    </SideContext.Provider>
  );
}
