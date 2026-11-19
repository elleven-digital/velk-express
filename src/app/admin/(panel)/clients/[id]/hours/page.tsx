import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon, type IconName } from "@/components/icons";
import { ChargeCreate } from "@/components/charge-create";
import { providerLabels } from "@/components/charge-section";
import { CopyButton } from "@/components/link-box";
import { PurchaseForm } from "@/components/purchase-form";
import { ControlButton } from "@/components/ticket-controls";
import {
  Badge,
  buttonClasses,
  Callout,
  Card,
  cn,
  EmptyState,
  LinkButton,
  MetaLine,
  SectionHead,
  SectionTitle,
  StatCard,
  StatGrid,
} from "@/components/ui";
import { isStaff } from "@/lib/access";
import { getAgency } from "@/lib/agency";
import { requireTeam } from "@/lib/auth/guards";
import { createSourceChargeAction } from "../../../charges/actions";
import { chargeStatusMeta, isLiveStatus } from "@/lib/charge-utils";
import { chargeFor, type ChargeView } from "@/lib/core/charges";
import { chargeOptions } from "@/lib/core/charge-options";
import type { Currency } from "@/lib/core/settings";
import { getClientCached } from "@/lib/core/clients";
import { getClientHoursCycle } from "@/lib/core/hours";
import {
  formatCycle,
  formatDay,
  formatMinutes,
  formatMoney,
  moneyPlaceholder,
} from "@/lib/format";
import { cycleKey, isCycle, shiftCycle, todayInCycleZone } from "@/lib/hours";
import { DEFAULT_TIME_ZONE } from "@/lib/time-zone";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { addPurchaseAction, deletePurchaseAction } from "./actions";

export const dynamic = "force-dynamic";

/** An empty list under its heading: one quiet line. */
function EmptyRow({
  icon,
  children,
}: {
  icon: IconName;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex items-center gap-3 px-4 py-5 text-muted">
      <Icon name={icon} />
      {children}
    </Card>
  );
}

/** A client's hours, one cycle at a time. Owners and managers only: collaborators get a 404. */
export default async function ClientHoursPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cycle?: string }>;
}) {
  const { id } = await params;
  const { cycle: rawCycle } = await searchParams;
  const me = await requireTeam();
  if (!isStaff(me.user)) notFound();
  const found = await getClientCached(me, id);
  if (!found.ok) notFound();
  const client = found.value;

  const agency = await getAgency();
  const timeZone = agency?.timeZone ?? DEFAULT_TIME_ZONE;
  const cycle =
    rawCycle && isCycle(rawCycle) ? rawCycle : cycleKey(new Date(), timeZone);
  const [res, { t, locale }] = await Promise.all([
    getClientHoursCycle(me, client.id, cycle),
    getUserDict(),
  ]);
  if (!res.ok) notFound();
  const { summary, entries, purchases } = res.value;
  const currency = (agency?.currency ?? "BRL") as "BRL" | "USD";

  // The charge of each purchase, for the status and the "Charge" button.
  const purchaseCharges = new Map<string, ChargeView>();
  const providerChoices = await chargeOptions(me, {
    kind: "one_time",
    clientId: client.id,
  });
  await Promise.all(
    purchases.map(async (p) => {
      const found = await chargeFor(me, { source: "hours", sourceId: p.id });
      if (found.ok && found.value) purchaseCharges.set(p.id, found.value);
    }),
  );
  const providerLabel = providerLabels(t);

  const base = `/admin/clients/${client.id}/hours`;
  const internal = summary.mode === "internal";
  const month = formatCycle(cycle, locale);
  const title = month.charAt(0).toUpperCase() + month.slice(1);

  const off = summary.mode === "off";
  // With hours off, a cycle that still holds time or purchases keeps showing them; only an empty one gets the empty state.
  const offEmpty = off && entries.length === 0 && purchases.length === 0;

  return (
    <div>
      {internal ? (
        <Callout tone="info" className="mb-6">
          {t.hours.internalOnly}
        </Callout>
      ) : null}
      {off && !offEmpty ? (
        <Callout tone="info" className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t.hours.notTracked}</span>
            <LinkButton
              href={`/admin/clients/${client.id}#support`}
              variant="secondary"
              size="sm"
            >
              {t.hours.offLink}
            </LinkButton>
          </div>
        </Callout>
      ) : null}

      <div className="mb-4 flex items-center gap-2">
        <Link
          href={`${base}?cycle=${shiftCycle(cycle, -1)}`}
          className={cn(buttonClasses("secondary", "sm"), "!px-0 w-8")}
          aria-label={t.hours.prevCycle}
        >
          <Icon name="chevron" className="rotate-90" />
        </Link>
        <SectionTitle className="min-w-0 px-1.5 tabular">{title}</SectionTitle>
        <Link
          href={`${base}?cycle=${shiftCycle(cycle, 1)}`}
          className={cn(buttonClasses("secondary", "sm"), "!px-0 w-8")}
          aria-label={t.hours.nextCycle}
        >
          <Icon name="chevron" className="-rotate-90" />
        </Link>
      </div>

      {offEmpty ? (
        <Card>
          <EmptyState
            icon="clock"
            title={t.hours.offTitle}
            text={t.hours.offText}
            action={
              <LinkButton
                href={`/admin/clients/${client.id}#support`}
                variant="secondary"
                size="sm"
              >
                {t.hours.offLink}
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <>
          {internal ? (
            <StatGrid cols={1} className="mb-6 sm:max-w-64">
              <StatCard
                label={t.hours.used}
                value={formatMinutes(summary.usedMinutes)}
              />
            </StatGrid>
          ) : (
            <StatGrid cols={4} className="mb-6">
              <StatCard
                label={t.hours.included}
                value={formatMinutes(summary.includedMinutes)}
              />
              <StatCard
                label={t.hours.purchased}
                value={formatMinutes(summary.purchasedMinutes)}
              />
              <StatCard
                label={t.hours.used}
                value={formatMinutes(summary.usedMinutes)}
              />
              <StatCard
                label={t.hours.balance}
                value={formatMinutes(summary.balanceMinutes)}
                tone={summary.balanceMinutes < 0 ? "alert" : "default"}
              />
            </StatGrid>
          )}

          {summary.mode === "package" && summary.balanceMinutes < 0 ? (
            <Callout tone="danger" className="mb-6">
              {t.hours.negativeWarning}
            </Callout>
          ) : null}

          <div
            className={cn(
              "grid items-start gap-x-6 gap-y-8",
              !internal && "lg:grid-cols-[minmax(0,1fr)_340px]",
            )}
          >
            <div className="min-w-0 space-y-8">
              <section aria-labelledby="h-entries">
                <SectionHead id="h-entries" title={t.hours.entries} />
                {entries.length === 0 ? (
                  <EmptyRow icon="clock">{t.hours.noEntries}</EmptyRow>
                ) : (
                  <Card className="divide-y divide-line overflow-hidden">
                    {entries.map((e) => (
                      // the ticket's link covers the row
                      <div
                        key={e.id}
                        className="relative flex items-center gap-4 px-4 py-3 transition-colors hover:bg-paper"
                      >
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/admin/tickets/${e.ticketId}`}
                            className="block truncate font-medium text-ink underline-offset-[3px] hover:underline after:absolute after:inset-0 after:content-['']"
                          >
                            <span className="mr-1.5 font-normal text-muted tabular">
                              #{e.ticketNumber}
                            </span>
                            {e.ticketTitle}
                          </Link>
                          <MetaLine className="mt-0.5">
                            {e.note ? (
                              <span className="[overflow-wrap:anywhere]">
                                {e.note}
                              </span>
                            ) : null}
                            <span className="tabular">
                              {formatDay(e.workedOn, locale)}
                            </span>
                            {e.ticketType === "single" ? (
                              <span className="italic">
                                {t.hours.outsideBundle}
                              </span>
                            ) : null}
                          </MetaLine>
                        </div>
                        <span
                          className={cn(
                            "flex-none font-medium tabular",
                            e.ticketType === "single"
                              ? "text-muted"
                              : "text-ink",
                          )}
                        >
                          {formatMinutes(e.minutes)}
                        </span>
                      </div>
                    ))}
                  </Card>
                )}
              </section>

              {internal ? null : (
                <section aria-labelledby="h-purchases">
                  <SectionHead id="h-purchases" title={t.hours.purchases} />
                  {purchases.length === 0 ? (
                    <EmptyRow icon="receipt">{t.hours.noPurchases}</EmptyRow>
                  ) : (
                    <Card className="divide-y divide-line overflow-hidden">
                      {purchases.map((p) => {
                        const charge = purchaseCharges.get(p.id);
                        const meta = charge
                          ? chargeStatusMeta(charge.status)
                          : null;
                        return (
                          <div
                            key={p.id}
                            className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium text-ink">
                                {p.note ?? t.hours.purchased}
                              </div>
                              <MetaLine className="mt-0.5">
                                {charge && meta ? (
                                  <Badge tone={meta.tone}>
                                    {t.charges[meta.key]}
                                  </Badge>
                                ) : p.pending ? (
                                  <Badge tone="warn">
                                    {t.hours.pendingPayment}
                                  </Badge>
                                ) : null}
                                {p.priceCents !== null ? (
                                  <span className="tabular">
                                    {formatMoney(
                                      p.priceCents,
                                      (charge?.currency ??
                                        currency) as Currency,
                                      locale,
                                    )}
                                  </span>
                                ) : null}
                                <span className="tabular">
                                  {formatDay(
                                    todayInCycleZone(
                                      new Date(p.createdAt),
                                      timeZone,
                                    ),
                                    locale,
                                  )}
                                </span>
                              </MetaLine>
                            </div>
                            <span className="flex-none font-medium text-ink tabular">
                              +{formatMinutes(p.minutes)}
                            </span>
                            {charge ? (
                              charge.payUrl && isLiveStatus(charge.status) ? (
                                <CopyButton
                                  text={charge.payUrl}
                                  label={t.charges.copyLink}
                                  copiedLabel={t.charges.copied}
                                />
                              ) : null
                            ) : p.priceCents !== null && p.priceCents > 0 ? (
                              <div className="flex-none">
                                <ChargeCreate
                                  compact
                                  action={createSourceChargeAction.bind(
                                    null,
                                    "hours",
                                    p.id,
                                  )}
                                  providers={providerChoices.providers.map(
                                    (value) => ({
                                      value,
                                      label: providerLabel[value],
                                    }),
                                  )}
                                  defaultProvider={
                                    providerChoices.defaultProvider
                                  }
                                  labels={{
                                    provider: t.charges.providerLabel,
                                    create: t.charges.chargeButton,
                                  }}
                                />
                              </div>
                            ) : null}
                            {p.pending || charge ? null : (
                              <ControlButton
                                variant="ghost"
                                className="-my-1 w-8 flex-none !px-0 text-muted hover:text-danger"
                                label={t.hours.deletePurchase}
                                confirm={t.hours.deletePurchaseConfirm}
                                action={deletePurchaseAction.bind(
                                  null,
                                  client.id,
                                  p.id,
                                )}
                              >
                                <Icon name="x" />
                              </ControlButton>
                            )}
                          </div>
                        );
                      })}
                    </Card>
                  )}
                </section>
              )}
            </div>

            {internal ? null : (
              <Card className="p-5 lg:sticky lg:top-6">
                <SectionTitle className="mb-4">
                  {t.hours.addPurchase}
                </SectionTitle>
                <PurchaseForm
                  action={addPurchaseAction.bind(null, client.id)}
                  cycle={cycle}
                  cycleLabel={title}
                  placeholder={moneyPlaceholder(locale)}
                  labels={{
                    time: t.hours.purchaseTime,
                    hint: t.hours.purchaseTimeHint,
                    price: fmt(t.hours.purchasePrice, { currency }),
                    note: `${t.hours.purchaseNote} (${t.clients.optional})`,
                    purchaseFor: t.hours.purchaseFor,
                    add: t.hours.add,
                  }}
                />
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}
