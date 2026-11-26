"use server";

import { revalidatePath } from "next/cache";
import { getTeamSession } from "@/lib/auth/session";
import { requireTeam } from "@/lib/auth/guards";
import { parseFileIds } from "@/lib/attachments";
import { addTicketAttachments, deleteTicketAttachment } from "@/lib/core/attachments";
import { addTicketLabel, removeTicketLabel } from "@/lib/core/labels";
import { addTimeEntry, deleteTimeEntry } from "@/lib/core/hours";
import { deleteMessage, editMessage, markTicketRead, postMessage } from "@/lib/core/messages";
import { ticketUnread } from "@/lib/core/ticket-view";
import { addTicketAssignee, assumeTicket, findTicket, removeTicketAssignee, setTicketProject, setTicketStatus } from "@/lib/core/tickets";
import type { Result } from "@/lib/core/result";
import { formValues } from "@/lib/form-values";
import { getUserDict } from "@/lib/i18n/server";
import { unsentText } from "@/lib/unsent";
import type { MessageActionState } from "@/components/chat";

/*
 * The team's ticket page actions. The ticket id is bound on the page (`.bind(null, id)`). Each
 * action takes the viewer from the session, goes through the cores (which decide visibility) and
 * answers with a translated error, never a thrown one. A success revalidates the team page and the
 * portal page of the same ticket.
 */

function refresh(ticketId: string) {
  revalidatePath(`/admin/tickets/${ticketId}`);
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/admin/tickets");
}

/** Runs a core call and shapes its Result for the UI. `values` ride back with an error. */
async function answer<T>(
  ticketId: string,
  run: () => Promise<Result<T>>,
  values?: Record<string, string>,
): Promise<MessageActionState> {
  const { t } = await getUserDict();
  const known = t.tickets.errors as Record<string, string>;
  const res = await run();
  if (!res.ok) {
    // A plain validation refusal changes nothing; any other (closed, gone, forbidden) means the page may be out of date.
    if (!["invalid", "required", "tooLong", "tooManyFiles", "invalidDuration", "invalidDate", "futureDate"].includes(res.error)) refresh(ticketId);
    return { error: known[res.error] ?? t.tickets.errors.generic, ...(values ? { values, unsent: unsentText(values) } : {}) };
  }
  refresh(ticketId);
  return { ok: true, nonce: Date.now() };
}

export async function sendMessageAction(ticketId: string, _prev: MessageActionState, formData: FormData): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(
    ticketId,
    () =>
      postMessage(actor, ticketId, {
        bodyHtml: String(formData.get("body") ?? ""),
        replyToId: String(formData.get("replyToId") ?? "") || null,
        attachmentIds: parseFileIds(String(formData.get("attachmentIds") ?? "")),
      }),
    formValues(formData, ["body", "replyToId", "attachmentIds"]),
  );
}

export async function editMessageAction(ticketId: string, messageId: string, bodyHtml: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => editMessage(actor, ticketId, messageId, String(bodyHtml ?? "")));
}

export async function deleteMessageAction(ticketId: string, messageId: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => deleteMessage(actor, ticketId, messageId));
}

export async function attachFilesAction(ticketId: string, fileIds: string[]): Promise<MessageActionState> {
  const actor = await requireTeam();
  const ids = Array.isArray(fileIds) ? fileIds.filter((id): id is string => typeof id === "string") : [];
  return answer(ticketId, () => addTicketAttachments(actor, ticketId, ids));
}

export async function removeFileAction(ticketId: string, fileId: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => deleteTicketAttachment(actor, ticketId, String(fileId)));
}

/** Logs time on the ticket. Fields: duration ("1h30"), workedOn (a day), note. */
export async function addTimeAction(ticketId: string, _prev: MessageActionState, formData: FormData): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(
    ticketId,
    () =>
      addTimeEntry(actor, ticketId, {
        duration: String(formData.get("duration") ?? ""),
        workedOn: String(formData.get("workedOn") ?? ""),
        note: String(formData.get("note") ?? ""),
      }),
    formValues(formData, ["duration", "workedOn", "note"]),
  );
}

/** Removes a time entry: its author or staff (the core decides). */
export async function deleteTimeAction(ticketId: string, entryId: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => deleteTimeEntry(actor, ticketId, String(entryId)));
}

/** Closes an open ticket and reopens a closed one. */
export async function toggleStatusAction(ticketId: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, async () => {
    const found = await findTicket(actor, ticketId);
    if (!found.ok) return found;
    return setTicketStatus(actor, ticketId, found.value.status === "open" ? "closed" : "open");
  });
}

export async function toggleProjectAction(ticketId: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, async () => {
    const found = await findTicket(actor, ticketId);
    if (!found.ok) return found;
    return setTicketProject(actor, ticketId, !found.value.isProject);
  });
}

export async function assumeAction(ticketId: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => assumeTicket(actor, ticketId));
}

export async function addAssigneeAction(ticketId: string, formData: FormData): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => addTicketAssignee(actor, ticketId, String(formData.get("userId") ?? "")));
}

export async function removeAssigneeAction(ticketId: string, userId: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => removeTicketAssignee(actor, ticketId, String(userId)));
}

export async function addLabelAction(ticketId: string, formData: FormData): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => addTicketLabel(actor, ticketId, String(formData.get("labelId") ?? "")));
}

export async function removeLabelAction(ticketId: string, labelId: string): Promise<MessageActionState> {
  const actor = await requireTeam();
  return answer(ticketId, () => removeTicketLabel(actor, ticketId, String(labelId)));
}

/**
 * Called by `MarkRead` once the page is on screen. Quiet on any refusal (no session, a ticket
 * outside the scope, an Invalid Date: the core writes nothing for those) and never redirects.
 *
 * When there was something unread, the team list is revalidated so its unread mark is gone when the
 * person goes back to it (otherwise the browser shows the list it cached). Revalidating also
 * re-renders this page, whose new render marks again: that second mark finds nothing unread and
 * does not revalidate, which is what stops the cycle.
 */
export async function markReadAction(ticketId: string, at: string): Promise<void> {
  const actor = await getTeamSession();
  if (!actor) return;
  const before = await ticketUnread(actor, ticketId);
  const res = await markTicketRead(actor, ticketId, new Date(at));
  if (res.ok && before > 0) revalidatePath("/admin/tickets");
}
