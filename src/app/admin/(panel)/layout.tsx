import { redirect } from "next/navigation";
import { AgencyTimeZoneProvider } from "@/components/agency-time-zone";
import { ShellNav, type NavItem } from "@/components/shell-nav";
import { Callout, buttonClasses } from "@/components/ui";
import { getAgency, logoPath } from "@/lib/agency";
import { signOut } from "@/lib/auth/actions";
import { requireTeam } from "@/lib/auth/guards";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { getLatestRelease, isNewer, UPDATE_GUIDE_URL } from "@/lib/update-check";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * The panel's frame. Every page inside needs a team session; role rules live
 * in the pages. Team is for the owner only; settings open for the owner and the manager (the manager sees only the labels).
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const session = await requireTeam();
  const [{ t }, agency] = await Promise.all([getUserDict(), getAgency()]);
  if (!agency) redirect("/install");

  const role = session.user.role;
  const items: NavItem[] = [
    { href: "/admin", label: t.panel.navHome, icon: "home", exact: true },
    { href: "/admin/tickets", label: t.panel.navTickets, icon: "inbox" },
    { href: "/admin/clients", label: t.panel.navClients, icon: "brief" },
  ];
  if (role === "owner") items.push({ href: "/admin/quotes", label: t.panel.navQuotes, icon: "file" });
  if (role === "owner" || role === "manager") items.push({ href: "/admin/charges", label: t.panel.navCharges, icon: "receipt" });
  if (role === "owner") items.push({ href: "/admin/team", label: t.panel.navTeam, icon: "users", account: true });
  if (role === "owner" || role === "manager") {
    items.push({ href: "/admin/settings", label: t.panel.navSettings, icon: "sliders", account: true });
  }

  const roleLabels = { owner: t.team.roleOwner, manager: t.team.roleManager, collaborator: t.team.roleCollaborator };

  // Only people who can act on an update see the notice; null (the common case
  // while the repository is private, or when the check is off) shows nothing.
  const latest = role === "owner" || role === "manager" ? await getLatestRelease() : null;
  const update = latest && isNewer(latest.version, APP_VERSION) ? latest : null;

  return (
    <ShellNav
      agency={{ name: agency.name, logoUrl: logoPath(agency.logoFileId) }}
      user={{ name: session.user.name, roleLabel: roleLabels[role] }}
      items={items}
      signOutAction={signOut}
      labels={{ navigation: t.ui.sections, more: t.ui.more, close: t.ui.close, signOut: t.common.signOut }}
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
