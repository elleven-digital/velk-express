import { QuoteBuilder } from "@/components/quote-builder";
import { PageHeader } from "@/components/ui";
import { getUserDict } from "@/lib/i18n/server";
import { saveQuoteAction } from "../actions";
import { hoursLabelsOf, loadBuilderData } from "../builder-data";
import { requireQuoteOwner } from "../guard";

export const dynamic = "force-dynamic";

export default async function NewQuotePage() {
  await requireQuoteOwner();
  const { t, locale } = await getUserDict();
  const data = await loadBuilderData();
  return (
    <div className="max-w-3xl">
      <PageHeader title={t.quotes.new} />
      <QuoteBuilder
        action={saveQuoteAction}
        clients={data.clients}
        sites={data.sites}
        labels={t.quotes}
        hoursLabels={hoursLabelsOf(t)}
        locale={locale}
        currency={data.currency}
        submitLabel={t.quotes.saveDraft}
        cancelHref="/admin/quotes"
      />
    </div>
  );
}
