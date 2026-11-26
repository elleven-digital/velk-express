import { redirect } from "next/navigation";
import { AgencyTimeZoneProvider } from "@/components/agency-time-zone";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ShellNav } from "@/components/shell-nav";
import { Callout, buttonClasses } from "@/components/ui";
import { getAgency, logoPath } from "@/lib/agency";
import { setTeamLocaleAction, signOut } from "@/lib/auth/actions";
import { requireTeam } from "@/lib/auth/guards";
import { DEFAULT_LOCALE, fmt, isLocale } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { getLatestRelease, isNewer, UPDATE_GUIDE_URL } from "@/lib/update-check";
import { APP_VERSION } from "@/lib/version";
import { teamNavItems } from "./nav-items";

export const dynamic = "force-dynamic";

/**
 * The panel's frame. Every page inside needs a team session; role rules live
 * in the pages; the menu per role is in `teamNavItems`.
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const session = await requireTeam();
  const [{ t }, agency] = await Promise.all([getUserDict(), getAgency()]);
  if (!agency) redirect("/install");

  const role = session.user.role;
  const items = teamNavItems(role, t.panel);

  // Only people who can act on an update see the notice; null (the common case
  // while the repository is private, or when the check is off) shows nothing.
  const latest = role === "owner" || role === "manager" ? await getLatestRelease() : null;
  const update = latest && isNewer(latest.version, APP_VERSION) ? latest : null;

  return (
    <ShellNav
      agency={{ name: agency.name, logoUrl: logoPath(agency.logoFileId) }}
      user={{ name: session.user.name }}
      items={items}
      signOutAction={signOut}
      labels={{ navigation: t.ui.sections, more: t.ui.more, close: t.ui.close, signOut: t.common.signOut }}
      accountExtra={
        <LanguageSwitcher
          action={setTeamLocaleAction}
          value={isLocale(session.user.locale) ? session.user.locale : null}
          agencyLocale={isLocale(agency.locale) ? agency.locale : DEFAULT_LOCALE}
          labels={{ language: t.ui.language, agency: t.ui.languageAgency }}
        />
      }
    >
      {update ? (
        <Callout
          tone="info"
          title={fmt(t.panel.updateTitle, { version: update.version })}
          className="mb-6"
          action={
            <div className="flex flex-wrap gap-2">
              <a href={update.url} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
                {t.panel.updateNotes}
              </a>
              <a href={UPDATE_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
                {t.panel.updateGuide}
              </a>
            </div>
          }
        >
          {fmt(t.panel.updateBody, { current: APP_VERSION })}
        </Callout>
      ) : null}
      <AgencyTimeZoneProvider timeZone={agency.timeZone}>{children}</AgencyTimeZoneProvider>
    </ShellNav>
  );
}
