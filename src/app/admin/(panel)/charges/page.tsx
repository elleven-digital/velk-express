import Link from "next/link";
import { ChargeDocControl, ChargeRowActions } from "@/components/charge-panel";
import { chargeActionsFor, chargeAmount, chargeLabelsOf } from "@/components/charge-section";
import { FilterSelect } from "@/components/filter-select";
import { Flash } from "@/components/flash";
import { Icon } from "@/components/icons";
import { Badge, Card, EmptyState, LinkButton, PageHeader, TableShell, tdClasses, thClasses } from "@/components/ui";
import { requireTeam } from "@/lib/auth/guards";
import { chargeSourceHref, chargeSourceKey, chargeStatusMeta, isLiveStatus } from "@/lib/charge-utils";
import { listClients } from "@/lib/core/clients";
import { listCharges, type ChargeView } from "@/lib/core/charges";
import { formatMoment } from "@/lib/format";
import { CYCLE_TIME_ZONE } from "@/lib/hours";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

const STATUSES = ["pending", "active", "past_due", "paid", "canceled"] as const;

/** Every charge of the agency, newest first, filtered by client and status. Owners and managers; a manager never sees a quote's. */
export default async function ChargesPage({ searchParams }: { searchParams: Promise<{ client?: string; status?: string; ok?: string }> }) {
  const sp = await searchParams;
  const me = await requireTeam(["owner", "manager"]);
  const { t, locale } = await getUserDict();
  const owner = me.user.role === "owner";
  const clientList = await listClients(me);
  const clientId = clientList.some((c) => c.id === sp.client) ? sp.client : undefined;
  const status = STATUSES.find((s) => s === sp.status);
  const listed = await listCharges(me, { clientId, status });
  const rows = listed.ok ? listed.value : [];
  const labels = chargeLabelsOf(t);

  const href = (next: { client?: string; status?: string }) => {
    const q = new URLSearchParams();
    const c = next.client ?? "";
    const s = next.status ?? "";
    if (c) q.set("client", c);
    if (s) q.set("status", s);
    const text = q.toString();
    return `/admin/charges${text ? `?${text}` : ""}`;
  };

  const cells = (c: ChargeView) => {
    const meta = chargeStatusMeta(c.status);
    const live = isLiveStatus(c.status);
    const actions = chargeActionsFor(c);
    const sourceHref = chargeSourceHref(c, owner);
    const sourceText = t.charges[chargeSourceKey(c.source)];
    return {
      charge: (
        <div className="min-w-0">
          <div className="font-medium text-ink [overflow-wrap:anywhere]">{c.label}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] text-muted">
            {sourceHref ? (
              <Link href={sourceHref} className="underline underline-offset-2 hover:text-ink">
                {sourceText}
              </Link>
            ) : (
              <span>{sourceText}</span>
            )}
            <span className="tabular">{formatMoment(new Date(c.createdAt), locale, new Date(), CYCLE_TIME_ZONE)}</span>
            {c.paidAt ? (
              <span>{fmt(t.charges.paidOn, { date: formatMoment(new Date(c.paidAt), locale, new Date(), CYCLE_TIME_ZONE) })}</span>
            ) : null}
          </div>
        </div>
      ),
      client: c.clientId ? (
        <Link href={`/admin/clients/${c.clientId}`} className="text-ink underline-offset-2 hover:underline">
          {c.clientName}
        </Link>
      ) : (
        "—"
      ),
      total: <span className="tabular font-medium text-ink">{chargeAmount(t, locale, c)}</span>,
      status: <Badge tone={meta.tone}>{t.charges[meta.key]}</Badge>,
      document: (
        <ChargeDocControl
          chargeId={c.id}
          doc={c.document}
          attach={actions.attach}
          removeDocument={actions.removeDocument}
          labels={labels}
          compact
        />
      ),
      actions: (
        <ChargeRowActions
          payUrl={live ? c.payUrl : null}
          canMarkPaid={c.canAct && c.kind === "one_time" && c.status === "pending"}
          actions={actions}
          labels={labels}
        />
      ),
    };
  };

  return (
    <>
      <PageHeader
        title={t.charges.title}
        actions={
          <LinkButton href={clientId ? `/admin/charges/new?client=${clientId}` : "/admin/charges/new"}>
            <Icon name="plus" />
            {t.charges.newCharge}
          </LinkButton>
        }
      />
      <Flash ok={sp.ok ? t.charges.created : undefined} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSelect
          ariaLabel={t.charges.filterClient}
          value={clientId ?? ""}
          options={[
            { value: "", label: t.charges.allClients, href: href({ status }) },
            ...clientList.map((c) => ({ value: c.id, label: c.name, href: href({ client: c.id, status }) })),
          ]}
        />
        <FilterSelect
          ariaLabel={t.charges.filterStatus}
          value={status ?? ""}
          options={[
            { value: "", label: t.charges.allStatuses, href: href({ client: clientId }) },
            ...STATUSES.map((s) => ({ value: s, label: t.charges[chargeStatusMeta(s).key], href: href({ client: clientId, status: s }) })),
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon="receipt" title={clientId || status ? t.charges.emptyFiltered : t.charges.empty} />
        </Card>
      ) : (
        <>
          {/* phones get a list: a table would scroll sideways */}
          <Card className="divide-y divide-line sm:hidden">
            {rows.map((c) => {
              const x = cells(c);
              return (
                <div key={c.id} className="space-y-2.5 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    {x.charge}
                    <div className="flex-none text-right">
                      {x.total}
                      <div className="mt-0.5">{x.status}</div>
                    </div>
                  </div>
                  <div className="text-[0.8125rem] text-muted">{x.client}</div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {x.document}
                    {x.actions}
                  </div>
                </div>
              );
            })}
          </Card>
          <div className="max-sm:hidden">
            <TableShell>
              <thead className="border-b border-line">
                <tr>
                  <th className={thClasses}>{t.charges.colCharge}</th>
                  <th className={thClasses}>{t.charges.colClient}</th>
                  <th className={`${thClasses} text-right`}>{t.charges.colTotal}</th>
                  <th className={thClasses}>{t.charges.colStatus}</th>
                  <th className={thClasses}>{t.charges.colDocument}</th>
                  <th className={`${thClasses} text-right`}>{t.charges.colActions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((c) => {
                  const x = cells(c);
                  return (
                    <tr key={c.id}>
                      <td className={`${tdClasses} max-w-xs`}>{x.charge}</td>
                      <td className={tdClasses}>{x.client}</td>
                      <td className={`${tdClasses} text-right`}>{x.total}</td>
                      <td className={tdClasses}>{x.status}</td>
                      <td className={tdClasses}>{x.document}</td>
                      <td className={tdClasses}>{x.actions}</td>
                    </tr>
                  );
                })}
              </tbody>
            </TableShell>
          </div>
        </>
      )}
    </>
  );
}
