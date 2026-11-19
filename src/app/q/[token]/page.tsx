import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AgencyAvatar } from "@/components/agency-avatar";
import { Flash } from "@/components/flash";
import { LocaleSelect } from "@/components/locale-select";
import { LocalTime } from "@/components/local-time";
import { SubmitButton } from "@/components/submit-button";
import { Icon } from "@/components/icons";
import { Badge, Callout, Card, Kicker, buttonClasses, cn } from "@/components/ui";
import { getAgency, logoPath } from "@/lib/agency";
import { getPublicQuote } from "@/lib/core/quote-public";
import type { Currency } from "@/lib/core/settings";
import { formatMoney } from "@/lib/format";
import { fmt, isLocale } from "@/lib/i18n";
import { getPublicDict } from "@/lib/i18n/server";
import { approveQuoteAction, setQuoteLocaleAction } from "./actions";

export const dynamic = "force-dynamic";

// The link is the only protection: keep it out of search engines. The tab shows the agency's name.
export async function generateMetadata(): Promise<Metadata> {
  const agency = await getAgency();
  return { title: agency?.name ?? "Velk Express", robots: { index: false, follow: false } };
}

const ERRORS = ["nothingSelected", "tooManyAttempts"] as const;

export default async function PublicQuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const quote = await getPublicQuote(token);
  if (!quote) notFound();
  const agency = await getAgency();
  // The visitor's cookie or browser language wins; without either, the agency's own language.
  const { t, locale } = await getPublicDict(isLocale(agency?.locale) ? agency.locale : undefined);

  const decided = quote.status !== "sent";
  const currency = quote.currency as Currency;
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const kindLabel = {
    site_creation: t.quotes.kindSiteCreation,
    maintenance: t.quotes.kindMaintenance,
    support: t.quotes.kindSupport,
  };
  const err = ERRORS.find((e) => e === sp.err);
  const errText = err ? t.quotes.errors[err] : undefined;
  const { oneTimeCents, monthlyCents } = quote.totals;
  const [paidBefore, paidAfter = ""] = t.charges.paidOn.split("{date}");
  const [before, after] = fmt(t.quotes.public.confirmed, { agency: quote.agencyName, date: "{date}" }).split("{date}");

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-line">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-2.5 min-w-0">
            <AgencyAvatar name={quote.agencyName} logoUrl={logoPath(agency?.logoFileId ?? null)} size={24} />
            <span className="font-medium text-ink truncate">{quote.agencyName}</span>
          </span>
          <form action={setQuoteLocaleAction} className="flex items-center">
            <input type="hidden" name="token" value={token} />
            <LocaleSelect value={locale} label={t.quotes.public.language} applyLabel={t.common.save} />
          </form>
        </div>
      </header>

      <main className="flex-1 px-4 pt-10 lg:pt-16 pb-16">
        <div className="mx-auto w-full max-w-2xl">
          <Kicker>{t.quotes.title}</Kicker>
          <h1 className="mt-1 text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.025em] text-ink break-words">
            {quote.title}
          </h1>
          <p className="text-muted text-[0.875rem] mt-2 mb-8">
            {fmt(t.quotes.public.greeting, { name: quote.forName })} {fmt(t.quotes.public.from, { agency: quote.agencyName })}
          </p>

          <Flash error={errText} />

          {quote.notes ? (
            <Card className="px-4 py-3 mb-6 text-[0.875rem] text-body whitespace-pre-line break-words">{quote.notes}</Card>
          ) : null}

          {decided ? (
            <div role="status" className="mb-6">
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
            <div role="status" className="mb-6">
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

          <form action={approveQuoteAction}>
            <input type="hidden" name="token" value={token} />
            <Card className="divide-y divide-line">
              {quote.items.map((item, i) => {
                const row = (
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
                    </span>
                  </>
                );
                return decided ? (
                  <div key={item.id} className={cn("flex items-start gap-3 px-4 py-3", !item.clientApproved && "opacity-60")}>
                    {row}
                  </div>
                ) : (
                  <label key={item.id} className="flex items-start gap-3 px-4 py-3 cursor-pointer">
                    <input type="checkbox" name="itemId" value={item.id} defaultChecked className="mt-1 size-4 accent-ink flex-none" />
                    {row}
                  </label>
                );
              })}
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

            {decided ? null : (
              <div className="mt-6">
                <p className="text-[0.8125rem] text-muted mb-3">{t.quotes.public.selectHint}</p>
                <SubmitButton size="lg" className="max-sm:w-full">
                  {t.quotes.public.confirm}
                </SubmitButton>
              </div>
            )}
          </form>
        </div>
      </main>
    </div>
  );
}
