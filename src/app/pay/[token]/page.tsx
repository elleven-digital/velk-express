import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { AgencyAvatar } from "@/components/agency-avatar";
import { Callout } from "@/components/ui";
import { getAgency, logoPath } from "@/lib/agency";
import { startPayment } from "@/lib/core/charge-pay";
import { fmt, isLocale } from "@/lib/i18n";
import { getPublicDict } from "@/lib/i18n/server";
import { clientIp, passesAll, payLinkRules } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// The link is the only protection: keep it out of search engines. The tab shows the agency's name.
export async function generateMetadata(): Promise<Metadata> {
  const agency = await getAgency();
  return { title: agency?.name ?? "Velk Express", robots: { index: false, follow: false } };
}

/**
 * The stable payment link. Each visit checks the charge and sends the visitor to a fresh checkout
 * at its provider; when there is nothing to pay, a short page says why.
 *
 * Any GET, a link scanner's or a chat preview's included, creates a checkout and closes the one
 * before it. That is acceptable: a checkout costs nothing until it is paid, and the visitor who
 * then clicks simply gets a fresh one. Not every provider can close one (a Mercado Pago preference
 * stays payable), so the webhook logs any duplicate payment for the agency to refund.
 */
export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const agency = await getAgency();
  const { t } = await getPublicDict(isLocale(agency?.locale) ? agency.locale : undefined);

  const limited = !passesAll(payLinkRules(clientIp(await headers())));
  const res = limited ? null : await startPayment(token);
  // redirect() throws: keep it outside any try block.
  if (res?.ok) redirect(res.value.url);
  if (res && res.error === "notFound") notFound();

  const name = agency?.name ?? "";
  const messages: Record<string, string> = {
    alreadyPaid: t.charges.pay.paid,
    canceled: t.charges.pay.canceled,
    alreadyActive: fmt(t.charges.pay.active, { agency: name }),
    manual: fmt(t.charges.pay.manual, { agency: name }),
    providerUnavailable: fmt(t.charges.pay.unavailable, { agency: name }),
  };
  const text = res ? (messages[res.error] ?? messages.providerUnavailable) : t.charges.pay.tooMany;
  const tone = res && (res.error === "alreadyPaid" || res.error === "canceled") ? "ok" : "info";

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
        <div role="status" className="mx-auto w-full max-w-md">
          <Callout tone={tone} title={t.charges.pay.title}>
            {text}
          </Callout>
        </div>
      </main>
    </div>
  );
}
