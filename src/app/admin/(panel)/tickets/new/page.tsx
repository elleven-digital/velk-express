import Link from "next/link";
import { asc, inArray } from "drizzle-orm";
import { isStaff } from "@/lib/access";
import { getAgency } from "@/lib/agency";
import { requireTeam } from "@/lib/auth/guards";
import { listClients } from "@/lib/core/clients";
import { db, sites } from "@/lib/db";
import { moneyPlaceholder } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { TicketNewForm } from "@/components/ticket-new-form";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { createTicketAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ client?: string | string[] }> }) {
  const me = await requireTeam();
  const [{ t, locale }, agency, sp] = await Promise.all([getUserDict(), getAgency(), searchParams]);
  // Only the clients this member may see; their sites in one query.
  const clientList = await listClients(me);
  const siteList = clientList.length
    ? await db
        .select({ id: sites.id, name: sites.name, clientId: sites.clientId })
        .from(sites)
        .where(inArray(sites.clientId, clientList.map((c) => c.id)))
        .orderBy(asc(sites.name), asc(sites.id))
    : [];
  const initialClientId = Array.isArray(sp.client) ? sp.client[0] : sp.client;

  return (
    <div className="max-w-2xl">
      <PageHeader title={t.tickets.new} />
      {clientList.length === 0 ? (
        <Card>
          <EmptyState
            title={t.tickets.noClients}
            action={
              <LinkButton href="/admin/clients" variant="secondary">
                {t.panel.navClients}
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <Card className="p-6 max-sm:p-4">
          <TicketNewForm
            action={createTicketAction}
            clients={clientList.map((c) => ({ id: c.id, name: c.name, supportActive: c.supportActive }))}
            sites={siteList}
            initialClientId={initialClientId}
            canSetValue={isStaff(me.user)}
            labels={{
              placeholder: t.chat.placeholder,
              uploadError: t.chat.uploadError,
              bold: t.chat.bold,
              italic: t.chat.italic,
              list: t.chat.list,
              link: t.chat.link,
              image: t.chat.image,
              forClient: t.tickets.forClient,
              forSite: t.tickets.forSite,
              typeField: t.tickets.typeField,
              typeSingleLong: t.tickets.typeSingleLong,
              typeSupportLong: t.tickets.typeSupportLong,
              titleField: t.tickets.titleField,
              valueField: fmt(t.tickets.valueField, { currency: agency?.currency ?? "BRL" }),
              valuePlaceholder: moneyPlaceholder(locale),
              valueHint: t.tickets.valueHint,
              projectToggle: t.tickets.projectToggle,
              projectHint: t.tickets.projectHint,
              firstMessage: t.tickets.firstMessage,
              submit: t.tickets.createTicket,
              supportNeedsPlan: t.tickets.supportNeedsPlan,
              noSiteOption: t.tickets.noSiteOption,
              attachments: t.tickets.attachments,
              attach: t.tickets.attachFiles,
              uploading: t.tickets.uploading,
              remove: t.tickets.removeFile,
              uploadFailed: t.tickets.uploadFailed,
              fileType: t.tickets.fileType,
              fileTooLarge: t.tickets.fileTooLarge,
              uploadUnavailable: t.tickets.uploadUnavailable,
              tooManyFiles: t.tickets.tooManyFiles,
              uploadLimit: t.tickets.uploadLimit,
            }}
          />
        </Card>
      )}
      <p className="mt-4">
        <Link href="/admin/tickets" className="text-muted hover:text-ink underline-offset-[3px] hover:underline">
          {t.common.back}
        </Link>
      </p>
    </div>
  );
}
