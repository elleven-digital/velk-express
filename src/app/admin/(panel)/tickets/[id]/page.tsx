import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTeam } from "@/lib/auth/guards";
import { isStaff } from "@/lib/access";
import { ticketBilledOnQuote } from "@/lib/core/charges";
import { getTeamTicketView } from "@/lib/core/ticket-view";
import { formatCycle, formatDay, formatMinutes } from "@/lib/format";
import { chatLabelsOf, fileLabelsOf } from "@/lib/chat-labels";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { ticketStatusBadge } from "@/lib/turn";
import { TicketFiles } from "@/components/attachments";
import { ChargeSection } from "@/components/charge-section";
import { ChatThread } from "@/components/chat";
import { PageCrumb } from "@/components/crumbs";
import { fillNode } from "@/components/fill-node";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { MarkRead } from "@/components/mark-read";
import { StickyFill } from "@/components/sticky-fill";
import { ControlButton, ControlSelect } from "@/components/ticket-controls";
import { TicketLabels } from "@/components/ticket-labels";
import { TimeForm } from "@/components/time-form";
import { Avatar, Badge, Card, PageHeader, ProgressBar } from "@/components/ui";
import {
  addAssigneeAction,
  addLabelAction,
  addTimeAction,
  assumeAction,
  attachFilesAction,
  deleteMessageAction,
  deleteTimeAction,
  editMessageAction,
  markReadAction,
  removeAssigneeAction,
  removeFileAction,
  removeLabelAction,
  sendMessageAction,
  toggleStatusAction,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * The team's ticket page: the conversation on the left, the details and files on the right. It only
 * reads: the ticket is marked read by `MarkRead`, from the browser, once this is on screen. A ticket
 * outside the member's scope is the localized 404, as if it did not exist.
 */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, me] = await Promise.all([params, requireTeam()]);
  const { t, locale } = await getUserDict();
  const view = await getTeamTicketView(me, id, locale);
  if (!view) notFound();
  const { ticket, client, site } = view;
  const staff = isStaff(me.user);
  const closed = ticket.status === "closed";
  const status = ticketStatusBadge(ticket.status, t);

  const chatLabels = chatLabelsOf(t);

  const { hours, time } = view;
  const month = hours ? formatCycle(hours.cycle, locale) : "";
  const supportLine = client.supportActive
    ? client.hoursMode === "package"
      ? fmt(t.ui.supportLine, { hours: formatMinutes(client.includedMinutes) })
      : t.ui.supportLineNoHours
    : t.ui.noSupport;

  // A single ticket born from a quote that is being charged is billed there, not on its own.
  const billed = staff && ticket.type === "single" ? await ticketBilledOnQuote(me, ticket.id) : null;
  const billedOnQuote = billed?.ok ? billed.value : null;
  const [billedBefore, billedAfter] = t.charges.billedOnQuote.split("{title}");

  const detailHead = "text-[0.8125rem] font-medium text-muted mb-2.5";

  return (
    <div>
      <PageCrumb label={`#${ticket.number} ${ticket.title}`} />
      {/* from the browser, after the page is on screen: never while rendering or prefetching */}
      <MarkRead action={markReadAction.bind(null, ticket.id)} at={view.renderedAt} />
      <PageHeader
        crumb={null}
        title={ticket.title}
        meta={
          <>
            <Badge tone={status.tone}>{status.label}</Badge>
            <span className="tabular">#{ticket.number}</span>
            {ticket.type === "support" ? t.tickets.typeSupport : t.tickets.typeSingle}
            <Link href={`/admin/clients/${client.id}`} className="hover:text-ink hover:underline underline-offset-[3px]">
              {client.name}
            </Link>
            <span>
              {fillNode(t.tickets.openedByOn, {
                name: view.openerName,
                date: <LocalTime iso={ticket.createdAt.toISOString()} locale={locale} />,
              })}
            </span>
          </>
        }
        actions={
          <ControlButton
            action={toggleStatusAction.bind(null, ticket.id)}
            confirm={closed ? undefined : t.tickets.closeConfirm}
            size="md"
          >
            {closed ? null : <Icon name="check" />}
            {closed ? t.tickets.reopenTicket : t.tickets.closeTicket}
          </ControlButton>
        }
      />

      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-8 items-start">
        {/* desktop: the conversation sticks while the page (and the side column) scrolls */}
        <StickyFill
          mobileBottom={84}
          className="min-w-0 flex flex-col max-h-[calc(100dvh-22rem)] lg:sticky lg:top-6 lg:max-h-[calc(100dvh-13rem)]"
        >
          <ChatThread
            messages={view.messages}
            events={view.timeEvents.map((e) => ({ id: e.id, at: e.at, iso: e.iso, name: e.name, mine: e.mine, time: formatMinutes(e.minutes) }))}
            side="agency"
            editorSide="team"
            locale={locale}
            heightClass=""
            sendAction={sendMessageAction.bind(null, ticket.id)}
            editAction={editMessageAction.bind(null, ticket.id)}
            deleteAction={deleteMessageAction.bind(null, ticket.id)}
            labels={chatLabels}
            closedNotice={
              closed && ticket.closedAt
                ? fillNode(t.tickets.closedAt, { date: <LocalTime iso={ticket.closedAt.toISOString()} locale={locale} /> })
                : null
            }
          />
        </StickyFill>

        <div className="space-y-6 min-w-0">
          <Card className="divide-y divide-line">
            <h2 className="sr-only">{t.tickets.details}</h2>
            <section className="p-4" aria-labelledby="d-client">
              <h3 id="d-client" className={detailHead}>
                {t.tickets.forClient}
              </h3>
              <div className="flex items-center gap-2.5">
                <Avatar name={client.name} kind="client" size={28} />
                <span className="min-w-0">
                  <Link
                    href={`/admin/clients/${client.id}`}
                    className="block font-medium text-ink leading-tight truncate hover:underline underline-offset-[3px]"
                  >
                    {client.name}
                  </Link>
                  <span className="block text-[0.8125rem] text-muted">{site?.name ?? t.tickets.generalLabel}</span>
                  <span className="block text-[0.8125rem] text-muted">{supportLine}</span>
                </span>
              </div>
            </section>

            <section className="p-4" aria-labelledby="d-who">
              <h3 id="d-who" className={detailHead}>
                {t.tickets.assignees}
              </h3>
              {view.assignees.length === 0 ? (
                <p className="text-muted mb-3">{t.tickets.nobodyYet}</p>
              ) : (
                <ul className="space-y-2 mb-3">
                  {view.assignees.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2.5">
                      <Avatar name={a.name} size={28} />
                      <span className="flex-1 min-w-0 font-medium text-ink leading-tight truncate">
                        {a.name}
                        {a.id === me.user.id ? <span className="text-muted font-normal"> · {t.chat.you.toLowerCase()}</span> : null}
                      </span>
                      {staff ? (
                        <ControlButton
                          variant="ghost"
                          className="!px-0 w-8 text-muted hover:text-danger flex-none"
                          label={fmt(t.tickets.removeAssignee, { name: a.name })}
                          confirm={fmt(t.tickets.removeAssigneeConfirm, { name: a.name })}
                          action={removeAssigneeAction.bind(null, ticket.id, a.id)}
                        >
                          <Icon name="x" />
                        </ControlButton>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {view.canAssume ? (
                <div className="mb-2 flex flex-wrap">
                  <ControlButton className="w-full" action={assumeAction.bind(null, ticket.id)}>
                    <Icon name="userplus" />
                    {t.tickets.assume}
                  </ControlButton>
                </div>
              ) : null}
              {staff && view.assignable.length > 0 ? (
                <ControlSelect
                  action={addAssigneeAction.bind(null, ticket.id)}
                  name="userId"
                  placeholder={t.tickets.addAssignee}
                  label={t.tickets.addAssignee}
                  options={view.assignable.map((u) => ({ value: u.id, label: u.name }))}
                />
              ) : null}
            </section>

            <section className="p-4" aria-labelledby="d-labels">
              <div className="flex items-baseline justify-between gap-2 mb-2.5">
                <h3 id="d-labels" className="text-[0.8125rem] font-medium text-muted">
                  {t.tickets.labels}
                </h3>
                {staff ? (
                  <Link
                    href="/admin/settings#labels-title"
                    className="text-[0.8125rem] text-muted hover:text-ink hover:underline underline-offset-[3px]"
                  >
                    {t.tickets.manageLabels}
                  </Link>
                ) : null}
              </div>
              <TicketLabels
                applied={view.labels.map((l) => ({ id: l.id, name: l.name, color: l.color }))}
                all={view.allLabels.map((l) => ({ id: l.id, name: l.name, color: l.color }))}
                addAction={addLabelAction.bind(null, ticket.id)}
                removeAction={removeLabelAction.bind(null, ticket.id)}
                text={{ none: t.tickets.noLabels, noneYet: t.tickets.noLabelsYet, add: t.tickets.addLabel, remove: t.tickets.removeLabel }}
              />
            </section>

            {hours ? (
              <section className="p-4" aria-labelledby="d-hours">
                {hours.mode === "internal" ? (
                  <>
                    <h3 id="d-hours" className={detailHead}>
                      {fmt(t.ui.figHours, { month })}
                    </h3>
                    <b className="block text-[1.5rem] leading-tight font-semibold tracking-[-0.02em] text-ink tabular">
                      {formatMinutes(hours.usedMinutes)}
                    </b>
                    <p className="mt-0.5 text-[0.8125rem] text-muted">{t.ui.hoursTeamOnly}</p>
                  </>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <h3 id="d-hours" className="text-[0.8125rem] font-medium text-muted">
                        {t.ui.hoursBalance}
                      </h3>
                      <span className="text-[0.8125rem] text-muted tabular">
                        {fmt(t.ui.hoursIn, { total: formatMinutes(hours.totalMinutes), month })}
                      </span>
                    </div>
                    <b
                      className={`block mb-2.5 text-[1.5rem] leading-tight font-semibold tracking-[-0.02em] tabular ${
                        hours.balanceMinutes < 0 ? "text-danger" : "text-ink"
                      }`}
                    >
                      {formatMinutes(hours.balanceMinutes)}
                    </b>
                    <ProgressBar value={hours.usedMinutes} max={hours.totalMinutes} tone={hours.balanceMinutes < 0 ? "danger" : "brand"} />
                  </>
                )}
              </section>
            ) : null}

            {staff && ticket.type === "single" ? (
              <section className="p-4" aria-labelledby="d-charge">
                <h3 id="d-charge" className={detailHead}>
                  {t.charges.cardTitle}
                </h3>
                {billedOnQuote ? (
                  <p className="text-ink">
                    {billedOnQuote.quote ? (
                      <>
                        {billedBefore}
                        <Link href={`/admin/quotes/${billedOnQuote.quote.id}`} className="font-medium underline underline-offset-[3px]">
                          {billedOnQuote.quote.title}
                        </Link>
                        {billedAfter}
                      </>
                    ) : (
                      t.charges.billedOnQuoteManager
                    )}
                  </p>
                ) : (
                  <ChargeSection
                    me={me}
                    source="ticket"
                    sourceId={ticket.id}
                    clientId={client.id}
                    offer
                    editableValue
                    amountCents={view.valueCents}
                  />
                )}
              </section>
            ) : null}
          </Card>

          <Card className="p-4" aria-labelledby="d-time">
            <div className="flex items-baseline justify-between gap-2 mb-2.5">
              <h2 id="d-time" className="text-[0.8125rem] font-medium text-muted">
                {t.tickets.timeSpent}
              </h2>
              <b className="font-medium text-ink tabular">{time.totalMinutes > 0 ? formatMinutes(time.totalMinutes) : "—"}</b>
            </div>
            {time.entries.length === 0 ? (
              <p className="text-muted mb-3">{t.tickets.noTime}</p>
            ) : (
              <ul className="mb-3 divide-y divide-line">
                {time.entries.map((e) => (
                  <li key={e.id} className="flex items-start gap-2 py-2 first:pt-0">
                    <span className="min-w-0 flex-1">
                      <span className="block text-ink break-words">{e.note ?? "—"}</span>
                      <span className="block text-[0.8125rem] text-muted">
                        {formatDay(e.workedOn, locale)} · {e.mine ? t.chat.you : e.authorName}
                      </span>
                    </span>
                    <b className="font-medium text-ink tabular flex-none">{formatMinutes(e.minutes)}</b>
                    {e.mine || staff ? (
                      <ControlButton
                        variant="ghost"
                        className="!px-0 w-8 -my-1 text-muted hover:text-danger flex-none"
                        label={t.tickets.deleteTime}
                        confirm={t.tickets.deleteTimeConfirm}
                        action={deleteTimeAction.bind(null, ticket.id, e.id)}
                      >
                        <Icon name="x" />
                      </ControlButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <TimeForm
              action={addTimeAction.bind(null, ticket.id)}
              today={view.today}
              labels={{
                open: t.tickets.addTime,
                time: t.tickets.logTime,
                hint: t.tickets.logTimeHint,
                date: t.tickets.logDate,
                note: t.tickets.logNote,
                submit: t.tickets.logButton,
              }}
            />
          </Card>

          <Card className="p-4" aria-labelledby="d-files">
            <h2 id="d-files" className={detailHead}>
              {t.files.title}
              {view.files.length > 0 ? <span className="tabular"> · {view.files.length}</span> : null}
            </h2>
            <TicketFiles
              files={view.files}
              side="team"
              locale={locale}
              disabled={closed}
              attachAction={attachFilesAction.bind(null, ticket.id)}
              removeAction={removeFileAction.bind(null, ticket.id)}
              labels={fileLabelsOf(t)}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
