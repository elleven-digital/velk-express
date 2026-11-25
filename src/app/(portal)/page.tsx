import { Badge, Callout, Card, EmptyState, LinkButton, buttonClasses, MoreLink, PageHeader, ProgressBar, SectionHead, SectionTitle } from "@/components/ui";
import { Flash } from "@/components/flash";
import { LocalTime } from "@/components/local-time";
import { SubmitButton } from "@/components/submit-button";
import { AllClearRow, PaymentTaskRow, PortalTicketRow, ProposalRow, WorkList } from "@/components/work-list";
import { Icon } from "@/components/icons";
import { getAgency } from "@/lib/agency";
import { requirePortal } from "@/lib/auth/guards";
import { getPortalHome } from "@/lib/core/portal-home";
import type { Currency } from "@/lib/core/settings";
import { formatCycle, formatMinutes, formatMoney, formatNextCycleStart } from "@/lib/format";
import { fmt, lookup, type Locale } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import type { PortalTicketRow as TicketRow } from "@/lib/core/portal-tickets";
import { turnBadge } from "@/lib/turn";
import { buyHoursAction } from "./actions";

export const dynamic = "force-dynamic";

/** Only web addresses become links; the core already stores them that way. */
const isWebAddress = (url: string) => /^https?:\/\//i.test(url);

/**
 * The portal home: what waits on the person, the latest tickets, the company's plan and its sites.
 * Money (payment tasks, the monthly setup, the past-due notice, buying hours) is for the company's admin.
 */
export default async function PortalHomePage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const [session, sp] = await Promise.all([requirePortal(), searchParams]);
  const [home, { t, locale }, agency] = await Promise.all([getPortalHome(session), getPortalDict(), getAgency()]);
  const agencyName = agency?.name ?? "Velk Express";
  const currency = (agency?.currency ?? "BRL") as Currency;
  const firstName = session.user.name.split(" ")[0];
  const p = t.portal;
  const paymentErrors = p.errors as Record<string, string>;
  const errKey = sp.err === "providerUnavailable" || sp.err === "nothingToCharge" || sp.err === "notFound" ? "unavailable" : sp.err;
  const flash = sp.err ? fmt(lookup(paymentErrors, errKey) ?? p.errors.generic, { agency: agencyName }) : undefined;
  const payments = home.payments;
  const taskCount = home.proposals.length + (payments?.tasks.length ?? 0) + home.awaiting.length;
  // "Sent {when}.": the moment is a client component, so the sentence is cut around it
  const [sentBefore, sentAfter = ""] = p.proposalSent.split("{when}");
  const ticketRow = (r: TicketRow) => (
    <PortalTicketRow
      key={r.id}
      href={`/tickets/${r.id}`}
      title={r.title}
      number={r.number}
      site={r.siteName ?? t.tickets.generalLabel}
      when={<LocalTime iso={r.lastActivity.toISOString()} locale={locale} />}
      status={turnBadge(r.turn, "client", t)}
    />
  );

  return (
    <div>
      <PageHeader title={fmt(p.hello, { name: firstName })} sub={`${session.client.name} · ${fmt(p.helloSub, { agency: agencyName })}`} crumb={null}
        actions={
          home.supportActive ? (
            <LinkButton href="/tickets/new">
              <Icon name="plus" />
              {p.newTicket}
            </LinkButton>
          ) : undefined
        }
      />

      <Flash error={flash} />

      {home.hours?.limited && home.hours.balanceMinutes < 0 ? (
        <Callout tone="danger" className="mb-8">
          {fmt(t.hours.negativeWarningPortal, { agency: agencyName })}
        </Callout>
      ) : null}

      {taskCount > 0 || payments ? (
        <section aria-labelledby="p-awaiting" className="mb-10">
          <SectionHead id="p-awaiting" title={p.awaitingTitle} count={taskCount} />
          <WorkList>
            {home.proposals.map((q) => {
              const quoteCurrency = (q.currency || currency) as Currency;
              const amounts = [
                q.oneTimeCents > 0 ? formatMoney(q.oneTimeCents, quoteCurrency, locale) : null,
                q.monthlyCents > 0 ? `${formatMoney(q.monthlyCents, quoteCurrency, locale)}${t.quotes.perMonth}` : null,
              ].filter(Boolean);
              return (
                <ProposalRow
                  key={q.id}
                  href={`/q/${q.token}`}
                  title={fmt(p.proposalTask, { title: q.title })}
                  meta={[
                    amounts.length > 0 ? amounts.join(" + ") : "—",
                    <span key="s">
                      {sentBefore}
                      <LocalTime iso={(q.sentAt ?? q.createdAt).toISOString()} locale={locale} />
                      {sentAfter}
                    </span>,
                  ]}
                  action={p.reviewApprove}
                  primary
                />
              );
            })}
            {payments?.tasks.map((c) => (
              <PaymentTaskRow
                key={c.id}
                href={c.payPath!}
                title={fmt(p.paymentTask, { label: c.label })}
                meta={`${formatMoney(c.amountCents, (c.currency || currency) as Currency, locale)}${c.kind === "subscription" ? t.charges.perMonth : ""}`}
                action={p.pay}
              />
            ))}
            {home.awaiting.map(ticketRow)}
            {payments && payments.tasks.length === 0 ? <AllClearRow title={p.paymentsOk} text={p.paymentsOkText} /> : null}
          </WorkList>
        </section>
      ) : null}

      {home.recent.length > 0 ? (
        <section aria-labelledby="p-recent" className="mb-10">
          <SectionHead id="p-recent" title={p.recentTitle} action={<MoreLink href="/tickets">{p.seeAll}</MoreLink>} />
          <WorkList>{home.recent.map(ticketRow)}</WorkList>
        </section>
      ) : null}

      <section aria-labelledby="p-plan" className="mb-10">
        <SectionTitle className="mb-3">
          <span id="p-plan">{p.planTitle}</span>
        </SectionTitle>
        <Card className="p-5 max-sm:p-4">
          {home.supportActive ? (
            <div className="space-y-2">
              <Badge tone="ok" className="font-medium">
                {p.supportActive}
              </Badge>
              {payments?.pastDue ? <Callout tone="danger">{fmt(t.charges.portalPastDue, { agency: agencyName })}</Callout> : null}
              {payments?.setupPayPath ? (
                <a
                  href={payments.setupPayPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses("primary", "lg") + " w-full"}
                >
                  {t.charges.portalActivate}
                </a>
              ) : null}
              {home.monthlyCents !== null ? (
                <p className="text-muted">
                  {p.monthlyValue}: <span className="font-medium text-ink">{formatMoney(home.monthlyCents, currency, locale)}</span>
                </p>
              ) : null}
              <p className="text-muted">{fmt(p.sitesCovered, { n: home.coveredCount })}</p>
              {home.hours ? (
                <HoursBlock hours={home.hours} t={t} locale={locale}>
                  {payments?.buyHours ? (
                    <details className="group mt-2">
                      <summary className="cursor-pointer list-none text-[0.8125rem] font-medium text-ink underline underline-offset-4 [&::-webkit-details-marker]:hidden">
                        {p.buyHours}
                      </summary>
                      <form action={buyHoursAction} className="mt-3 flex flex-wrap items-end gap-3">
                        <label className="block">
                          <span className="block text-[0.8125rem] text-muted mb-1">{p.buyHoursQty}</span>
                          <input
                            type="number"
                            name="hours"
                            min={1}
                            max={100}
                            step={1}
                            defaultValue={1}
                            required
                            inputMode="numeric"
                            className="h-9 w-24 rounded-md border border-line-strong bg-white px-3 text-ink tabular"
                          />
                        </label>
                        <SubmitButton>{p.buyHoursButton}</SubmitButton>
                        <p className="basis-full text-[0.8125rem] text-muted">
                          {fmt(p.buyHoursPrice, { price: formatMoney(payments.buyHours.unitCents, payments.buyHours.currency as Currency, locale) })}
                        </p>
                      </form>
                    </details>
                  ) : null}
                </HoursBlock>
              ) : null}
              <p className="text-muted">{home.generalTickets ? p.generalTicketsOn : p.generalTicketsOff}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <Badge tone="muted" className="font-medium">
                {p.supportInactive}
              </Badge>
              <p className="text-muted">{fmt(p.supportInactiveHint, { agency: agencyName })}</p>
            </div>
          )}
        </Card>
      </section>

      <section aria-labelledby="p-sites">
        <SectionTitle className="mb-3">
          <span id="p-sites">{p.yourSites}</span>
        </SectionTitle>
        {home.sites.length === 0 ? (
          <Card>
            <EmptyState icon="brief" title={p.noSites} text={fmt(p.noSitesHint, { agency: agencyName })} />
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {home.sites.map((site) => (
              <div key={site.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3.5">
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink">{site.name}</div>
                  {site.url ? (
                    isWebAddress(site.url) ? (
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-full items-center gap-1 text-[0.875rem] text-muted hover:text-ink transition-colors"
                      >
                        <span className="truncate">{site.url.replace(/^https?:\/\//i, "")}</span>
                        <Icon name="ext" size={12} className="flex-none" />
                      </a>
                    ) : (
                      <span className="text-[0.875rem] text-muted">{site.url}</span>
                    )
                  ) : null}
                </div>
                {site.includedInSupport ? <Badge tone="ok">{p.inSupport}</Badge> : null}
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

/** The hours: with included hours the balance, the bar and when it renews; without, the hours used. Numbers and strings only. */
function HoursBlock({
  hours,
  t,
  locale,
  children,
}: {
  children?: React.ReactNode;
  hours: NonNullable<Awaited<ReturnType<typeof getPortalHome>>["hours"]>;
  t: Awaited<ReturnType<typeof getPortalDict>>["t"];
  locale: Locale;
}) {
  const negative = hours.balanceMinutes < 0;
  const total = hours.includedMinutes + hours.purchasedMinutes;
  const month = formatCycle(hours.cycle, locale);
  if (!hours.limited) {
    // No included hours: only what was used this month.
    return (
      <div className="!mt-4 border-t border-line pt-4">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[1.75rem] font-semibold tabular text-ink">{formatMinutes(hours.usedMinutes)}</span>
          <span className="text-muted">{fmt(t.ui.usedIn, { month })}</span>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="!mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={negative ? "text-[1.75rem] font-semibold tabular text-danger" : "text-[1.75rem] font-semibold tabular text-ink"}>
          {formatMinutes(Math.abs(hours.balanceMinutes))}
        </span>
        <span className="text-muted">{fmt(negative ? t.ui.overdrawn : t.ui.available, { month })}</span>
      </div>
      <div className="mt-3">
        <ProgressBar value={hours.usedMinutes} max={total} tone={negative ? "danger" : "brand"} size="md" />
      </div>
      <div className="mt-1.5 flex justify-between text-[0.8125rem] text-muted tabular">
        <span>{fmt(t.ui.usedHours, { h: formatMinutes(hours.usedMinutes) })}</span>
        <span>{fmt(t.ui.monthHours, { h: formatMinutes(total) })}</span>
      </div>
      <p className="mt-2 text-[0.8125rem] text-muted">{fmt(t.ui.renews, { date: formatNextCycleStart(hours.cycle, locale) })}</p>
      {children}
    </div>
  );
}
