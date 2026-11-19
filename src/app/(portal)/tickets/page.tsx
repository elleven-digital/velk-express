import { getAgency } from "@/lib/agency";
import { requirePortal } from "@/lib/auth/guards";
import { listPortalTickets, portalNewTicketOptions, type PortalTicketRow } from "@/lib/core/portal-tickets";
import { fmt } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import { turnBadge } from "@/lib/turn";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { Callout, Card, EmptyState, LinkButton, PageHeader, SectionHead } from "@/components/ui";
import { PortalTicketRow as Row, WorkList } from "@/components/work-list";

export const dynamic = "force-dynamic";

/** The active company's tickets: the open ones first, the concluded ones under them. */
export default async function PortalTicketsPage() {
  const session = await requirePortal();
  const [rows, options, { t, locale }, agency] = await Promise.all([
    listPortalTickets(session),
    portalNewTicketOptions(session),
    getPortalDict(),
    getAgency(),
  ]);
  const open = rows.filter((r) => r.status === "open");
  const closed = rows.filter((r) => r.status === "closed");
  const p = t.portal;

  const row = (r: PortalTicketRow) => (
    <Row
      key={r.id}
      href={`/tickets/${r.id}`}
      title={r.title}
      number={r.number}
      site={r.siteName ?? t.tickets.generalLabel}
      when={<LocalTime iso={r.lastActivity.toISOString()} locale={locale} />}
      status={turnBadge(r.turn, "client", t)}
    />
  );

  return (
    <div>
      <PageHeader
        title={t.tickets.title}
        actions={
          options.canOpen ? (
            <LinkButton href="/tickets/new">
              <Icon name="plus" />
              {p.newTicket}
            </LinkButton>
          ) : undefined
        }
      />

      {!options.canOpen ? <Callout className="mb-6">{fmt(p.cantOpen, { agency: agency?.name ?? "" })}</Callout> : null}

      <section aria-labelledby="t-open">
        <SectionHead id="t-open" title={p.sectionOpen} count={open.length} />
        {open.length === 0 ? (
          <Card>
            <EmptyState icon="inbox" title={rows.length === 0 ? p.ticketsEmpty : p.noOpenTickets} />
          </Card>
        ) : (
          <WorkList>{open.map(row)}</WorkList>
        )}
      </section>

      {closed.length > 0 ? (
        <section aria-labelledby="t-closed" className="mt-10">
          <SectionHead id="t-closed" title={p.sectionClosed} count={closed.length} />
          <WorkList>{closed.map(row)}</WorkList>
        </section>
      ) : null}
    </div>
  );
}
