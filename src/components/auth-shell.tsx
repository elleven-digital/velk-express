import type { ReactNode } from "react";
import { setVisitorLocaleAction } from "@/lib/auth/actions";
import type { Locale } from "@/lib/i18n";
import { AgencyAvatar } from "./agency-avatar";
import { VisitorLanguage } from "./visitor-language";

/**
 * Frame for login / password pages: the agency (logo or initial, name and an area label) centered
 * on the gray page, then a white box with the title and the form, and a footer line under it
 * (with a language picker on the logged-out pages).
 * The login pages name the area in the title instead, and pass no area label.
 */
export function AuthShell({
  title,
  sub,
  kicker,
  children,
  footer,
  agency,
  areaLabel,
  language,
  wide,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** Short context line above the title. */
  kicker?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  agency: { name: string; logoUrl?: string | null };
  /** What this page is for, under the agency name ("Client area"). */
  areaLabel?: string;
  /** The page's language, with a picker for it beside the footer line (logged-out pages). */
  language?: { value: Locale; label: string };
  wide?: boolean;
}) {
  return (
    <main className="min-h-screen bg-paper flex items-start justify-center px-4 pt-12 sm:pt-[10vh] pb-16">
      <div className={`w-full ${wide ? "max-w-lg" : "max-w-md"}`}>
        {/* the agency above the box, on the gray page */}
        <div className="flex flex-col items-center text-center mb-6">
          <AgencyAvatar name={agency.name} logoUrl={agency.logoUrl} size={80} />
          <div className="mt-3 max-w-full text-[1.0625rem] font-semibold tracking-[-0.01em] text-ink truncate">{agency.name}</div>
          {areaLabel ? <div className="mt-0.5 text-[0.875rem] text-muted">{areaLabel}</div> : null}
        </div>
        <div className="rounded-card border border-line bg-white p-8 max-sm:p-6">
          {kicker ? <p className="text-[0.875rem] font-medium text-muted mb-2">{kicker}</p> : null}
          <h1 className="text-[1.5rem] leading-[1.2] font-semibold tracking-[-0.025em] text-ink">{title}</h1>
          {sub ? <p className="text-muted text-[0.875rem] mt-2 mb-7">{sub}</p> : <div className="mb-7" />}
          {children}
        </div>
        {footer || language ? (
          <div className="flex flex-wrap items-center justify-between gap-3 mt-6 px-1 text-[0.875rem] text-muted">
            <div>{footer}</div>
            {language ? <VisitorLanguage action={setVisitorLocaleAction} value={language.value} label={language.label} /> : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
