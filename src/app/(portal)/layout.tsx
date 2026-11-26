import { redirect } from "next/navigation";
import { AgencyTimeZoneProvider } from "@/components/agency-time-zone";
import { CompanySwitcher } from "@/components/company-switcher";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ShellNav, type NavItem } from "@/components/shell-nav";
import { getAgency, logoPath } from "@/lib/agency";
import { setPortalLocaleAction, signOutPortal } from "@/lib/auth/actions";
import { requirePortal } from "@/lib/auth/guards";
import { listCompanies } from "@/lib/auth/session";
import { countPendingPortalPayments } from "@/lib/core/portal-payments";
import { countSentPortalQuotes } from "@/lib/core/portal-quotes";
import { portalSections } from "@/lib/core/portal-tickets";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import { switchCompanyAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The client portal's frame, the same as the team's: a sidebar with the agency, the sections and
 * the account (with the company and its switcher), and on phones a top strip and a bottom tab bar. Every page inside needs a portal session.
 * Proposals and payments are for the company admin, each with the count of those waiting.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePortal();
  const [{ t }, agency, companies, proposalCount, paymentCount, sections] = await Promise.all([
    getPortalDict(),
    getAgency(),
    listCompanies(session.user.id),
    countSentPortalQuotes(session),
    countPendingPortalPayments(session),
    portalSections(session),
  ]);
  if (!agency) redirect("/install");

  const { user, client } = session;
  const items: NavItem[] = [
    { href: "/", label: t.portal.navHome, exact: true, icon: "home" },
    // Tickets while the company has support or has had a ticket; projects once it has had one.
    ...(sections.tickets ? [{ href: "/tickets", label: t.portal.navTickets, icon: "inbox" as const }] : []),
    ...(sections.projects ? [{ href: "/projects", label: t.portal.navProjects, icon: "layers" as const }] : []),
    ...(session.role === "admin"
      ? [
          { href: "/quotes", label: t.portal.navQuotes, icon: "file" as const, count: proposalCount },
          { href: "/payments", label: t.portal.navPayments, icon: "receipt" as const, count: paymentCount },
          { href: "/users", label: t.portal.navUsers, icon: "users" as const },
        ]
      : []),
  ];

  // Under the name in the sidebar: the company the person is in (the switcher when they have more)
  // and their own language.
  const company =
    companies.length > 1 ? (
      <CompanySwitcher action={switchCompanyAction} companies={companies} currentId={client.id} label={t.portal.switchCompany} />
    ) : (
      <div className="truncate text-[0.8125rem] text-muted">{client.name}</div>
    );
  const account = (
    <div className="space-y-2.5">
      {company}
      <LanguageSwitcher
        action={setPortalLocaleAction}
        value={isLocale(user.locale) ? user.locale : null}
        agencyLocale={isLocale(agency.locale) ? agency.locale : DEFAULT_LOCALE}
        labels={{ language: t.ui.language, agency: t.ui.languageAgency }}
      />
    </div>
  );

  return (
    <ShellNav
      agency={{ name: agency.name, logoUrl: logoPath(agency.logoFileId), area: t.portal.clientArea }}
      user={{ name: user.name, kind: "client" }}
      items={items}
      signOutAction={signOutPortal}
      labels={{ navigation: t.ui.sections, more: t.ui.more, close: t.ui.close, signOut: t.common.signOut }}
      accountExtra={account}
      crumbBar={false}
    >
      <AgencyTimeZoneProvider timeZone={agency.timeZone}>{children}</AgencyTimeZoneProvider>
    </ShellNav>
  );
}
