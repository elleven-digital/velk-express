import type { ReactNode } from "react";
import { AgencyAvatar } from "./agency-avatar";

/**
 * Frame for login / password pages: the agency (logo or initial, name and
 * an area label) in a slim header, then the title, the form and a footer
 * line. The panel's look: white, one line, no card.
 */
export function AuthShell({
  title,
  sub,
  kicker,
  children,
  footer,
  agency,
  areaLabel,
  headerAction,
  wide,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** Short context line above the title. */
  kicker?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  agency: { name: string; logoUrl?: string | null };
  /** What this page is for, next to the agency name ("Client area"). */
  areaLabel?: string;
  /** Right side of the header, e.g. a language select. */
  headerAction?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-line">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-2.5 min-w-0">
            <AgencyAvatar name={agency.name} logoUrl={agency.logoUrl} size={24} />
            <span className="font-medium text-ink truncate">{agency.name}</span>
            {areaLabel ? <span className="max-sm:hidden text-muted whitespace-nowrap">{areaLabel}</span> : null}
          </span>
          {headerAction}
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-4 pt-14 lg:pt-24 pb-16">
        <div className={`w-full ${wide ? "max-w-md" : "max-w-sm"}`}>
          {kicker ? <p className="text-[0.875rem] font-medium text-muted mb-2">{kicker}</p> : null}
          <h1 className="text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.025em] text-ink">{title}</h1>
          {sub ? <p className="text-muted text-[0.875rem] mt-2 mb-8">{sub}</p> : <div className="mb-8" />}
          {children}
          {footer ? <div className="text-[0.875rem] text-muted mt-8">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
