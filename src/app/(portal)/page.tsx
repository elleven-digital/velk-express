import { Callout, Card, EmptyState, LinkButton, MoreLink, PageHeader, SectionHead } from "@/components/ui";
import { Flash } from "@/components/flash";
import { LocalTime } from "@/components/local-time";
import { PaymentTaskRow, PortalTicketRow, ProposalRow, WorkList } from "@/components/work-list";
import { Icon } from "@/components/icons";
import { getAgency } from "@/lib/agency";
import { requirePortal } from "@/lib/auth/guards";
import { getPortalHome } from "@/lib/core/portal-home";
import type { Currency } from "@/lib/core/settings";
import { formatMoney } from "@/lib/format";
import { fmt, lookup } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import type { PortalTicketRow as TicketRow } from "@/lib/core/portal-tickets";

export const dynamic = "force-dynamic";

/**
 * The portal home: proposals and payments waiting on the company (only when there are any), the
 * projects in progress and the open tickets. Projects show once the company has had one; tickets while it has the
 * support plan or has ever had a ticket. Money (payment tasks, the past-due notice) is for the admin.
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
  // Money and proposals only (the company's admin): tickets and projects have their own sections.
  const commercialCount = home.proposals.length + (payments?.tasks.length ?? 0) + (payments?.pastDue ? 1 : 0);
  // "Sent {when}." / "Since {date}": the moment is a client component, so the sentence is cut around it
  const [sentBefore, sentAfter = ""] = p.proposalSent.split("{when}");
  const [sinceBefore, sinceAfter = ""] = p.projectStartedOn.split("{date}");
  const ticketRow = (r: TicketRow) => (
    <PortalTicketRow
      key={r.id}
      href={`/tickets/${r.id}`}
      title={r.title}
      number={r.number}
      site={r.siteName ?? t.tickets.generalLabel}
      when={<LocalTime iso={r.lastActivity.toISOString()} locale={locale} />}
      unread={{ n: r.unread, label: r.unread === 1 ? t.tickets.unreadOne : fmt(t.tickets.unreadMany, { n: r.unread }) }}
      closed={r.status === "closed" ? t.tickets.statusClosed : undefined}
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

      {commercialCount > 0 ? (
        <section aria-labelledby="p-commercial" className="mb-10">
          <SectionHead id="p-commercial" title={p.commercialTitle} count={commercialCount} />
          <WorkList>
            {payments?.pastDue ? (
              <ProposalRow
                href="/payments"
                title={p.pastDueTask}
                meta={fmt(t.charges.portalPastDue, { agency: agencyName })}
                status={{ tone: "danger", label: p.pastDueBadge }}
                action={p.seePayments}
                primary
              />
            ) : null}
            {home.proposals.map((q) => {
              const quoteCurrency = (q.currency || currency) as Currency;
              const amounts = [
                q.oneTimeCents > 0 ? formatMoney(q.oneTimeCents, quoteCurrency, locale) : null,
                q.monthlyCents > 0 ? `${formatMoney(q.monthlyCents, quoteCurrency, locale)}${t.quotes.perMonth}` : null,
              ].filter(Boolean);
              return (
                <ProposalRow
                  key={q.id}
                  href={`/quotes/${q.token}`}
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
          </WorkList>
        </section>
      ) : null}

      {home.sections.projects ? (
        <section aria-labelledby="p-projects" className="mb-10">
          <SectionHead
            id="p-projects"
            title={p.projectsTitle}
            count={home.projects.length}
            action={<MoreLink href="/projects">{p.seeAll}</MoreLink>}
          />
          {home.projects.length === 0 ? (
            <Card>
              <EmptyState icon="brief" title={p.projectsNoneOngoing} />
            </Card>
          ) : (
            <WorkList>
              {home.projects.map((r) => (
                <ProposalRow
                  key={r.id}
                  href={`/projects/${r.id}`}
                  title={r.title}
                  meta={[
                    r.siteName,
                    <span key="since">
                      {sinceBefore}
                      <LocalTime iso={r.createdAt.toISOString()} locale={locale} />
                      {sinceAfter}
                    </span>,
                  ].filter(Boolean)}
                  unread={{ n: r.unread, label: r.unread === 1 ? t.tickets.unreadOne : fmt(t.tickets.unreadMany, { n: r.unread }) }}
                  action={p.projectFollow}
                  primary={false}
                />
              ))}
            </WorkList>
          )}
        </section>
      ) : null}

      {home.sections.tickets ? (
        <section aria-labelledby="p-open">
          <SectionHead
            id="p-open"
            title={p.openTicketsTitle}
            count={home.openTickets.length}
            action={<MoreLink href="/tickets">{p.seeAll}</MoreLink>}
          />
          {home.openTickets.length === 0 ? (
            <Card>
              <EmptyState icon="inbox" title={p.homeNoOpenTickets} />
            </Card>
          ) : (
            <WorkList>{home.openTickets.map(ticketRow)}</WorkList>
          )}
        </section>
      ) : null}
    </div>
  );
}
