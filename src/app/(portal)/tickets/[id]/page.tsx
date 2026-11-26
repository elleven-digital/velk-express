import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMinutes, formatMoney } from "@/lib/format";
import type { Currency } from "@/lib/core/settings";
import { getAgency } from "@/lib/agency";
import { requirePortal } from "@/lib/auth/guards";
import { getPortalTicketView } from "@/lib/core/portal-tickets";
import { chatLabelsOf, fileLabelsOf } from "@/lib/chat-labels";
import { getPortalDict } from "@/lib/i18n/server";
import { TicketFiles } from "@/components/attachments";
import { ChatThread } from "@/components/chat";
import { ConversationLayout } from "@/components/conversation-layout";
import { fillNode } from "@/components/fill-node";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { MarkRead } from "@/components/mark-read";
import { Badge, buttonClasses, Card, PageHeader } from "@/components/ui";
import { attachFilesAction, deleteMessageAction, editMessageAction, markReadAction, removeFileAction, sendMessageAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The portal's ticket page: the title and the conversation in one white box, the files beside it. The company is the session's
 * own; another company's ticket (even of someone who belongs to both) is the portal's 404.
 * Nothing but ids, strings and booleans reaches the client components.
 */
export default async function PortalTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, requirePortal()]);
  const [{ t, locale }, agency] = await Promise.all([getPortalDict(), getAgency()]);
  const view = await getPortalTicketView(session, id, locale);
  if (!view) notFound();
  const { ticket } = view;
  const closed = ticket.status === "closed";
  const fileLabels = fileLabelsOf(t);
  const charge = view.charge;
  const chargeMoney = charge ? formatMoney(charge.amountCents, (charge.currency || agency?.currency || "BRL") as Currency, locale) : null;

  return (
    <>
      {/* from the browser, after the page is on screen: never while rendering or prefetching */}
      <MarkRead action={markReadAction.bind(null, ticket.id)} at={view.renderedAt} />
      <ConversationLayout
        box={
          <>
            <Link
              href={ticket.isProject ? "/projects" : "/tickets"}
              className="self-start inline-flex items-center gap-1 mb-3 text-[0.875rem] text-muted hover:text-ink transition-colors"
            >
              <Icon name="chevron" size={14} className="rotate-90" />
              {ticket.isProject ? t.portal.backToProjects : t.portal.backToTickets}
            </Link>
            <PageHeader
              actionsBeside
              crumb={null}
              title={ticket.title}
              actions={
                charge?.payPath ? (
                  <a href={charge.payPath} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "md")}>
                    {t.charges.payNow} · {chargeMoney}
                  </a>
                ) : undefined
              }
              meta={
                <>
                  {closed ? <Badge tone="muted">{t.tickets.statusClosed}</Badge> : null}
                  {charge?.status === "paid" ? (
                    <Badge tone="ok">
                      {t.charges.statusPaid} · {chargeMoney}
                    </Badge>
                  ) : null}
                  <span className="tabular">#{ticket.number}</span>
                  {view.siteName ?? t.tickets.generalLabel}
                  {view.timeLoggedMinutes !== null ? (
                    <span>
                      {t.portal.timeLogged}: <span className="tabular">{formatMinutes(view.timeLoggedMinutes)}</span>
                    </span>
                  ) : null}
                </>
              }
            />
            <ChatThread
              messages={view.messages}
              side="client"
              editorSide="portal"
              locale={locale}
              heightClass="flex-1"
              framed
              fill
              sendAction={sendMessageAction.bind(null, ticket.id)}
              editAction={editMessageAction.bind(null, ticket.id)}
              deleteAction={deleteMessageAction.bind(null, ticket.id)}
              labels={chatLabelsOf(t, agency?.name ?? t.chat.team)}
              closedNotice={
                !closed
                  ? null
                  : ticket.closedAt
                    ? fillNode(t.tickets.closedAt, {
                        date: <LocalTime iso={ticket.closedAt.toISOString()} locale={locale} />,
                      })
                    : t.tickets.statusClosed
              }
            />
          </>
        }
        // the ticket's files beside the conversation, as on the team's page
        side={
          <Card className="p-4" aria-labelledby="t-files">
            <h2 id="t-files" className="text-[0.8125rem] font-medium text-muted mb-2.5">
              {t.files.title}
              {view.files.length > 0 ? <span className="tabular"> · {view.files.length}</span> : null}
            </h2>
            <TicketFiles
              files={view.files}
              side="portal"
              locale={locale}
              disabled={closed}
              attachAction={attachFilesAction.bind(null, ticket.id)}
              removeAction={removeFileAction.bind(null, ticket.id)}
              labels={fileLabels}
            />
          </Card>
        }
      />
    </>
  );
}
