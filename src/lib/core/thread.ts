import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import { isPreviewImage } from "@/lib/attachments";
import type { TicketActor } from "@/lib/core/tickets";
import { db as appDb, messages, users, type Db, type Ticket, type UserRole } from "@/lib/db";
import { formatBytes } from "@/lib/format";
import { getDict, type Locale } from "@/lib/i18n";
import { canModifyMessage, isOwnMessage, viewerOf, type MessageViewer } from "@/lib/message-rules";
import { sanitizeMessageHtml } from "@/lib/sanitize";
import { listTicketFiles, type TicketFile } from "./attachments";
import { actorKey, resolveActorNames, type ActorRef } from "./messages";

/** The serializable shapes the conversation UI renders (server-side builders). */

export type FileItem = {
  id: string;
  name: string;
  mime: string;
  /** Formatted ("2.4 MB"). */
  size: string;
  url: string;
  /** An image the chat shows as a thumbnail. */
  preview: boolean;
  /** The message it was sent in; null for a general attachment. */
  messageId: string | null;
  byName: string;
  mine: boolean;
  /** When it was uploaded, as an ISO instant: the browser formats it in its own time zone. */
  at: string;
  /** General attachments only: the viewer may remove it. */
  canDelete: boolean;
};

export type ThreadMessage = {
  id: string;
  authorName: string;
  mine: boolean;
  fromAgency: boolean;
  /** Empty once deleted: a deleted body never leaves the server. */
  bodyHtml: string;
  /** ISO instant: the browser formats it in its own time zone. */
  createdAt: string;
  /** createdAt as epoch ms, to place other events in the thread. */
  at: number;
  replyTo: { id: string; authorName: string; excerpt: string; deleted: boolean } | null;
  edited: boolean;
  deleted: boolean;
  /** Team side only: who deleted it (or last edited it) and when (ISO instant). The portal gets null. */
  changedBy: { name: string; at: string } | null;
  canEdit: boolean;
  canDelete: boolean;
  /** Files sent with it, oldest first; none once deleted. */
  attachments: FileItem[];
};

const EXCERPT_MAX = 110;

function toFileItem(f: TicketFile, viewer: MessageViewer, locale: Locale, removed: string): FileItem {
  return {
    id: f.id,
    name: f.name,
    mime: f.mime,
    size: formatBytes(f.sizeBytes, locale),
    url: `/api/files/${f.id}`,
    preview: isPreviewImage(f.mime),
    messageId: f.messageId,
    byName: f.uploaderName || removed,
    mine: isOwnMessage(viewer, { authorType: f.uploadedByType, authorId: f.uploadedById }),
    at: f.createdAt.toISOString(),
    canDelete:
      f.messageId === null &&
      canModifyMessage(viewer, { authorType: f.uploadedByType, authorId: f.uploadedById, authorRole: f.uploaderRole }),
  };
}

/** Every file of the ticket the viewer can open, newest first (general ones and those of live messages). */
export async function loadTicketFiles(actor: TicketActor, ticket: Ticket, locale: Locale, db: Db = appDb): Promise<FileItem[]> {
  // A portal actor only ever reads their own company's ticket, whatever the caller passed.
  if (actor.userType === "client" && ticket.clientId !== actor.client.id) return [];
  const removed = (await getDict(locale)).common.removedUser;
  const viewer = viewerOf(actor);
  return (await listTicketFiles(ticket.id, db)).map((f) => toFileItem(f, viewer, locale, removed));
}

/**
 * The conversation for the chat UI. The caller already checked the actor may see the ticket.
 * A deleted message leaves as a tombstone: no body, no files, no quote, and quotes of it carry no text.
 */
export async function loadThread(actor: TicketActor, ticket: Ticket, locale: Locale, db: Db = appDb): Promise<ThreadMessage[]> {
  if (actor.userType === "client" && ticket.clientId !== actor.client.id) return [];
  const viewer = viewerOf(actor);
  const team = viewer.type === "agency";
  const removed = (await getDict(locale)).common.removedUser;
  const list = await db
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticket.id))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const byId = new Map(list.map((m) => [m.id, m]));

  const refs: ActorRef[] = [];
  for (const m of list) {
    refs.push({ type: m.authorType, id: m.authorId });
    if (team) {
      if (m.deletedAt && m.deletedByType && m.deletedById) refs.push({ type: m.deletedByType, id: m.deletedById });
      else if (m.editedByType && m.editedById) refs.push({ type: m.editedByType, id: m.editedById });
    }
  }
  const names = await resolveActorNames(refs, db);
  const nameOf = (ref: ActorRef) => names.get(actorKey(ref)) ?? removed;

  const agencyAuthors = [...new Set(list.filter((m) => m.authorType === "agency").map((m) => m.authorId))];
  const roles = new Map<string, UserRole>(
    agencyAuthors.length
      ? (await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, agencyAuthors))).map((u) => [u.id, u.role])
      : [],
  );

  // Files of deleted messages are already left out of the list.
  const filesByMessage = new Map<string, FileItem[]>();
  for (const f of (await listTicketFiles(ticket.id, db)).reverse()) {
    if (!f.messageId) continue;
    filesByMessage.set(f.messageId, [...(filesByMessage.get(f.messageId) ?? []), toFileItem(f, viewer, locale, removed)]);
  }

  return list.map((m) => {
    const deleted = m.deletedAt !== null;
    const quoted = m.replyToId ? byId.get(m.replyToId) : undefined;
    const allowed = canModifyMessage(viewer, {
      authorType: m.authorType,
      authorId: m.authorId,
      authorRole: roles.get(m.authorId) ?? null,
    });
    const changedAt = m.deletedAt ?? m.editedAt;
    const changer = deleted
      ? m.deletedByType && m.deletedById ? { type: m.deletedByType, id: m.deletedById } : null
      : m.editedByType && m.editedById ? { type: m.editedByType, id: m.editedById } : null;
    return {
      id: m.id,
      authorName: nameOf({ type: m.authorType, id: m.authorId }),
      mine: isOwnMessage(viewer, { authorType: m.authorType, authorId: m.authorId }),
      fromAgency: m.authorType === "agency",
      // Sanitized again on the way out, so every link opens safely, old messages too.
      bodyHtml: deleted ? "" : sanitizeMessageHtml(m.bodyHtml),
      createdAt: m.createdAt.toISOString(),
      at: m.createdAt.getTime(),
      replyTo:
        quoted && !deleted
          ? {
              id: quoted.id,
              authorName: nameOf({ type: quoted.authorType, id: quoted.authorId }),
              // A deleted message keeps nothing of what it said, not even in a quote.
              excerpt: quoted.deletedAt
                ? ""
                : quoted.bodyText.slice(0, EXCERPT_MAX) + (quoted.bodyText.length > EXCERPT_MAX ? "…" : ""),
              deleted: quoted.deletedAt !== null,
            }
          : null,
      edited: m.editedAt !== null,
      deleted,
      changedBy: team && changedAt ? { name: changer ? nameOf(changer) : removed, at: changedAt.toISOString() } : null,
      canEdit: allowed && !deleted,
      canDelete: allowed && !deleted,
      attachments: deleted ? [] : (filesByMessage.get(m.id) ?? []),
    };
  });
}
