import type { NavItem } from "@/components/shell-nav";
import type { UserRole } from "@/lib/db";
import type { Dict } from "@/lib/i18n";

/**
 * The panel menu for a role. Quotes and Team are the owner's; Charges is for
 * owners and managers; Settings opens for everyone (a collaborator sees only
 * the AI connections there, a manager also the labels).
 */
export function teamNavItems(role: UserRole, t: Dict["panel"]): NavItem[] {
  const items: NavItem[] = [
    { href: "/admin", label: t.navHome, icon: "home", exact: true },
    { href: "/admin/tickets", label: t.navTickets, icon: "inbox" },
    { href: "/admin/projects", label: t.navProjects, icon: "layers" },
    { href: "/admin/clients", label: t.navClients, icon: "brief" },
  ];
  if (role === "owner") items.push({ href: "/admin/quotes", label: t.navQuotes, icon: "file" });
  if (role === "owner" || role === "manager") items.push({ href: "/admin/charges", label: t.navCharges, icon: "receipt" });
  if (role === "owner") items.push({ href: "/admin/team", label: t.navTeam, icon: "users", account: true });
  items.push({ href: "/admin/settings", label: t.navSettings, icon: "sliders", account: true });
  return items;
}
