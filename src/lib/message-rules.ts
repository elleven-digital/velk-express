import type { TicketActor } from "@/lib/core/tickets";
import type { UserRole } from "@/lib/db";

/*
 * Who may edit or delete a ticket message, WhatsApp style. Pure, so the panel, the portal and
 * later the connector share it and tests cover it.
 *
 * - Everyone edits and deletes their own messages (team or client).
 * - On the agency side, owners also moderate any team member's message and managers moderate
 *   collaborators' messages (and those of people who left the team). Nobody on the agency side
 *   touches a client's message.
 * - A client only ever touches their own messages.
 * - A deleted message can't be edited; deleting it again changes nothing.
 */

export type MessageViewer = { type: "client"; id: string } | { type: "agency"; id: string; role: UserRole };

export type MessageAuthor = {
  authorType: "agency" | "client";
  authorId: string;
  /** Role of an agency author; null when they are no longer on the team. */
  authorRole?: UserRole | null;
};

export function isOwnMessage(viewer: MessageViewer, msg: MessageAuthor): boolean {
  return msg.authorType === viewer.type && msg.authorId === viewer.id;
}

/** May the viewer edit or delete this message (deleted or not)? */
export function canModifyMessage(viewer: MessageViewer, msg: MessageAuthor): boolean {
  if (isOwnMessage(viewer, msg)) return true;
  if (viewer.type !== "agency" || msg.authorType !== "agency") return false;
  if (viewer.role === "owner") return true;
  if (viewer.role === "manager") return (msg.authorRole ?? "collaborator") === "collaborator";
  return false;
}

/** May the viewer edit it now: allowed and not deleted. */
export function canEditMessage(viewer: MessageViewer, msg: MessageAuthor & { deletedAt: Date | null }): boolean {
  return msg.deletedAt === null && canModifyMessage(viewer, msg);
}

/** The viewer a session stands for. */
export function viewerOf(actor: TicketActor): MessageViewer {
  return actor.userType === "agency"
    ? { type: "agency", id: actor.user.id, role: actor.user.role }
    : { type: "client", id: actor.user.id };
}
