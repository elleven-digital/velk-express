import Link from "next/link";
import { getAgency } from "@/lib/agency";
import { requirePortal } from "@/lib/auth/guards";
import { portalNewTicketOptions } from "@/lib/core/portal-tickets";
import { fmt } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import { Icon } from "@/components/icons";
import { PortalTicketForm } from "@/components/ticket-new-form";
import { Callout, Card, PageHeader } from "@/components/ui";
import { openTicketAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Open a ticket. Without active support, or with no site in it and no general tickets, the page
 * says why instead of showing a form that could only be refused.
 */
export default async function PortalNewTicketPage() {
  const session = await requirePortal();
  const [options, { t }, agency] = await Promise.all([portalNewTicketOptions(session), getPortalDict(), getAgency()]);
  const p = t.portal;
  const agencyName = agency?.name ?? "";
  const nothingToPick = options.sites.length === 0 && !options.generalAllowed;

  return (
    <div className="max-w-2xl">
      <Link
        href="/tickets"
        className="inline-flex items-center gap-1 mb-3 text-[0.875rem] text-muted hover:text-ink transition-colors"
      >
        <Icon name="chevron" size={14} className="rotate-90" />
        {p.backToTickets}
      </Link>
      {!options.canOpen || nothingToPick ? (
        <>
          <PageHeader title={p.newTicket} crumb={null} />
          <Callout>{fmt(options.canOpen ? p.noSitesInSupport : p.cantOpen, { agency: agencyName })}</Callout>
        </>
      ) : (
        <>
          <PageHeader title={p.newTicket} sub={fmt(p.newTicketSub, { agency: agencyName })} crumb={null} />
          <Card className="p-5 sm:p-6">
            <PortalTicketForm
              action={openTicketAction}
              sites={options.sites}
              general={options.generalAllowed}
              labels={{
                placeholder: t.chat.placeholder,
                uploadError: t.chat.uploadError,
                bold: t.chat.bold,
                italic: t.chat.italic,
                list: t.chat.list,
                link: t.chat.link,
                image: t.chat.image,
                forSite: p.whichSite,
                generalOption: p.generalOption,
                titleField: t.tickets.titleField,
                firstMessage: p.describe,
                submit: t.tickets.createTicket,
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
        </>
      )}
    </div>
  );
}
