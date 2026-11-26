import { requirePortal } from "@/lib/auth/guards";
import { listPortalTickets, type PortalTicketRow } from "@/lib/core/portal-tickets";
import { fmt } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import { LocalTime } from "@/components/local-time";
import { Card, EmptyState, PageHeader, SectionHead } from "@/components/ui";
import { ProposalRow, WorkList } from "@/components/work-list";

export const dynamic = "force-dynamic";

/** The active company's projects: the ones in progress first, the completed ones under them. */
export default async function PortalProjectsPage() {
  const session = await requirePortal();
  const [rows, { t, locale }] = await Promise.all([listPortalTickets(session, undefined, { kind: "projects" }), getPortalDict()]);
  const p = t.portal;
  const ongoing = rows.filter((r) => r.status === "open");
  const done = rows
    .filter((r) => r.status === "closed")
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  // "Since {date}" / "Completed on {date}": the date is a client component, so the sentence is cut around it.
  const dated = (template: string, at: Date) => {
    const [before, after = ""] = template.split("{date}");
    return (
      <span key="d">
        {before}
        <LocalTime iso={at.toISOString()} locale={locale} />
        {after}
      </span>
    );
  };
  const row = (r: PortalTicketRow) => (
    <ProposalRow
      key={r.id}
      href={`/projects/${r.id}`}
      title={r.title}
      meta={[
        r.siteName,
        r.status === "closed" && r.closedAt ? dated(p.projectDoneOn, r.closedAt) : dated(p.projectStartedOn, r.createdAt),
      ].filter(Boolean)}
      unread={{ n: r.unread, label: r.unread === 1 ? t.tickets.unreadOne : fmt(t.tickets.unreadMany, { n: r.unread }) }}
      action={r.status === "open" ? p.projectFollow : p.projectView}
      primary={false}
    />
  );

  return (
    <div>
      <PageHeader title={p.projectsPageTitle} />

      <section aria-labelledby="pr-ongoing">
        <SectionHead id="pr-ongoing" title={p.projectsOngoing} count={ongoing.length} />
        {ongoing.length === 0 ? (
          <Card>
            <EmptyState icon="brief" title={p.projectsNoneOngoing} />
          </Card>
        ) : (
          <WorkList>{ongoing.map(row)}</WorkList>
        )}
      </section>

      {done.length > 0 ? (
        <section aria-labelledby="pr-done" className="mt-10">
          <SectionHead id="pr-done" title={p.projectsDone} count={done.length} />
          <WorkList>{done.map(row)}</WorkList>
        </section>
      ) : null}
    </div>
  );
}
