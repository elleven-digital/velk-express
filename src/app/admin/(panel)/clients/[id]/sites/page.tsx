import { notFound } from "next/navigation";
import { Card, EmptyState, SectionTitle } from "@/components/ui";
import { isStaff } from "@/lib/access";
import { requireTeam } from "@/lib/auth/guards";
import { getClientCached, listSites } from "@/lib/core/clients";
import { getUserDict } from "@/lib/i18n/server";
import { addSiteAction, deleteSiteAction, updateSiteAction } from "../../actions";
import { AddSiteForm, SiteCard, SiteName } from "../../client-forms";

export const dynamic = "force-dynamic";

export default async function ClientSitesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireTeam();
  const [found, sitesRes, { t }] = await Promise.all([getClientCached(me, id), listSites(me, id), getUserDict()]);
  if (!found.ok || !sitesRes.ok) notFound();
  const client = found.value;
  const sites = sitesRes.value;

  const empty = (
    <Card>
      <EmptyState icon="link" title={t.clients.noSitesYet} />
    </Card>
  );

  if (!isStaff(me.user)) {
    // Collaborators read; the agency edits.
    return (
      <div className="max-w-2xl">
        {sites.length === 0 ? (
          empty
        ) : (
          <Card className="divide-y divide-line">
            {sites.map((site) => (
              <div key={site.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <SiteName site={site} />
                  {site.notes ? <p className="mt-0.5 text-muted">{site.notes}</p> : null}
                </div>
                {site.includedInSupport ? <span className="text-[0.875rem] text-muted">{t.clients.inPlan}</span> : null}
              </div>
            ))}
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        {sites.length === 0
          ? empty
          : sites.map((site) => (
              <SiteCard
                key={site.id}
                site={{ id: site.id, name: site.name, url: site.url, notes: site.notes, includedInSupport: site.includedInSupport }}
                clientId={client.id}
                supportActive={client.supportActive}
                labels={t.clients}
                actions={{ update: updateSiteAction, remove: deleteSiteAction }}
              />
            ))}
      </div>
      <Card className="p-5 lg:sticky lg:top-6">
        <SectionTitle className="mb-4">{t.clients.addSite}</SectionTitle>
        <AddSiteForm action={addSiteAction} labels={t.clients} clientId={client.id} supportActive={client.supportActive} />
      </Card>
    </div>
  );
}
