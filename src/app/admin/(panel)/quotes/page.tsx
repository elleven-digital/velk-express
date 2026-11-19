import Link from "next/link";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { Avatar, Badge, Card, EmptyState, LinkButton, PageHeader, TableShell, cn, tdClasses, thClasses } from "@/components/ui";
import { listQuotes } from "@/lib/core/quotes";
import type { Currency } from "@/lib/core/settings";
import { formatMoney } from "@/lib/format";
import { getUserDict } from "@/lib/i18n/server";
import { quoteStatusMeta } from "@/lib/quote-utils";
import { requireQuoteOwner } from "./guard";

export const dynamic = "force-dynamic";

export default async function QuotesPage() {
  const me = await requireQuoteOwner();
  const { t, locale } = await getUserDict();
  const listed = await listQuotes(me);
  const rows = listed.ok ? listed.value : [];
  const money = (cents: number, currency: string) => formatMoney(cents, currency as Currency, locale);
  const who = (row: (typeof rows)[number]) => row.clientName ?? row.prospectName ?? "";

  return (
    <>
      <PageHeader
        title={t.quotes.title}
        actions={
          <LinkButton href="/admin/quotes/new">
            <Icon name="plus" />
            {t.quotes.new}
          </LinkButton>
        }
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="file"
            title={t.quotes.empty}
            action={
              <LinkButton href="/admin/quotes/new" variant="secondary" size="sm">
                <Icon name="plus" />
                {t.quotes.new}
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <>
          {/* phones get a list: a table would scroll sideways */}
          <Card className="divide-y divide-line sm:hidden">
            {rows.map((row) => {
              const meta = quoteStatusMeta(row.status);
              return (
                <Link key={row.id} href={`/admin/quotes/${row.id}`} className="block px-4 py-3 transition-colors hover:bg-paper">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{row.title}</div>
                      <div className="truncate text-[0.8125rem] text-muted">
                        {who(row)}
                        {row.clientId ? "" : ` · ${t.quotes.prospect}`}
                      </div>
                    </div>
                    <Badge tone={meta.tone}>{t.quotes.status[meta.key]}</Badge>
                  </div>
                  <div className="tabular mt-1.5 flex flex-wrap gap-x-4 text-[0.8125rem] text-muted">
                    {row.oneTimeCents > 0 ? <span>{money(row.oneTimeCents, row.currency)}</span> : null}
                    {row.monthlyCents > 0 ? (
                      <span>
                        {money(row.monthlyCents, row.currency)}
                        {t.quotes.perMonth}
                      </span>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </Card>
          <div className="max-sm:hidden">
            <TableShell>
              <thead className="border-b border-line">
                <tr>
                  <th className={thClasses}>{t.quotes.colTitle}</th>
                  <th className={thClasses}>{t.quotes.colClient}</th>
                  <th className={thClasses}>{t.quotes.colStatus}</th>
                  <th className={thClasses}>{t.quotes.colOneTime}</th>
                  <th className={thClasses}>{t.quotes.colMonthly}</th>
                  <th className={thClasses}>{t.quotes.colDate}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => {
                  const meta = quoteStatusMeta(row.status);
                  return (
                    // the title's link covers the row, so the whole line opens the quote
                    <tr key={row.id} className="relative transition-colors hover:bg-paper">
                      <td className={tdClasses}>
                        <Link
                          href={`/admin/quotes/${row.id}`}
                          className="font-medium text-ink underline-offset-[3px] after:absolute after:inset-0 after:content-[''] hover:underline"
                        >
                          {row.title}
                        </Link>
                      </td>
                      <td className={tdClasses}>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={who(row)} kind="client" size={24} />
                          <span className="truncate text-ink">{who(row)}</span>
                          {row.clientId ? null : <span className="text-muted">· {t.quotes.prospect}</span>}
                        </div>
                      </td>
                      <td className={cn(tdClasses, "whitespace-nowrap")}>
                        <Badge tone={meta.tone}>{t.quotes.status[meta.key]}</Badge>
                      </td>
                      <td className={cn(tdClasses, "tabular whitespace-nowrap text-ink")}>
                        {row.oneTimeCents > 0 ? money(row.oneTimeCents, row.currency) : "—"}
                      </td>
                      <td className={cn(tdClasses, "tabular whitespace-nowrap text-ink")}>
                        {row.monthlyCents > 0 ? (
                          <>
                            {money(row.monthlyCents, row.currency)}
                            <span className="text-muted">{t.quotes.perMonth}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={cn(tdClasses, "whitespace-nowrap text-muted")}>
                        <LocalTime iso={row.createdAt.toISOString()} locale={locale} />
                      </td>
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
