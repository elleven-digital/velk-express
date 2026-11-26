"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CrumbProvider, useCrumbLabel } from "./crumbs";
import { AgencyAvatar } from "./agency-avatar";
import { Icon, type IconName } from "./icons";
import { Avatar, Count, cn } from "./ui";

export type NavItem = {
  href: string;
  label: string;
  exact?: boolean;
  icon?: IconName;
  /** Things waiting on the viewer there. */
  count?: number;
  /** The account group (team, settings) sits under a rule. */
  account?: boolean;
};

function isActive(pathname: string, item: NavItem): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(item.href + "/");
}

/** The item the current URL is in: the longest match, so "/admin" doesn't win over "/admin/team". */
function activeItem(pathname: string, items: NavItem[]): NavItem | undefined {
  return items
    .filter((item) => isActive(pathname, item))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/** Sidebar nav of the panel: quiet rows with an icon; the current one on a gray fill. */
export function SideNav({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  const current = activeItem(pathname, items);
  return (
    <nav aria-label={label} className="flex flex-col gap-px">
      {items.map((item, i) => {
        const active = item === current;
        const rule = item.account && i > 0 && !items[i - 1].account;
        return (
          <div key={item.href} className="contents">
            {rule ? <div className="h-px my-1 mx-2 bg-line" /> : null}
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 h-[34px] px-2 rounded-md text-[0.875rem] text-ink transition-colors",
                active ? "bg-line font-medium" : "hover:bg-chip"
              )}
            >
              {item.icon ? <Icon name={item.icon} /> : null}
              <span className="truncate">{item.label}</span>
              {item.count ? <Count n={item.count} className="ml-auto" /> : null}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Left side of the panel's top bar: the section, as a link once inside one
 * of its pages, then the page's own name (from <PageCrumb>).
 */
export function TopCrumbs({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const page = useCrumbLabel();
  const section = activeItem(pathname, items);
  const atSection = section && pathname === section.href;
  return (
    <div className="flex items-center gap-2 min-w-0 text-[0.875rem] text-muted">
      {section && !atSection && page ? (
        <>
          <Link href={section.href} className="whitespace-nowrap hover:text-ink transition-colors">
            {section.label}
          </Link>
          <span aria-hidden="true" className="text-line-strong">
            /
          </span>
          <b className="font-medium text-ink truncate">{page}</b>
        </>
      ) : (
        <b className="font-medium text-ink truncate">{section?.label ?? page}</b>
      )}
    </div>
  );
}

/**
 * Underline tabs: the client portal's header and the sections of a page
 * (a client's overview, sites, access, hours). Only the active one is marked,
 * with a black line.
 */
export function TabNav({ items, className, label }: { items: NavItem[]; className?: string; label?: string }) {
  const pathname = usePathname();
  const current = activeItem(pathname, items);
  return (
    <nav aria-label={label} className={cn("flex h-full gap-1 -mx-2.5 overflow-x-auto [scrollbar-width:none]", className)}>
      {items.map((item) => {
        const active = item === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-1.5 whitespace-nowrap px-2.5 py-3 text-[0.875rem] transition-colors",
              active ? "font-medium text-ink" : "text-muted hover:text-ink"
            )}
          >
            {item.label}
            {item.count ? <Count n={item.count} /> : null}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-2.5 bottom-0 h-0.5 transition-colors",
                active ? "bg-ink" : "bg-transparent"
              )}
            />
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Segmented filter: a gray track, the chosen option on white with a line.
 */
export function Segmented({
  items,
  label,
  className,
}: {
  items: { href: string; label: string; active: boolean }[];
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex items-center gap-0.5 rounded-lg bg-chip p-0.5", className)}
    >
      {items.map((item) => (
        <Link
          key={item.href + item.label}
          href={item.href}
          aria-current={item.active ? "true" : undefined}
          className={cn(
            "inline-flex items-center h-7 rounded-md px-3 text-[0.875rem] whitespace-nowrap transition-colors",
            item.active
              ? "bg-white font-medium text-ink ring-1 ring-line-strong/70"
              : "text-muted hover:text-ink"
          )}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * The phone's bottom tab bar: up to `max` sections with an icon. When there
 * are more, the last tab opens a sheet with the rest, plus `extra` (the
 * account block).
 */
export function BottomTabs({
  items,
  label,
  moreLabel,
  closeLabel,
  extra,
  max = 4,
}: {
  items: NavItem[];
  label: string;
  moreLabel: string;
  closeLabel: string;
  /** Rendered at the bottom of the "more" sheet; its presence adds the tab. */
  extra?: ReactNode;
  /** Tabs that fit, the "more" one included. */
  max?: number;
}) {
  const pathname = usePathname();
  const current = activeItem(pathname, items);
  // open on the page it was opened on: navigating from the sheet closes it
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (value: boolean | ((was: boolean) => boolean)) =>
    setOpenOn((typeof value === "function" ? value(open) : value) ? pathname : null);
  const overflow = extra !== undefined || items.length > max;
  const tabs = overflow ? items.slice(0, max - 1) : items;
  const rest = overflow ? items.slice(max - 1) : [];
  const restActive = rest.includes(current as NavItem);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenOn(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const tabClass = (active: boolean) =>
    cn(
      "relative flex flex-1 flex-col items-center gap-1 py-1.5 text-[0.6875rem] transition-colors",
      active ? "font-medium text-ink" : "text-muted"
    );

  return (
    <>
      <nav
        aria-label={label}
        className="lg:hidden sticky bottom-0 z-30 flex justify-around border-t border-line bg-white/95 backdrop-blur px-1 pt-1.5 pb-[max(env(safe-area-inset-bottom),10px)]"
      >
        {tabs.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item === current ? "page" : undefined}
            className={tabClass(item === current)}
          >
            <Icon name={item.icon ?? "home"} size={20} />
            <span className="truncate max-w-full">{item.label}</span>
            {item.count ? (
              <em className="absolute top-0 left-1/2 ml-1.5 min-w-4 h-4 px-1 rounded-full bg-ink text-white not-italic text-[0.625rem] font-medium leading-4 text-center tabular">
                {item.count}
              </em>
            ) : null}
          </Link>
        ))}
        {overflow ? (
          <button
            type="button"
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => setOpen((v) => !v)}
            className={tabClass(open || restActive)}
          >
            <Icon name="menu" size={20} />
            <span>{moreLabel}</span>
          </button>
        ) : null}
      </nav>

      {open ? (
        <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={moreLabel}>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/20"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-line bg-white px-2 pt-2 pb-[max(env(safe-area-inset-bottom),16px)]">
            <div className="flex items-center justify-between px-2 h-10">
              <span className="font-medium text-ink">{moreLabel}</span>
              <button
                type="button"
                aria-label={closeLabel}
                onClick={() => setOpen(false)}
                className="size-8 -mr-1 rounded-md text-muted hover:bg-chip hover:text-ink flex items-center justify-center"
              >
                <Icon name="x" />
              </button>
            </div>
            <div className="flex flex-col gap-px">
              {rest.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={item === current ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 h-11 px-2 rounded-md text-[0.9375rem] text-ink",
                    item === current ? "bg-line font-medium" : "hover:bg-chip"
                  )}
                >
                  {item.icon ? <Icon name={item.icon} size={18} /> : null}
                  {item.label}
                  {item.count ? <Count n={item.count} className="ml-auto" /> : null}
                </Link>
              ))}
            </div>
            {extra ? <div className="mt-1 border-t border-line pt-1">{extra}</div> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * A small dropdown (an account menu): the trigger toggles it;
 * a click outside or Escape closes it.
 */
export function Menu({
  label,
  trigger,
  children,
  className,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  // open on the page it was opened on: navigating closes it
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpenOn(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenOn(null);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpenOn(open ? null : pathname)}
        className="flex items-center gap-2 h-9 pl-1 pr-2 rounded-md font-medium text-ink hover:bg-chip transition-colors"
      >
        {trigger}
        <Icon name="chevron" size={14} className="text-muted" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-card border border-line bg-white p-1.5 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.18)]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The panel frame: a sidebar on wide screens (agency, sections, the signed-in
 * user with a log-out link under the name), a top bar with the breadcrumb, and a bottom tab bar on
 * phones. Pages render inside as children and may name themselves with
 * <PageCrumb> (PageHeader does it).
 */
export function ShellNav({
  agency,
  user,
  items,
  signOutAction,
  labels,
  children,
}: {
  agency: { name: string; logoUrl?: string | null };
  user: { name: string };
  items: NavItem[];
  /** A server action (or any form action) that ends the session. */
  signOutAction: () => void | Promise<void>;
  labels: { navigation: string; more: string; close: string; signOut: string };
  children: ReactNode;
}) {
  const account = (
    <div className="px-2 py-2">
      <div className="flex items-center gap-2.5 min-w-0">
        <Avatar name={user.name} size={32} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[0.875rem] font-medium text-ink">{user.name}</div>
          <form action={signOutAction}>
            <button
              type="submit"
              className="text-[0.8125rem] text-muted underline-offset-[3px] hover:text-ink hover:underline transition-colors"
            >
              {labels.signOut}
            </button>
          </form>
        </div>
      </div>
    </div>
  );

  return (
    <CrumbProvider>
      <div className="min-h-screen lg:flex">
        <aside className="max-lg:hidden w-60 flex-none sticky top-0 h-screen flex flex-col border-r border-line bg-white p-3">
          <div className="flex items-center gap-2.5 h-9 px-2 mb-3 min-w-0">
            <AgencyAvatar name={agency.name} logoUrl={agency.logoUrl} size={24} />
            <span className="truncate font-medium text-ink">{agency.name}</span>
          </div>
          <SideNav items={items} label={labels.navigation} />
          <div className="mt-auto border-t border-line pt-2">{account}</div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col min-h-screen">
          <header className="h-14 flex-none flex items-center gap-3 border-b border-line bg-white px-4 sm:px-6">
            <span className="lg:hidden inline-flex items-center gap-2 min-w-0 font-medium text-ink">
              <AgencyAvatar name={agency.name} logoUrl={agency.logoUrl} size={24} />
              <span className="truncate max-w-[40vw]">{agency.name}</span>
              <span aria-hidden="true" className="text-line-strong">
                /
              </span>
            </span>
            <TopCrumbs items={items} />
          </header>
          <main className="flex-1 mx-auto w-full max-w-6xl px-4 sm:px-6 py-8 max-sm:py-6">{children}</main>
          <BottomTabs
            items={items}
            label={labels.navigation}
            moreLabel={labels.more}
            closeLabel={labels.close}
            extra={account}
          />
        </div>
      </div>
    </CrumbProvider>
  );
}
