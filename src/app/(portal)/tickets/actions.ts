"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getAgency } from "@/lib/agency";
import { requirePortal } from "@/lib/auth/guards";
import { notifyTicketOpened } from "@/lib/core/ticket-notices";
import { openPortalTicket } from "@/lib/core/tickets";
import { parseFileIds } from "@/lib/attachments";
import { formValues } from "@/lib/form-values";
import { fmt } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import type { TicketFormState } from "@/components/ticket-form-state";

/** Text fields the form sends back with an error (the description stays in the page). */
const TICKET_KEYS = ["title", "siteId"] as const;

/**
 * Opens a support ticket for the session's own company: the company is never a form field, so a
 * forged one changes nothing. On success the person lands on the new ticket.
 */
export async function openTicketAction(_prev: TicketFormState, formData: FormData): Promise<TicketFormState> {
  const session = await requirePortal();
  const [{ t }, agency] = await Promise.all([getPortalDict(), getAgency()]);
  const res = await openPortalTicket(session, {
    siteId: String(formData.get("siteId") ?? ""),
    title: String(formData.get("title") ?? ""),
    bodyHtml: String(formData.get("body") ?? ""),
    attachmentIds: parseFileIds(String(formData.get("attachmentIds") ?? "")),
  });
  if (!res.ok) {
    const known = t.tickets.errors as Record<string, string>;
    const message = known[res.error] ?? t.tickets.errors.generic;
    return { error: fmt(message, { agency: agency?.name ?? "" }), values: formValues(formData, TICKET_KEYS) };
  }
  // After the response and outside the transaction, which already committed: a mail failure never touches the ticket.
  const ticketId = res.value.ticketId;
  after(() => notifyTicketOpened(ticketId));
  revalidatePath("/tickets");
  revalidatePath("/");
  revalidatePath("/admin/tickets");
  revalidatePath("/admin/projects");
  redirect(`/tickets/${res.value.ticketId}`);
}
