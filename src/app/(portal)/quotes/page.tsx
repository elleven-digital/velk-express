import { redirect } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { ProposalRow, WorkList } from "@/components/work-list";
import { requirePortalAdmin } from "@/lib/auth/guards";
import { listPortalQuotes } from "@/lib/core/portal-quotes";
import type { Currency } from "@/lib/core/settings";
import { getAgency } from "@/lib/agency";
import { formatMoney } from "@/lib/format";
import { getPortalDict } from "@/lib/i18n/server";
import { quoteStatusMeta } from "@/lib/quote-utils";

export const dynamic = "force-dynamic";

/** The company's proposals (sent, approved, executed), for its admins; anyone else goes home. */
export default async function PortalQuotesPage() {
  const session = await requirePortalAdmin();
  const [res, { t, locale }, agency] = await Promise.all([listPortalQuotes(session), getPortalDict(), getAgency()]);
  // The core re-reads the role: a demotion since the session was resolved means back home.
  if (!res.ok) redirect("/");
  const p = t.portal;
  const fallbackCurrency = (agency?.currency ?? "BRL") as Currency;

  return (
    <div>
      <PageHeader title={p.quotesTitle} />
      {res.value.length === 0 ? (
        <Card>
          <EmptyState icon="file" title={p.quotesEmpty} />
        </Card>
      ) : (
        <WorkList>
          {res.value.map((q) => {
            const currency = (q.currency || fallbackCurrency) as Currency;
            const meta = quoteStatusMeta(q.status);
            const amounts = [
              q.oneTimeCents > 0 ? formatMoney(q.oneTimeCents, currency, locale) : null,
              q.monthlyCents > 0 ? `${formatMoney(q.monthlyCents, currency, locale)}${t.quotes.perMonth}` : null,
            ].filter(Boolean);
            return (
              <ProposalRow
                key={q.id}
                href={`/q/${q.token}`}
                title={q.title}
                status={{ tone: q.status === "sent" ? "warn" : meta.tone, label: t.quotes.status[meta.key] }}
                meta={[
                  <LocalTime key="d" iso={q.createdAt.toISOString()} locale={locale} />,
                  amounts.length > 0 ? amounts.join(" + ") : "—",
                ]}
                action={q.status === "sent" ? p.reviewApprove : p.viewProposal}
                primary={q.status === "sent"}
              />
            );
          })}
        </WorkList>
      )}
    </div>
  );
}
