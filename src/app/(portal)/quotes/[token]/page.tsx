import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/icons";
import { QuoteDocument } from "@/components/quote-document";
import { PageHeader } from "@/components/ui";
import { requirePortalAdmin } from "@/lib/auth/guards";
import { getPublicQuote, isQuoteForClient } from "@/lib/core/quote-public";
import { fmt } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import { approveQuoteAction } from "../../../q/[token]/actions";

export const dynamic = "force-dynamic";

/**
 * A proposal of the active company, inside the portal (its admins only): the same content as the
 * public link, with the portal's own frame. The approval is the public one, which lands back on the
 * link and comes here again.
 */
export default async function PortalQuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const [{ token }, sp, session] = await Promise.all([params, searchParams, requirePortalAdmin()]);
  const [quote, ours, { t, locale }] = await Promise.all([
    getPublicQuote(token),
    isQuoteForClient(token, session.client.id),
    getPortalDict(),
  ]);
  if (!quote || !ours) notFound();

  return (
    <div className="max-w-3xl">
      <Link href="/quotes" className="inline-flex items-center gap-1 mb-3 text-[0.875rem] text-muted hover:text-ink transition-colors">
        <Icon name="chevron" size={14} className="rotate-90" />
        {t.portal.backToQuotes}
      </Link>
      <PageHeader crumb={null} title={quote.title} sub={`${fmt(t.quotes.public.greeting, { name: quote.forName })} ${fmt(t.quotes.public.from, { agency: quote.agencyName })}`} />
      <QuoteDocument quote={quote} token={token} err={sp.err} t={t} locale={locale} approveAction={approveQuoteAction} />
    </div>
  );
}
