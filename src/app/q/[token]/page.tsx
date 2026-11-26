import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AgencyAvatar } from "@/components/agency-avatar";
import { LocaleSelect } from "@/components/locale-select";
import { Kicker } from "@/components/ui";
import { QuoteDocument } from "@/components/quote-document";
import { getAgency, logoPath } from "@/lib/agency";
import { getPortalSession } from "@/lib/auth/session";
import { getPublicQuote, isQuoteForClient } from "@/lib/core/quote-public";
import { fmt, isLocale } from "@/lib/i18n";
import { getPublicDict } from "@/lib/i18n/server";
import { approveQuoteAction, setQuoteLocaleAction } from "./actions";

export const dynamic = "force-dynamic";

// The link is the only protection: keep it out of search engines. The tab shows the agency's name.
export async function generateMetadata(): Promise<Metadata> {
  const agency = await getAgency();
  return { title: agency?.name ?? "Velk Express", robots: { index: false, follow: false } };
}

export default async function PublicQuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const [quote, session] = await Promise.all([getPublicQuote(token), getPortalSession()]);
  if (!quote) notFound();
  // A signed-in admin of the client sees the proposal inside the portal; everyone else gets this page.
  if (session?.role === "admin" && (await isQuoteForClient(token, session.client.id))) {
    redirect(`/quotes/${encodeURIComponent(token)}${sp.err ? `?err=${encodeURIComponent(sp.err)}` : ""}`);
  }
  const agency = await getAgency();
  // The visitor's cookie or browser language wins; without either, the agency's own language.
  const { t, locale } = await getPublicDict(isLocale(agency?.locale) ? agency.locale : undefined);



  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-line">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-2.5 min-w-0">
            <AgencyAvatar name={quote.agencyName} logoUrl={logoPath(agency?.logoFileId ?? null)} size={24} />
            <span className="font-medium text-ink truncate">{quote.agencyName}</span>
          </span>
          <form action={setQuoteLocaleAction} className="flex items-center">
            <input type="hidden" name="token" value={token} />
            <LocaleSelect value={locale} label={t.quotes.public.language} applyLabel={t.common.save} />
          </form>
        </div>
      </header>

      <main className="flex-1 px-4 pt-10 lg:pt-16 pb-16">
        <div className="mx-auto w-full max-w-2xl">
          <Kicker>{t.quotes.title}</Kicker>
          <h1 className="mt-1 text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.025em] text-ink break-words">
            {quote.title}
          </h1>
          <p className="text-muted text-[0.875rem] mt-2 mb-8">
            {fmt(t.quotes.public.greeting, { name: quote.forName })} {fmt(t.quotes.public.from, { agency: quote.agencyName })}
          </p>

          <QuoteDocument quote={quote} token={token} err={sp.err} t={t} locale={locale} approveAction={approveQuoteAction} />
        </div>
      </main>
    </div>
  );
}
