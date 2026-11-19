import Link from "next/link";
import { Icon } from "@/components/icons";
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  TableShell,
  cn,
  tdClasses,
  thClasses,
} from "@/components/ui";
import { isStaff } from "@/lib/access";
import { requireTeam } from "@/lib/auth/guards";
import { listClients } from "@/lib/core/clients";
import { formatMinutes } from "@/lib/format";
import { getUserDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const me = await requireTeam();
  const { t } = await getUserDict();
  const staff = isStaff(me.user);
  const rows = await listClients(me);

  return (
    <>
      <PageHeader
        title={t.clients.title}
        actions={
          staff ? (
            <LinkButton href="/admin/clients/new">
              <Icon name="plus" />
              {t.clients.new}
            </LinkButton>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="brief"
            title={t.clients.empty}
            text={staff ? undefined : t.clients.emptyHint}
            action={
              staff ? (
                <LinkButton href="/admin/clients/new" variant="secondary" size="sm">
                  <Icon name="plus" />
                  {t.clients.emptyCta}
                </LinkButton>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* phones get a list: a table would scroll sideways */}
          <Card className="divide-y divide-line sm:hidden">
            {rows.map((client) => (
              <Link
                key={client.id}
                href={`/admin/clients/${client.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-paper"
              >
                <Avatar name={client.name} kind="client" size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink">{client.name}</div>
                  <div className="truncate text-[0.8125rem] text-muted">
                    {t.clients.colSites}: {client.siteCount}
                    {client.supportActive && client.hoursMode === "package" ? (
                      <>
                        {" · "}
                        {formatMinutes(client.includedMinutes)}
                        {t.clients.perMonth}
                      </>
                    ) : null}
                    {client.supportActive && client.hoursMode === "internal" ? <> · {t.clients.hoursInternalShort}</> : null}
                  </div>
                </div>
                <Badge tone={client.supportActive ? "ok" : "muted"}>
                  {client.supportActive ? t.clients.supportActive : t.clients.supportInactive}
                </Badge>
              </Link>
            ))}
          </Card>
          <div className="max-sm:hidden">
            <TableShell>
              <thead className="border-b border-line">
                <tr>
                  <th className={thClasses}>{t.clients.colClient}</th>
                  <th className={thClasses}>{t.clients.colSites}</th>
                  <th className={thClasses}>{t.clients.colSupport}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((client) => (
                  // the name's link covers the row, so the whole line opens the client
                  <tr key={client.id} className="relative transition-colors hover:bg-paper">
                    <td className={tdClasses}>
                      <div className="flex items-center gap-3">
                        <Avatar name={client.name} kind="client" size={32} />
                        <div className="min-w-0">
                          <Link
                            href={`/admin/clients/${client.id}`}
                            className="font-medium text-ink underline-offset-[3px] after:absolute after:inset-0 after:content-[''] hover:underline"
                          >
                            {client.name}
                          </Link>
                          {client.email ? (
                            <div className="truncate text-[0.8125rem] text-muted">{client.email}</div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className={cn(tdClasses, "tabular text-ink")}>{client.siteCount}</td>
                    <td className={cn(tdClasses, "whitespace-nowrap")}>
                      <Badge tone={client.supportActive ? "ok" : "muted"}>
                        {client.supportActive ? t.clients.supportActive : t.clients.supportInactive}
                      </Badge>
                      {client.supportActive && client.hoursMode === "package" ? (
                        <span className="ml-2 text-[0.8125rem] text-muted">
                          {formatMinutes(client.includedMinutes)}
                          {t.clients.perMonth}
                        </span>
                      ) : null}
                      {client.supportActive && client.hoursMode === "internal" ? (
                        <span className="ml-2 text-[0.8125rem] text-muted">{t.clients.hoursInternalShort}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
        </>
      )}
    </>
  );
}
