import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AgencyAvatar } from "@/components/agency-avatar";
import { Callout, buttonClasses } from "@/components/ui";
import { getAgency, logoPath } from "@/lib/agency";
import { getPayDone, payDoneState } from "@/lib/core/charge-pay";
import type { Currency } from "@/lib/core/settings";
import { formatMoney } from "@/lib/format";
import { fmt, isLocale } from "@/lib/i18n";
import { getPublicDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// The link is the only protection: keep it out of search engines. The tab shows the agency's name.
export async function generateMetadata(): Promise<Metadata> {
  const agency = await getAgency();
  return { title: agency?.name ?? "Velk Express", robots: { index: false, follow: false } };
}

/**
 * Where the payer lands after the provider's page. It only reports: the confirmation comes from
 * the provider's webhook, never from this visit, and it never opens a checkout.
 */
export default async function PayDonePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const charge = await getPayDone(token);
  if (!charge) notFound();
  const agency = await getAgency();
  const { t, locale } = await getPublicDict(isLocale(agency?.locale) ? agency.locale : undefined);
  const name = agency?.name ?? "";
  const pay = t.charges.pay;

  const state = payDoneState(charge.status, sp);
  const text = {
    confirmed: pay.doneConfirmed,
    canceled: pay.canceled,
    received: fmt(pay.doneReceived, { agency: name }),
    notCompleted: pay.doneNotCompleted,
  }[state];
  const tone = state === "confirmed" ? "ok" : "info";
  const retry = state === "notCompleted";

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-line">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 h-14 flex items-center">
          <span className="inline-flex items-center gap-2.5 min-w-0">
            <AgencyAvatar name={name} logoUrl={logoPath(agency?.logoFileId ?? null)} size={24} />
            <span className="font-medium text-ink truncate">{name}</span>
          </span>
        </div>
      </header>
      <main className="flex-1 px-4 pt-10 lg:pt-16 pb-16">
        <div role="status" className="mx-auto w-full max-w-md space-y-4">
          <div className="rounded-lg border border-line px-4 py-3">
            <div className="truncate font-medium text-ink">{charge.label}</div>
            <div className="text-sm text-muted">{formatMoney(charge.amountCents, charge.currency as Currency, locale)}</div>
          </div>
          <Callout tone={tone} title={pay.title}>
            {text}
          </Callout>
          {retry ? (
            <a href={`/pay/${token}`} className={buttonClasses("primary", "md")}>
              {pay.doneRetry}
            </a>
          ) : null}
        </div>
      </main>
    </div>
  );
}
