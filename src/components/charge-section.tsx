import { ChargeCreate } from "@/components/charge-create";
import { ChargePanel, type ChargeActions, type ChargeLabels } from "@/components/charge-panel";
import { getAgency } from "@/lib/agency";
import type { TeamSession } from "@/lib/auth/session";
import { cancelChargeAction, createSourceChargeAction, markChargePaidAction, attachDocumentAction, removeDocumentAction } from "@/app/admin/(panel)/charges/actions";
import { chargeStatusMeta, isLiveStatus } from "@/lib/charge-utils";
import { chargeFor, type ChargeView } from "@/lib/core/charges";
import { chargeOptions } from "@/lib/core/charge-options";
import type { Currency } from "@/lib/core/settings";
import { formatMoment, formatMoney, moneyInputValue, moneyPlaceholder } from "@/lib/format";
import { fmt, type Dict, type Locale } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { DEFAULT_TIME_ZONE } from "@/lib/time-zone";

/** The texts of the charge screens, picked from the dictionary. */
export function chargeLabelsOf(t: Dict): ChargeLabels {
  const c = t.charges;
  return {
    copyLink: c.copyLink,
    copied: c.copied,
    openLink: c.openLink,
    markPaid: c.markPaid,
    markPaidHint: c.markPaidHint,
    cancel: c.cancelCharge,
    cancelConfirm: c.cancelConfirm,
    documentTitle: c.docLabel,
    upload: c.docUpload,
    uploading: c.docUploading,
    open: c.docOpen,
    remove: c.docRemove,
    removeConfirm: c.docRemoveConfirm,
    hint: c.docHint,
    fileType: c.errors.fileType,
    fileTooLarge: c.errors.fileTooLarge,
    uploadFailed: c.errors.uploadFailed,
    invalidFile: c.errors.invalidFile,
  };
}

export function providerLabels(t: Dict): Record<string, string> {
  return { stripe: t.charges.providerStripe, mercadopago: t.charges.providerMercadoPago, manual: t.charges.providerManual };
}

/** "Payment via Stripe", "Payment via Mercado Pago" or "Manual record". */
export function chargeFooter(t: Dict, provider: ChargeView["provider"]): string {
  return provider === "stripe" ? t.charges.viaStripe : provider === "mercadopago" ? t.charges.viaMercadoPago : t.charges.viaManual;
}

/** A charge's amount in its own currency, "/month" for a subscription. */
export function chargeAmount(t: Dict, locale: Locale, charge: Pick<ChargeView, "amountCents" | "currency" | "kind">): string {
  const money = formatMoney(charge.amountCents, charge.currency as Currency, locale);
  return charge.kind === "subscription" ? `${money}${t.charges.perMonth}` : money;
}

/** What a ticket, quote or support panel shows to someone allowed to act on the charge. */
export function chargeActionsFor(charge: ChargeView): ChargeActions {
  if (!charge.canAct) return {};
  return {
    ...(isLiveStatus(charge.status) ? { cancel: cancelChargeAction.bind(null, charge.id) } : {}),
    markPaid: markChargePaidAction.bind(null, charge.id),
    attach: attachDocumentAction.bind(null, charge.id),
    ...(charge.document ? { removeDocument: removeDocumentAction.bind(null, charge.id) } : {}),
  };
}

/**
 * The charge of one source, the same block on every screen: the charge itself (status, link,
 * actions, document) or, with none yet, the form to create it. `offer` says whether there is
 * anything to charge (the page decides); with no charge and nothing to offer this shows nothing.
 * `amountCents` is the amount a new charge would have; `editableValue` makes it a field (a
 * ticket's agreed value). Staff only: the callers have checked.
 */
export async function ChargeSection({
  me,
  source,
  sourceId,
  clientId,
  kind = "one_time",
  offer,
  amountCents,
  editableValue,
  currency,
  note,
}: {
  me: TeamSession;
  source: "ticket" | "support" | "hours" | "quote";
  sourceId: string;
  clientId: string | null;
  kind?: "one_time" | "subscription";
  offer: boolean;
  amountCents?: number | null;
  editableValue?: boolean;
  currency?: string;
  note?: string;
}) {
  const [{ t, locale }, found, agency] = await Promise.all([getUserDict(), chargeFor(me, { source, sourceId }), getAgency()]);
  const charge = found.ok ? found.value : null;
  const timeZone = agency?.timeZone ?? DEFAULT_TIME_ZONE;

  if (charge) {
    const meta = chargeStatusMeta(charge.status);
    const live = isLiveStatus(charge.status);
    return (
      <>
        <ChargePanel
          chargeId={charge.id}
          status={{ label: t.charges[meta.key], tone: meta.tone }}
          amount={chargeAmount(t, locale, charge)}
          paidOn={charge.paidAt ? fmt(t.charges.paidOn, { date: formatMoment(new Date(charge.paidAt), locale, new Date(), timeZone) }) : null}
          payUrl={live ? charge.payUrl : null}
          canMarkPaid={charge.canAct && charge.kind === "one_time" && charge.status === "pending"}
          document={charge.document}
          footer={chargeFooter(t, charge.provider)}
          actions={chargeActionsFor(charge)}
          labels={chargeLabelsOf(t)}
        />
        {note ? <p className="mt-3 text-[0.8125rem] text-muted">{note}</p> : null}
      </>
    );
  }
  if (!offer) return null;

  const options = await chargeOptions(me, { kind, clientId, currency });
  const labelsOf = providerLabels(t);
  const cur = options.currency as Currency;
  return (
    <div className="space-y-3">
      {amountCents && !editableValue ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted">{kind === "subscription" ? t.charges.kindMonthly : t.charges.kindOneTime}</span>
          <b className="tabular font-medium text-ink">
            {formatMoney(amountCents, cur, locale)}
            {kind === "subscription" ? t.charges.perMonth : ""}
          </b>
        </div>
      ) : null}
      <ChargeCreate
        action={createSourceChargeAction.bind(null, source, sourceId)}
        providers={options.providers.map((value) => ({ value, label: labelsOf[value] }))}
        defaultProvider={options.defaultProvider}
        amount={editableValue ? { value: moneyInputValue(amountCents ?? null, locale), placeholder: moneyPlaceholder(locale) } : undefined}
        labels={{
          provider: t.charges.providerLabel,
          create: t.charges.create,
          amount: fmt(t.charges.valueLabel, { currency: options.currency }),
          save: editableValue ? t.charges.valueSave : undefined,
          // Only the owner reaches Settings → Payments, so the others are told to ask.
          manualHint: me.user.role === "owner" ? t.charges.manualHint : t.charges.manualHintAsk,
        }}
      />
      {note ? <p className="text-[0.8125rem] text-muted">{note}</p> : null}
    </div>
  );
}
