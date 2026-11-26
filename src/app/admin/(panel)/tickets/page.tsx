import Link from "next/link";
import { isStaff } from "@/lib/access";
import { requireTeam } from "@/lib/auth/guards";
import { getClientCached } from "@/lib/core/clients";
import { listLabels } from "@/lib/core/labels";
import { listTickets, parseTicketFilters, TICKETS_PER_PAGE } from "@/lib/core/ticket-list";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { ticketStatusBadge } from "@/lib/turn";
import { FilterSelect } from "@/components/filter-select";
import { Icon } from "@/components/icons";
import { Pager } from "@/components/pager";
import { LocalTime } from "@/components/local-time";
import { Segmented } from "@/components/shell-nav";
import { Badge, Card, EmptyState, inputClasses, LinkButton, PageHeader, cn } from "@/components/ui";
import { LabelChips, TicketRow, WorkList } from "@/components/work-list";

export const dynamic = "force-dynamic";

type Params = { status?: string; who?: string; client?: string; q?: string; unread?: string; label?: string; page?: string };
const KEYS = ["status", "who", "client", "q", "unread", "label", "page"] as const;

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireTeam();
  const [{ t, locale }, sp] = await Promise.all([getUserDict(), searchParams]);
  const filters = parseTicketFilters(sp);
  const rawPage = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  const page = Number.isSafeInteger(rawPage) && rawPage > 1 ? rawPage : 1;

  const [labels, first, clientFound] = await Promise.all([
    listLabels(),
    listTickets(me, filters, page),
    filters.clientId ? getClientCached(me, filters.clientId) : null,
  ]);
  // A page past the last one (a stale link, a typed number) shows the last page instead of an empty list.
  const lastPage = Math.max(1, Math.ceil(first.total / TICKETS_PER_PAGE));
  const { rows, total } = page > lastPage ? await listTickets(me, filters, lastPage) : first;
  const clientName = clientFound?.ok ? clientFound.value.name : null;

  // The current filters as they are in the URL (page excluded), with `patch` applied; undefined drops one.
  const current: Params = {
    status: filters.status,
    who: filters.who,
    client: filters.clientId,
    q: filters.q,
    unread: filters.unread ? "1" : undefined,
    label: filters.labelId,
  };
  const href = (patch: Params) => {
    const qs = new URLSearchParams();
    const next = { ...current, ...patch };
    for (const key of KEYS) if (next[key]) qs.set(key, next[key]!);
    return `/admin/tickets${qs.size ? `?${qs}` : ""}`;
  };
  const hidden = (except: keyof Params) =>
    KEYS.filter((key) => key !== except && key !== "page" && current[key]).map((key) => (
      <input key={key} type="hidden" name={key} value={current[key]} />
    ));

  const statusFilters = [
    { key: undefined, label: t.tickets.filterAll },
    { key: "open", label: t.tickets.filterOpen },
    { key: "closed", label: t.tickets.filterClosed },
  ];
  const whoFilters = [
    { key: undefined, label: t.common.all },
    { key: "mine", label: t.tickets.filterMine },
    { key: "unassigned", label: t.tickets.filterUnassigned },
  ];
  const pages = Math.max(1, Math.ceil(total / TICKETS_PER_PAGE));
  const shownPage = Math.min(page, pages);
  const filtered = Object.values(current).some(Boolean);

  return (
    <div>
      <PageHeader
        title={t.tickets.title}
        actions={
          <LinkButton href={filters.clientId && clientName ? `/admin/tickets/new?client=${filters.clientId}` : "/admin/tickets/new"}>
            <Icon name="plus" />
            {t.tickets.new}
          </LinkButton>
        }
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-5">
        <form action="/admin/tickets" method="get" role="search" className="relative w-full sm:w-64">
          {hidden("q")}
          <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ""}
            maxLength={100}
            aria-label={t.ui.search}
            placeholder={t.ui.searchPlaceholder}
            className={cn(inputClasses, "pl-8")}
          />
        </form>
        <Segmented
          label={t.common.status}
          items={statusFilters.map((f) => ({ href: href({ status: f.key }), label: f.label, active: filters.status === f.key }))}
        />
        <div className="flex items-center gap-2.5">
          {/* on phones the options speak for themselves and the row must fit */}
          <span className="text-muted max-sm:hidden">{t.tickets.assignees}</span>
          <Segmented
            label={t.tickets.assignees}
            items={whoFilters.map((f) => ({ href: href({ who: f.key }), label: f.label, active: filters.who === f.key }))}
          />
        </div>
        <Segmented
          label={t.tickets.filterUnread}
          items={[{ href: href({ unread: filters.unread ? undefined : "1" }), label: t.tickets.filterUnread, active: Boolean(filters.unread) }]}
        />
        {labels.length > 0 ? (
          <FilterSelect
            ariaLabel={t.tickets.filterLabel}
            value={filters.labelId ?? ""}
            options={[
              { value: "", label: t.tickets.allLabels, href: href({ label: undefined }) },
              ...labels.map((l) => ({ value: l.id, label: l.name, href: href({ label: l.id }) })),
            ]}
          />
        ) : isStaff(me.user) ? (
          <Link href="/admin/settings#labels-title" className="text-muted hover:text-ink underline-offset-[3px] hover:underline">
            {t.tickets.manageLabels}
          </Link>
        ) : null}
      </div>

      {clientName ? (
        <div className="flex items-center justify-between gap-3 mb-3">
          <span className="font-medium text-ink truncate">{fmt(t.tickets.clientFilter, { name: clientName })}</span>
          <Link href={href({ client: undefined })} className="inline-flex items-center gap-1 text-muted hover:text-ink whitespace-nowrap">
            <Icon name="x" size={14} />
            {t.tickets.clearClient}
          </Link>
        </div>
      ) : null}

      {filters.q ? (
        <div className="flex items-center justify-between gap-3 mb-3">
          <span className="font-medium text-ink truncate">{fmt(t.ui.searchResults, { q: filters.q })}</span>
          <Link href={href({ q: undefined })} className="inline-flex items-center gap-1 text-muted hover:text-ink whitespace-nowrap">
            <Icon name="x" size={14} />
            {t.ui.clearSearch}
          </Link>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <EmptyState title={filtered ? t.tickets.emptyFiltered : t.tickets.empty} icon={filters.q ? "search" : "inbox"} />
        </Card>
      ) : (
        <WorkList>
          {rows.map(({ ticket, site, client, assignees, unread, labels: ticketLabels }) => (
            <TicketRow
              key={ticket.id}
              href={`/admin/tickets/${ticket.id}`}
              unread={{ n: unread, label: unread === 1 ? t.tickets.unreadOne : fmt(t.tickets.unreadMany, { n: unread }) }}
              client={client.name}
              title={ticket.title}
              number={ticket.number}
              site={site?.name ?? t.tickets.generalLabel}
              support={ticket.type === "support" ? t.tickets.typeSupportLong : null}
              tags={
                <>
                  {ticket.isProject ? (
                    <Badge tone="lav" className="mr-1.5 flex-none">
                      {t.tickets.projectBadge}
                    </Badge>
                  ) : null}
                  <LabelChips labels={ticketLabels} max={2} />
                </>
              }
              assignees={assignees}
              noAssignees={t.tickets.noAssignees}
              when={<LocalTime iso={(ticket.lastMessageAt ?? ticket.createdAt).toISOString()} locale={locale} />}
              status={ticketStatusBadge(ticket.status, t)}
            />
          ))}
        </WorkList>
      )}

      <Pager
        page={shownPage}
        pages={pages}
        hrefOf={(n) => href({ page: n > 1 ? String(n) : undefined })}
        labels={{ nav: t.tickets.pagination, prev: t.tickets.pagePrev, next: t.tickets.pageNext, of: t.tickets.pageOf }}
      />
    </div>
  );
}
