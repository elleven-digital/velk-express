import type { ReactNode } from "react";
import { Flash } from "@/components/flash";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { QuoteApprovalForm } from "@/components/quote-approval";
import { Badge, Callout, Card, buttonClasses, cn } from "@/components/ui";
import type { PublicQuote } from "@/lib/core/quote-public";
import type { Currency } from "@/lib/core/settings";
import { formatMoney } from "@/lib/format";
import { fmt, type Dict, type Locale } from "@/lib/i18n";

const ERRORS = ["nothingSelected", "tooManyAttempts", "quoteChanged"] as const;

/**
 * A proposal's content, the same on its public page and inside the client portal: the notes, the
 * decision or the charge when there is one, the items, and either the approval form (sent) or the
 * decided summary. Each page puts its own frame and heading around it.
 */
export function QuoteDocument({
  quote,
  token,
  err,
  t,
  locale,
  approveAction,
}: {
  quote: PublicQuote;
  token: string;
  /** The `err` query parameter the approval may come back with. */
  err?: string;
  t: Dict;
  locale: Locale;
  approveAction: (formData: FormData) => void | Promise<void>;
}): ReactNode {
  const decided = quote.status !== "sent";
  const currency = quote.currency as Currency;
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const kindLabel = {
    site_creation: t.quotes.kindSiteCreation,
    maintenance: t.quotes.kindMaintenance,
    support: t.quotes.kindSupport,
  };
  const known = ERRORS.find((e) => e === err);
  const errText = known ? t.quotes.errors[known] : undefined;
  const { oneTimeCents, monthlyCents } = quote.totals;
  const [paidBefore, paidAfter = ""] = t.charges.paidOn.split("{date}");
  const [before, after] = fmt(t.quotes.public.confirmed, { agency: quote.agencyName, date: "{date}" }).split("{date}");

  // One item's line: its number, title, kind, description and price (approval marks once decided).
  const rowOf = (item: (typeof quote.items)[number], i: number) => (
    <>
      <span className="text-[0.8125rem] text-muted tabular-nums w-6 flex-none pt-0.5">
        {String(i + 1).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink break-words">{item.title}</span>
        <span className="block text-[0.8125rem] text-muted">{kindLabel[item.kind]}</span>
        {item.description ? (
          <span className="block text-[0.875rem] text-body mt-1 whitespace-pre-line break-words">
            {item.description}
          </span>
        ) : null}
      </span>
      <span className="flex-none text-right">
        <span className="block font-medium text-ink tabular-nums">
          {item.amountCents > 0 ? money(item.amountCents) : "—"}
        </span>
        <span className="block text-[0.8125rem] text-muted">
          {item.monthly ? t.quotes.monthly : t.quotes.oneTime}
        </span>
        {decided && item.clientApproved ? (
          <Badge tone="ok" className="mt-1">
            {t.quotes.public.approved}
          </Badge>
        ) : null}
        {item.includedByAgency ? (
          <Badge tone="info" className="mt-1">
            {t.quotes.public.includedByAgency}
          </Badge>
        ) : null}
      </span>
    </>
  );

  return (
    <>
    <Flash error={errText} />

    {quote.notes ? (
      <Card className="px-4 py-3 mb-6 text-[0.875rem] text-body whitespace-pre-line break-words">{quote.notes}</Card>
    ) : null}

    {decided ? (
      <div className="mb-6">
        <Callout
          tone="ok"
          title={
            quote.acceptedAt ? (
              <>
                {before}
                <LocalTime iso={quote.acceptedAt.toISOString()} locale={locale} />
                {after}
              </>
            ) : (
              t.quotes.public.alreadyDecided
            )
          }
        />
      </div>
    ) : null}

    {quote.charge?.status === "paid" ? (
      <div className="mb-6">
        <Callout tone="ok" title={t.charges.paymentConfirmed}>
          {quote.charge.paidAt ? (
            <>
              {paidBefore}
              <LocalTime iso={quote.charge.paidAt.toISOString()} locale={locale} />
              {paidAfter}
            </>
          ) : null}
        </Callout>
      </div>
    ) : null}

    {quote.charge?.status === "pending" && quote.charge.payPath ? (
      <Card className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <Icon name="receipt" className="flex-none text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink">{quote.charge.label}</div>
          <div className="text-[0.875rem] text-muted tabular-nums">
            {formatMoney(quote.charge.amountCents, quote.charge.currency as Currency, locale)}
          </div>
        </div>
        <a href={quote.charge.payPath} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "md")}>
          {t.charges.payNow}
        </a>
      </Card>
    ) : null}

    {decided ? (
      <>
        <Card className="divide-y divide-line">
          {quote.items.map((item, i) => (
            <div key={item.id} className={cn("flex items-start gap-3 px-4 py-3", !item.clientApproved && !item.includedByAgency && "opacity-60")}>
              {rowOf(item, i)}
            </div>
          ))}
        </Card>

        <Card className="mt-6 px-4 py-3">
          <div className="text-[0.8125rem] font-medium text-muted mb-2">{t.quotes.public.summary}</div>
          <dl className="space-y-1 text-[0.875rem]">
            {oneTimeCents > 0 || monthlyCents === 0 ? (
              <div className="flex justify-between gap-4">
                <dt className="text-muted">{t.quotes.public.oneTimeTotal}</dt>
                <dd className="font-medium text-ink tabular-nums">{money(oneTimeCents)}</dd>
              </div>
            ) : null}
            {monthlyCents > 0 ? (
              <div className="flex justify-between gap-4">
                <dt className="text-muted">{t.quotes.public.monthlyTotal}</dt>
                <dd className="font-medium text-ink tabular-nums">
                  {money(monthlyCents)}
                  <span className="text-muted font-normal">{t.quotes.perMonth}</span>
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>
      </>
    ) : (
      <QuoteApprovalForm
        action={approveAction}
        token={token}
        version={quote.version}
        items={quote.items.map((item, i) => ({ id: item.id, amountCents: item.amountCents, monthly: item.monthly, row: rowOf(item, i) }))}
        currency={currency}
        locale={locale}
        labels={{
          summary: t.quotes.public.summary,
          oneTimeTotal: t.quotes.public.oneTimeTotal,
          monthlyTotal: t.quotes.public.monthlyTotal,
          perMonth: t.quotes.perMonth,
          selectHint: t.quotes.public.selectHint,
          confirm: t.quotes.public.confirm,
        }}
      />
    )}
    </>
  );
}
