import type { ReactNode } from "react";
import { StickyFill } from "./sticky-fill";

/**
 * A ticket's page around its conversation, the same for the team and the client: one white box
 * with the title and the thread and, beside it, a column on the gray page. On wide screens the
 * box runs the window's height right next to the sidebar (`data-bleed` lifts the page's padding)
 * and only the messages scroll; when the column is taller than the window, the page scrolls it
 * while the box stays put.
 * On phones the box sits in the page, down to just above the tab bar. The frame hides its top bar
 * on wide screens for such a page.
 */
export function ConversationLayout({
  box,
  side,
}: {
  box: ReactNode;
  side: ReactNode;
}) {
  return (
    <div data-bleed className="grid lg:grid-cols-[minmax(0,56rem)_320px] gap-6 lg:gap-0 items-start">
      <StickyFill
        top={0}
        bottom={0}
        mobileBottom={84}
        className={
          "min-w-0 flex flex-col rounded-card border border-line bg-white p-4 max-sm:p-3 max-h-[calc(100dvh-10rem)] " +
          "lg:sticky lg:top-0 lg:h-dvh lg:rounded-none lg:border-y-0 lg:border-l-0 lg:px-8 lg:pt-7 lg:pb-6"
        }
      >
        {box}
      </StickyFill>
      <div className="min-w-0 space-y-6 lg:p-6">
        {side}
      </div>
    </div>
  );
}
