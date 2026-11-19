import Link from "next/link";
import { redirect } from "next/navigation";
import { AgencyAvatar } from "@/components/agency-avatar";
import { AgencyTimeZoneProvider } from "@/components/agency-time-zone";
import { CompanySwitcher } from "@/components/company-switcher";
import { Icon } from "@/components/icons";
import { BottomTabs, Menu, TabNav, type NavItem } from "@/components/shell-nav";
import { Avatar } from "@/components/ui";
import { getAgency, logoPath } from "@/lib/agency";
import { signOutPortal } from "@/lib/auth/actions";
import { requirePortal } from "@/lib/auth/guards";
import { listCompanies } from "@/lib/auth/session";
import { countPendingPortalPayments } from "@/lib/core/portal-payments";
import { countSentPortalQuotes } from "@/lib/core/portal-quotes";
import { getPortalDict } from "@/lib/i18n/server";
import { switchCompanyAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The client portal's frame: one white bar with the agency, underline tabs and the account
 * menu; on phones a top strip and a bottom tab bar. Every page inside needs a portal session.
 * Proposals and payments are for the company admin, each with the count of those waiting.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePortal();
  const [{ t }, agency, companies, proposalCount, paymentCount] = await Promise.all([
    getPortalDict(),
    getAgency(),
    listCompanies(session.user.id),
    countSentPortalQuotes(session),
    countPendingPortalPayments(session),
  ]);
  if (!agency) redirect("/install");

  const { user, client } = session;
  const logoUrl = logoPath(agency.logoFileId);
  const items: NavItem[] = [
    { href: "/", label: t.portal.navHome, exact: true, icon: "home" },
    { href: "/tickets", label: t.portal.navTickets, icon: "inbox" },
    ...(session.role === "admin"
      ? [
          { href: "/quotes", label: t.portal.navQuotes, icon: "file" as const, count: proposalCount },
          { href: "/payments", label: t.portal.navPayments, icon: "receipt" as const, count: paymentCount },
          { href: "/users", label: t.portal.navUsers, icon: "users" as const },
        ]
      : []),
  ];

  const firstName = user.name.split(" ")[0];
  const account = (
    <>
      <div className="flex items-center gap-2.5 px-2 py-2">
        <Avatar name={user.name} kind="client" size={28} />
        <div className="min-w-0">
          <div className="font-medium text-ink truncate">{user.name}</div>
          <div className="text-[0.8125rem] text-muted truncate">{user.email}</div>
        </div>
      </div>
      <div className="px-2 pt-1 pb-2">
        <div className="text-[0.8125rem] text-muted mb-1">{t.portal.company}</div>
        {companies.length > 1 ? (
          <CompanySwitcher
            action={switchCompanyAction}
            companies={companies}
            currentId={client.id}
            label={t.portal.switchCompany}
          />
        ) : (
          <div className="font-medium text-ink">{client.name}</div>
        )}
      </div>
      <div className="border-t border-line mt-1 pt-1">
        <form action={signOutPortal}>
          <button
            type="submit"
            className="flex w-full items-center gap-2.5 h-9 px-2 rounded-md text-ink hover:bg-chip transition-colors"
          >
            <Icon name="logout" />
            {t.common.signOut}
          </button>
        </form>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="hidden lg:flex items-center gap-6 h-14 px-6 border-b border-line bg-white sticky top-0 z-30">
        <Link href="/" className="flex items-center gap-2.5 min-w-0 flex-none">
          <AgencyAvatar name={agency.name} logoUrl={logoUrl} size={24} />
          <span className="font-medium text-ink truncate max-w-56">{agency.name}</span>
          {/* a label, not a link: a quiet tag, then a rule before the sections */}
          <span className="inline-flex items-center h-6 px-2 rounded-md bg-chip text-[0.8125rem] text-muted whitespace-nowrap">
            {t.portal.clientArea}
          </span>
        </Link>
        <span aria-hidden className="h-5 w-px flex-none bg-line-strong" />
        <TabNav items={items} label={t.ui.sections} className="self-stretch" />
        <Menu
          label={t.portal.account}
          className="ml-auto"
          trigger={
            <>
              <Avatar name={user.name} kind="client" />
              {firstName}
            </>
          }
        >
          {account}
        </Menu>
      </header>

      {/* phone: the agency on top, the account on the right */}
      <div className="lg:hidden sticky top-0 z-30 flex items-center gap-2.5 h-[52px] pl-4 pr-2 border-b border-line bg-white/95 backdrop-blur">
        <Link href="/" className="flex items-center gap-2.5 min-w-0">
          <AgencyAvatar name={agency.name} logoUrl={logoUrl} size={24} />
          <span className="font-medium text-ink truncate">{agency.name}</span>
        </Link>
        <Menu label={t.portal.account} className="ml-auto" trigger={<Avatar name={user.name} kind="client" />}>
          {account}
        </Menu>
      </div>

      <main className="flex-1 w-full max-w-[1040px] mx-auto px-4 sm:px-6 lg:px-10 pt-5 lg:pt-8 pb-10 lg:pb-12">
        <AgencyTimeZoneProvider timeZone={agency.timeZone}>{children}</AgencyTimeZoneProvider>
      </main>

      <BottomTabs items={items} label={t.ui.sections} moreLabel={t.ui.more} closeLabel={t.ui.close} max={5} />
    </div>
  );
}
