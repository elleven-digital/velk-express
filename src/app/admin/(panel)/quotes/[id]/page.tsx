import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/link-box";
import { ConfirmForm } from "@/components/confirm-form";
import { Flash } from "@/components/flash";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { QuoteExecute } from "@/components/quote-execute";
import { QuoteSend } from "@/components/quote-send";
import { ChargeSection } from "@/components/charge-section";
import { Badge, Button, Callout, Card, LinkButton, PageHeader, SectionTitle } from "@/components/ui";
import { getAppUrl } from "@/lib/app-url";
import { chargeFor } from "@/lib/core/charges";
import { getQuote } from "@/lib/core/quotes";
import type { Currency } from "@/lib/core/settings";
import { formatMoney } from "@/lib/format";
import { fmt, lookup } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { decidedTotals, quoteStatusMeta } from "@/lib/quote-utils";
import type { QuoteLogEntry } from "@/lib/db";
import { archiveQuoteAction, deleteQuoteAction, executeQuoteAction, sendQuoteAction } from "../actions";
import { requireQuoteOwner } from "../guard";

export const dynamic = "force-dynamic";

const EXECUTE_FORM = "quote-execute";

export default async function QuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const me = await requireQuoteOwner();
  const found = await getQuote(me, id);
  if (!found.ok) notFound();
  const { quote, items, client, totals } = found.value;
  const { t, locale } = await getUserDict();

  const currency = quote.currency as Currency;
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const meta = quoteStatusMeta(quote.status);
  const decided = quote.status === "accepted" || quote.status === "executed";
  const approved = decidedTotals(quote.status, items);
  const open = quote.status === "draft" || quote.status === "sent";
  const executable = quote.status === "sent" || quote.status === "accepted";
  const executed = quote.status === "executed";
  const log = executed ? (quote.executionLog ?? []) : [];
  const [executedBefore, executedAfter] = t.quotes.executedOn.split("{date}");
  const p = t.portalUsers;
  const link = `${await getAppUrl()}/q/${quote.token}`;
  const [approvedBefore, approvedAfter] = t.quotes.clientApprovedOn.split("{date}");
  const logText = (entry: QuoteLogEntry): string => {
    switch (entry.action) {
      case "client":
        return t.quotes.logClient;
      case "clientUser":
        return entry.note === "linked" ? t.quotes.logClientUserLinked : t.quotes.logClientUser;
      case "site":
        return t.quotes.logSite;
      case "ticket":
        return t.quotes.logTicket;
      case "support":
        return entry.note === "replaced" ? t.quotes.logSupportReplaced : t.quotes.logSupport;
      default:
        return String((entry as { action: unknown }).action);
    }
  };
  /** Where each created thing lives in the panel; the client is the quote's own (set on execution). */
  const logHref = (entry: QuoteLogEntry): string | null => {
    const clientId = quote.clientId;
    switch (entry.action) {
      case "client":
      case "support":
        return `/admin/clients/${entry.id}`;
      case "clientUser":
        return clientId ? `/admin/clients/${clientId}/access` : null;
      case "site":
        return clientId ? `/admin/clients/${clientId}/sites` : null;
      case "ticket":
        return `/admin/tickets/${entry.id}`;
      default:
        return null;
    }
  };
  // Charging a quote: its one-time items (as the client decided them), once it has been sent.
  const chargeable = (quote.status === "sent" || quote.status === "accepted" || quote.status === "executed") && approved.oneTimeCents > 0;
  const existing = await chargeFor(me, { source: "quote", sourceId: quote.id });
  const hasCharge = existing.ok && existing.value !== null;
  const kindLabel = {
    site_creation: t.quotes.kindSiteCreation,
    maintenance: t.quotes.kindMaintenance,
    support: t.quotes.kindSupport,
  };

  return (
    <>
      <PageHeader
        title={quote.title}
        meta={
          <>
            <Badge tone={meta.tone}>{t.quotes.status[meta.key]}</Badge>
            {client ? (
              <Link href={`/admin/clients/${client.id}`} className="text-ink underline underline-offset-2">
                {client.name}
              </Link>
            ) : (
              <span>{fmt(t.quotes.prospectOf, { name: quote.prospectName ?? "" })}</span>
            )}
            {!client && quote.prospectEmail ? <span>{quote.prospectEmail}</span> : null}
          </>
        }
        actions={
          <>
            {quote.status !== "executed" && quote.status !== "archived" ? (
              <ConfirmForm action={archiveQuoteAction} message={t.quotes.confirmArchive}>
                <input type="hidden" name="quoteId" value={quote.id} />
                <Button type="submit" variant="ghost">
                  {t.quotes.archive}
                </Button>
              </ConfirmForm>
            ) : null}
            {quote.status === "draft" ? (
              <ConfirmForm action={deleteQuoteAction} message={t.quotes.confirmDelete}>
                <input type="hidden" name="quoteId" value={quote.id} />
                <Button type="submit" variant="ghost" className="text-danger hover:text-danger">
                  {t.quotes.deleteQuote}
                </Button>
              </ConfirmForm>
            ) : null}
            {open ? (
              <LinkButton href={`/admin/quotes/${quote.id}/edit`} variant="secondary">
                <Icon name="pencil" />
                {t.quotes.edit}
              </LinkButton>
            ) : null}
          </>
        }
      />

      <Flash ok={sp.ok === "saved" ? t.quotes.saved : undefined} error={lookup(t.quotes.errors, sp.err)} />
      {quote.acceptedAt && quote.status !== "executed" ? (
        <Callout tone="ok" className="mb-6">
          {approvedBefore}
          <LocalTime iso={quote.acceptedAt.toISOString()} locale={locale} />
          {approvedAfter}
        </Callout>
      ) : null}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <div className="border-b border-line px-5 py-3.5">
              <SectionTitle>{t.quotes.items}</SectionTitle>
            </div>
            <ul className="divide-y divide-line">
              {items.map((item, index) => (
                <li key={item.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
                    <div className="flex min-w-0 items-start gap-3">
                      {executable ? (
                        <input
                          type="checkbox"
                          name="itemIds"
                          value={item.id}
                          form={EXECUTE_FORM}
                          defaultChecked={item.clientApproved}
                          aria-label={fmt(t.quotes.executeItem, { title: item.title })}
                          className="mt-1 size-4 shrink-0 accent-ink"
                        />
                      ) : null}
                      <div className="min-w-0">
                        <div className="font-medium text-ink [overflow-wrap:anywhere]">
                          <span className="tabular mr-2 text-muted">{String(index + 1).padStart(2, "0")}</span>
                          {item.title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-muted">
                          <span>{kindLabel[item.kind]}</span>
                          {item.clientApproved && quote.status !== "executed" ? (
                            <Badge tone="ok">{t.quotes.approvedByClient}</Badge>
                          ) : null}
                          {item.executed && !item.clientApproved ? <Badge tone="info">{t.quotes.includedByAgency}</Badge> : null}
                          {item.executed ? <Badge tone="ok">{t.quotes.status.executed}</Badge> : null}
                        </div>
                      </div>
                    </div>
                    <div className="tabular text-right">
                      <div className="font-medium text-ink">{item.amountCents > 0 ? money(item.amountCents) : "—"}</div>
                      <div className="text-[0.8125rem] text-muted">{item.monthly ? t.quotes.monthly : t.quotes.oneTime}</div>
                    </div>
                  </div>
                  {item.description ? (
                    <p className="mt-2 whitespace-pre-wrap text-[0.875rem] text-muted [overflow-wrap:anywhere]">{item.description}</p>
                  ) : null}
                </li>
              ))}
            </ul>
            {executable || executed ? (
              <QuoteExecute
                action={executeQuoteAction}
                quoteId={quote.id}
                formId={EXECUTE_FORM}
                executable={executable}
                labels={{
                  section: t.quotes.executeSection,
                  hint: t.quotes.executeHint,
                  button: t.quotes.executeButton,
                  confirm: t.quotes.executeConfirm,
                  link: {
                    linkTitle: p.linkTitle,
                    linkHint: p.linkHint,
                    expiresInvite: p.expiresInvite,
                    expiresReset: p.expiresReset,
                    emailSent: p.emailSent,
                    emailNotSent: p.emailNotSent,
                    copyLink: p.copyLink,
                    copiedLink: p.copiedLink,
                  },
                }}
              />
            ) : null}
          </Card>
          {quote.notes ? (
            <Card className="p-5">
              <SectionTitle className="mb-2">{t.quotes.notesTitle}</SectionTitle>
              <p className="whitespace-pre-wrap text-[0.875rem] text-muted [overflow-wrap:anywhere]">{quote.notes}</p>
            </Card>
          ) : null}
        </div>

        <Card className="min-w-0 divide-y divide-line">
          <div className="space-y-3 p-5">
            <SectionTitle>{t.quotes.summary}</SectionTitle>
            <dl className="space-y-1.5 text-[0.875rem]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{t.quotes.oneTime}</dt>
                <dd className="tabular font-medium text-ink">{money(totals.oneTimeCents)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{t.quotes.monthly}</dt>
                <dd className="tabular font-medium text-ink">{money(totals.monthlyCents)}</dd>
              </div>
            </dl>
            {decided ? (
              <div className="space-y-1.5 border-t border-line pt-3">
                <div className="text-[0.8125rem] font-medium text-ink">{t.quotes.approvedTotal}</div>
                <dl className="space-y-1.5 text-[0.875rem]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">{t.quotes.oneTime}</dt>
                    <dd className="tabular font-medium text-ink">{money(approved.oneTimeCents)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">{t.quotes.monthly}</dt>
                    <dd className="tabular font-medium text-ink">{money(approved.monthlyCents)}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </div>

          {chargeable || hasCharge ? (
          <div className="space-y-3 p-5">
            <SectionTitle>{t.charges.cardTitle}</SectionTitle>
            <ChargeSection
              me={me}
              source="quote"
              sourceId={quote.id}
              clientId={quote.clientId}
              offer={chargeable}
              amountCents={approved.oneTimeCents}
              currency={quote.currency}
              note={totals.monthlyCents > 0 ? t.charges.monthlyHint : undefined}
            />
          </div>
          ) : null}

          {quote.status !== "archived" ? (
            <div className="space-y-3 p-5">
              <SectionTitle>{t.quotes.publicLink}</SectionTitle>
              {quote.status === "draft" ? (
                <p className="text-[0.8125rem] text-muted">{t.quotes.draftLinkHint}</p>
              ) : (
                <div className="space-y-2">
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t.quotes.openPublic}
                    className="block truncate font-mono text-[0.8125rem] text-ink underline underline-offset-2"
                  >
                    {link.replace(/^https?:\/\//, "")}
                  </a>
                  <CopyButton text={link} label={t.quotes.copyLink} copiedLabel={t.quotes.copied} />
                </div>
              )}
            </div>
          ) : null}

          {executed ? (
            <div className="space-y-3 p-5">
              <SectionTitle>{t.quotes.executionLog}</SectionTitle>
              <ul className="space-y-2 text-[0.875rem]">
                {log.map((entry, index) => {
                  const href = logHref(entry);
                  return (
                    <li key={`${entry.action}-${entry.id}-${index}`} className="flex items-start gap-2">
                      <Icon name="check" className="mt-0.5 shrink-0 text-dot-ok" />
                      <div className="min-w-0">
                        <div className="text-ink">{logText(entry)}</div>
                        {entry.label ? (
                          href ? (
                            <Link href={href} className="text-muted underline underline-offset-2 [overflow-wrap:anywhere] hover:text-ink">
                              {entry.label}
                            </Link>
                          ) : (
                            <span className="text-muted [overflow-wrap:anywhere]">{entry.label}</span>
                          )
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {quote.executedAt ? (
                <p className="text-[0.8125rem] text-muted">
                  {executedBefore}
                  <LocalTime iso={quote.executedAt.toISOString()} locale={locale} />
                  {executedAfter}
                </p>
              ) : null}
            </div>
          ) : null}

          {open ? (
            <div className="p-5">
              <QuoteSend
                action={sendQuoteAction}
                quoteId={quote.id}
                labels={{
                  send: quote.status === "draft" ? t.quotes.send : t.quotes.resend,
                  hint: quote.status === "draft" ? t.quotes.sendHint : t.quotes.resendHint,
                }}
              />
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
