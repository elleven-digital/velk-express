"use server";

import { revalidatePath } from "next/cache";
import { parseFileIds } from "@/lib/attachments";
import { requirePortal } from "@/lib/auth/guards";
import { getPortalSession } from "@/lib/auth/session";
import { addTicketAttachments, deleteTicketAttachment } from "@/lib/core/attachments";
import { deleteMessage, editMessage, postMessage } from "@/lib/core/messages";
import { markPortalTicketRead, portalTicketUnread } from "@/lib/core/portal-tickets";
import type { Result } from "@/lib/core/result";
import { formValues } from "@/lib/form-values";
import { getPortalDict } from "@/lib/i18n/server";
import { unsentText } from "@/lib/unsent";
import type { MessageActionState } from "@/components/chat";

/*
 * The portal's ticket page actions, the counterparts of the team's. The ticket id is bound on the
 * page; the person and their company come from the portal session, and the core refuses any
 * ticket that is not the session company's (404 as far as the person can tell). Every action
 * answers with a translated error, never a thrown one.
 */

function refresh(ticketId: string) {
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/projects/${ticketId}`);
  revalidatePath("/tickets");
  revalidatePath("/projects");
  revalidatePath("/");
  revalidatePath(`/admin/tickets/${ticketId}`);
  revalidatePath(`/admin/projects/${ticketId}`);
  revalidatePath("/admin/tickets");
  revalidatePath("/admin/projects");
}

async function answer<T>(
  ticketId: string,
  run: () => Promise<Result<T>>,
  values?: Record<string, string>,
): Promise<MessageActionState> {
  const { t } = await getPortalDict();
  const known = t.tickets.errors as Record<string, string>;
  const res = await run();
  if (!res.ok) {
    // A plain validation refusal changes nothing; any other (closed, gone) means the page may be out of date.
    if (!["invalid", "required", "tooLong", "tooManyFiles"].includes(res.error)) refresh(ticketId);
    // "Reopen it first" is for the team: the client is only told it is closed.
    const message = res.error === "closed" ? t.portal.ticketClosedError : (known[res.error] ?? t.tickets.errors.generic);
    return { error: message, ...(values ? { values, unsent: unsentText(values) } : {}) };
  }
  refresh(ticketId);
  return { ok: true, nonce: Date.now() };
}

export async function sendMessageAction(ticketId: string, _prev: MessageActionState, formData: FormData): Promise<MessageActionState> {
  const session = await requirePortal();
  return answer(
    ticketId,
    () =>
      postMessage(session, ticketId, {
        bodyHtml: String(formData.get("body") ?? ""),
        replyToId: String(formData.get("replyToId") ?? "") || null,
        attachmentIds: parseFileIds(String(formData.get("attachmentIds") ?? "")),
      }),
    formValues(formData, ["body", "replyToId", "attachmentIds"]),
  );
}

export async function editMessageAction(ticketId: string, messageId: string, bodyHtml: string): Promise<MessageActionState> {
  const session = await requirePortal();
  return answer(ticketId, () => editMessage(session, ticketId, messageId, String(bodyHtml ?? "")));
}

export async function deleteMessageAction(ticketId: string, messageId: string): Promise<MessageActionState> {
  const session = await requirePortal();
  return answer(ticketId, () => deleteMessage(session, ticketId, messageId));
}

export async function attachFilesAction(ticketId: string, fileIds: string[]): Promise<MessageActionState> {
  const session = await requirePortal();
  const ids = Array.isArray(fileIds) ? fileIds.filter((id): id is string => typeof id === "string") : [];
  return answer(ticketId, () => addTicketAttachments(session, ticketId, ids));
}

export async function removeFileAction(ticketId: string, fileId: string): Promise<MessageActionState> {
  const session = await requirePortal();
  return answer(ticketId, () => deleteTicketAttachment(session, ticketId, String(fileId)));
}

/** Marks the ticket read up to when its page was rendered; the lists refresh only when that changed something. */
export async function markReadAction(ticketId: string, at: string): Promise<void> {
  const session = await getPortalSession();
  if (!session) return;
  const before = await portalTicketUnread(session, ticketId);
  const res = await markPortalTicketRead(session, ticketId, new Date(at));
  if (res.ok && before > 0) {
    revalidatePath("/");
    revalidatePath("/tickets");
    revalidatePath("/projects");
  }
}
