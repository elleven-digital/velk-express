import { notFound } from "next/navigation";
import { PageCrumb } from "@/components/crumbs";
import { TabNav } from "@/components/shell-nav";
import { Badge, MetaLine } from "@/components/ui";
import { isStaff } from "@/lib/access";
import { requireTeam } from "@/lib/auth/guards";
import { getClientCached } from "@/lib/core/clients";
import { formatMinutes } from "@/lib/format";
import { getUserDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

/**
 * The frame of one client: its name, whether it has support, and the tabs.
 * A client the member may not see is a 404 here, so no tab leaks it. Later
 * stages add their tabs to `items`.
 */
export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await requireTeam();
  const found = await getClientCached(me, id);
  if (!found.ok) notFound();
  const client = found.value;
  const { t } = await getUserDict();
  const base = `/admin/clients/${client.id}`;

  return (
    <div>
      {/* the top bar reads "Clients / {name}" on every tab */}
      <PageCrumb label={client.name} />
      <header className="mb-4">
        <h1 className="text-[1.5rem] font-semibold leading-[1.2] tracking-[-0.025em] text-ink [overflow-wrap:anywhere] sm:text-[1.75rem]">
          {client.name}
        </h1>
        <MetaLine className="mt-2.5">
          <Badge tone={client.supportActive ? "ok" : "muted"}>
            {client.supportActive ? t.clients.supportActive : t.clients.supportInactive}
          </Badge>
          {client.supportActive && client.hoursLimited ? (
            <span>
              {formatMinutes(client.includedMinutes)}
              {t.clients.perMonth}
            </span>
          ) : null}
          {client.supportActive && client.hoursTracked && !client.hoursLimited ? <span>{t.clients.hoursTrackedShort}</span> : null}
          {client.email ? (
            <a href={`mailto:${client.email}`} className="underline-offset-[3px] [overflow-wrap:anywhere] hover:text-ink hover:underline">
              {client.email}
            </a>
          ) : null}
        </MetaLine>
      </header>
      {/* -mb-px: the active tab's line sits on the hairline */}
      <div className="mb-8 border-b border-line max-sm:mb-6">
        <TabNav
          label={client.name}
          className="-mb-px"
          items={[
            { href: base, label: t.clients.overview, exact: true },
            { href: `${base}/sites`, label: t.clients.tabSites },
            // Hours and portal access are managed by owners and managers only.
            ...(isStaff(me.user)
              ? [
                  { href: `${base}/hours`, label: t.clients.tabHours },
                  { href: `${base}/access`, label: t.clients.tabAccess },
                ]
              : []),
          ]}
        />
      </div>
      {children}
    </div>
  );
}
