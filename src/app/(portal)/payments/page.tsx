import { redirect } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { Badge, buttonClasses, Card, EmptyState, MetaLine, PageHeader } from "@/components/ui";
import { WorkList } from "@/components/work-list";
import { getAgency } from "@/lib/agency";
import { requirePortalAdmin } from "@/lib/auth/guards";
import { listPortalPayments } from "@/lib/core/portal-payments";
import type { Currency } from "@/lib/core/settings";
import { chargeStatusMeta } from "@/lib/charge-utils";
import { formatMoney } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

/**
 * The company's charges, for its admins; anyone else goes home. A pending one with a provider has a
 * "Pay" button to its `/pay/[token]` link; a subscription that is active or past due offers none (the
 * link refuses it: the agency sorts it out). The fiscal document opens from `/api/files`, which only
 * serves this company's admins and the team.
 */
export default async function PortalPaymentsPage() {
  const session = await requirePortalAdmin();
  const [res, { t, locale }, agency] = await Promise.all([listPortalPayments(session), getPortalDict(), getAgency()]);
  // The core re-reads the role: a demotion since the session was resolved means back home.
  if (!res.ok) redirect("/");
  const p = t.portal;
  const fallbackCurrency = (agency?.currency ?? "BRL") as Currency;
  // "Paid on {date}": the moment is a client component, so the sentence is cut around it
  const [paidBefore, paidAfter = ""] = t.charges.paidOn.split("{date}");

  return (
    <div>
      <PageHeader title={p.navPayments} />
      {res.value.length === 0 ? (
        <Card>
          <EmptyState icon="receipt" title={fmt(t.charges.portalEmpty, { agency: agency?.name ?? "Velk Express" })} />
        </Card>
      ) : (
        <WorkList>
          {res.value.map((c) => {
            const status = chargeStatusMeta(c.status);
            const money = formatMoney(c.amountCents, (c.currency || fallbackCurrency) as Currency, locale);
            return (
              <div key={c.id} className="flex flex-wrap sm:flex-nowrap items-center gap-x-5 gap-y-2 min-h-16 px-3.5 sm:px-4 py-3">
                <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge tone={status.tone}>{t.charges[status.key]}</Badge>
                    <span className="truncate font-medium text-ink">{c.label}</span>
                  </div>
                  <MetaLine className="mt-0.5">
                    <LocalTime iso={c.createdAt.toISOString()} locale={locale} />
                    {c.paidAt ? (
                      <span>
                        {paidBefore}
                        <LocalTime iso={c.paidAt.toISOString()} locale={locale} />
                        {paidAfter}
                      </span>
                    ) : null}
                  </MetaLine>
                </div>
                <div className="flex-none font-medium text-ink tabular">
                  {money}
                  {c.kind === "subscription" ? <span className="text-muted font-normal">{t.charges.perMonth}</span> : null}
                </div>
                {c.payPath || c.documentId ? (
                  <div className="flex flex-none items-center gap-2">
                    {c.documentId ? (
                      <a
                        href={`/api/files/${c.documentId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonClasses("secondary", "sm")}
                      >
                        {t.charges.docOpen}
                      </a>
                    ) : null}
                    {c.payPath ? (
                      <a href={c.payPath} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "sm")}>
                        {p.pay}
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </WorkList>
      )}
    </div>
  );
}
