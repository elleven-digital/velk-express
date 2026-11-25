import { notFound, redirect } from "next/navigation";
import { QuoteBuilder, type BuilderInitial } from "@/components/quote-builder";
import { PageHeader } from "@/components/ui";
import { getQuote } from "@/lib/core/quotes";
import type { Currency } from "@/lib/core/settings";
import { moneyInputValue } from "@/lib/format";
import { minutesToHoursInput } from "@/lib/hours";
import { configHoursPlan } from "@/lib/hours-plan";
import { getUserDict } from "@/lib/i18n/server";
import { saveQuoteAction } from "../../actions";
import { hoursLabelsOf, loadBuilderData } from "../../builder-data";
import { requireQuoteOwner } from "../../guard";

export const dynamic = "force-dynamic";

export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireQuoteOwner();
  const found = await getQuote(me, id);
  if (!found.ok) notFound();
  const { quote, items } = found.value;
  if (quote.status !== "draft" && quote.status !== "sent") redirect(`/admin/quotes/${quote.id}`);

  const { t, locale } = await getUserDict();
  const data = await loadBuilderData();
  const initial: BuilderInitial = {
    mode: quote.clientId ? "client" : "prospect",
    clientId: quote.clientId ?? "",
    prospectName: quote.prospectName ?? "",
    prospectEmail: quote.prospectEmail ?? "",
    title: quote.title,
    notes: quote.notes ?? "",
    items: items.map((item) => {
      const c = item.config;
      const plan = configHoursPlan(c);
      return {
        kind: item.kind,
        title: item.title,
        description: item.description ?? "",
        amount: item.amountCents > 0 ? moneyInputValue(item.amountCents, locale) : "",
        siteId: c.siteId ?? "",
        newSiteName: c.newSite?.name ?? "",
        newSiteUrl: c.newSite?.url ?? "",
        siteIds: c.siteIds ?? [],
        newSites: (c.newSites ?? []).map((s) => ({ name: s.name, url: s.url ?? "" })),
        hoursTracked: plan.tracked,
        hoursVisible: plan.visible,
        hoursLimited: plan.limited,
        hoursPurchasable: plan.purchasable,
        includedHours: minutesToHoursInput(plan.includedMinutes),
        extraHourPrice: plan.extraHourCents ? moneyInputValue(plan.extraHourCents, locale) : "",
      };
    }),
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title={t.quotes.editTitle} sub={quote.title} crumb={quote.title} />
      <QuoteBuilder
        action={saveQuoteAction}
        quoteId={quote.id}
        clients={data.clients}
        sites={data.sites}
        initial={initial}
        labels={t.quotes}
        hoursLabels={hoursLabelsOf(t)}
        locale={locale}
        // the quote keeps the currency it was made in
        currency={quote.currency as Currency}
        submitLabel={quote.status === "sent" ? t.quotes.save : t.quotes.saveDraft}
        cancelHref={`/admin/quotes/${quote.id}`}
      />
    </div>
  );
}
