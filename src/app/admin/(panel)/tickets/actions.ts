"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isStaff } from "@/lib/access";
import { requireTeam } from "@/lib/auth/guards";
import { createTicket } from "@/lib/core/tickets";
import { parseFileIds } from "@/lib/attachments";
import { formValues } from "@/lib/form-values";
import { parseMoney } from "@/lib/format";
import { getUserDict } from "@/lib/i18n/server";
import type { TicketFormState } from "@/components/ticket-form-state";

/** Text fields the new-ticket form sends back with an error (the first message and the files stay in the page). */
const TICKET_KEYS = ["title", "clientId", "siteId", "type", "value", "isProject"] as const;

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

export async function createTicketAction(_prev: TicketFormState, formData: FormData): Promise<TicketFormState> {
  const actor = await requireTeam();
  const { t } = await getUserDict();
  const known = t.tickets.errors as Record<string, string>;
  const fail = (code: string): TicketFormState => ({
    error: known[code] ?? t.tickets.errors.generic,
    values: formValues(formData, TICKET_KEYS),
  });

  const type = text(formData, "type") === "support" ? "support" : "single";
  // Only owners and managers set the agreed value, and only a one-off job has one.
  let valueCents: number | null = null;
  const rawValue = text(formData, "value").trim();
  if (isStaff(actor.user) && type === "single" && rawValue) {
    valueCents = parseMoney(rawValue);
    if (valueCents === null) return fail("valueInvalid");
  }

  const res = await createTicket(actor, {
    clientId: text(formData, "clientId"),
    siteId: text(formData, "siteId"),
    type,
    title: text(formData, "title"),
    bodyHtml: text(formData, "body"),
    valueCents,
    isProject: formData.get("isProject") === "on",
    attachmentIds: parseFileIds(text(formData, "attachmentIds")),
  });
  if (!res.ok) return fail(res.error);
  revalidatePath("/admin/tickets");
  revalidatePath("/admin/projects");
  redirect(`/admin/tickets/${res.value.ticketId}`);
}
