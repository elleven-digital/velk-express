"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * A box that sticks to the top while the page scrolls and may grow down to `bottom` px above the
 * window's bottom edge: a short thread keeps its own height (messages on top, the composer right
 * under them), a long one stops at the window's edge and scrolls inside, so the composer stays in
 * view. From `minWidth` up; below it only with `mobileBottom`, otherwise the box keeps its CSS
 * max-height. The className should carry a CSS max-height close to the first position, so the
 * server-rendered page doesn't jump before this runs.
 */
/**
 * The least the box shrinks to: about the composer and a message above it. Kept small so the
 * composer stays on screen in a short window, where the page's header takes most of the height.
 */
const MIN_HEIGHT = 200;

export function StickyFill({
  className,
  children,
  top = 24,
  bottom = 24,
  minWidth = 1024,
  mobileBottom,
}: {
  className?: string;
  children: ReactNode;
  top?: number;
  bottom?: number;
  minWidth?: number;
  mobileBottom?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (window.innerWidth < minWidth) {
        if (mobileBottom === undefined) {
          el.style.maxHeight = "";
          return;
        }
        // where the box starts on the page, so scrolling doesn't change it
        const start = el.getBoundingClientRect().top + window.scrollY;
        el.style.maxHeight = `${Math.max(MIN_HEIGHT, window.innerHeight - start - mobileBottom)}px`;
        return;
      }
      const start = Math.max(top, el.getBoundingClientRect().top);
      el.style.maxHeight = `${Math.max(MIN_HEIGHT, window.innerHeight - start - bottom)}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [top, bottom, minWidth, mobileBottom]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
