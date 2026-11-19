import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { ATTACHMENTS_PER_BATCH } from "@/lib/attachments";
import { db as appDb, files, messages, tickets, users, type Db, type UserRole } from "@/lib/db";
import { canModifyMessage, viewerOf } from "@/lib/message-rules";
import { getStorage, type Storage } from "@/lib/storage";
import { removeStoredObject } from "./file-cleanup";
import { actorKey, resolveActorNames } from "./messages";
import { fail, ok, type Result } from "./result";
import { Abort, transact } from "./tx";
import { findTicket, type TicketActor } from "./tickets";
import type { Uploader } from "./uploads";

/**
 * Ticket attachments. A file is uploaded first (`/api/upload`, owned by whoever sent it, tied to
 * nothing) and then claimed by a message when it is sent. Only its uploader can claim it, once.
 * A deleted message's attachments disappear with it, for everyone.
 */

const uuid = z.uuid();

/** Test seam: the database. */
type Deps = { db?: Db };

/**
 * Ties the uploader's unclaimed, non-inline files to a ticket (and a message). All or nothing:
 * an id that isn't theirs, is already used or is an inline image makes the whole set `notFound`;
 * more than one batch is `tooManyFiles`. The caller rolls the transaction back on a refusal.
 */
export async function claimFiles(
  tx: Db,
  input: { ticketId: string; messageId: string | null; uploader: Uploader; fileIds: string[] },
): Promise<Result<{ count: number }>> {
  const ids = [...new Set(input.fileIds)];
  if (ids.length === 0) return ok({ count: 0 });
  if (ids.length > ATTACHMENTS_PER_BATCH) return fail("tooManyFiles");
  if (!ids.every((id) => uuid.safeParse(id).success)) return fail("notFound");
  const claimed = await tx
    .update(files)
    .set({ ticketId: input.ticketId, messageId: input.messageId })
    .where(
      and(
        inArray(files.id, ids),
        eq(files.inline, false),
        isNull(files.ticketId),
        isNull(files.messageId),
        eq(files.uploadedByType, input.uploader.type),
        eq(files.uploadedById, input.uploader.id),
      ),
    )
    .returning({ id: files.id });
  if (claimed.length !== ids.length) return fail("notFound");
  return ok({ count: claimed.length });
}

export type TicketFile = {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  /** The message it was sent in; null for a general attachment. */
  messageId: string | null;
  uploadedByType: "agency" | "client";
  uploadedById: string;
  /** Empty when the uploader is gone: the caller renders the "removed user" label. */
  uploaderName: string;
  /** Uploader's role on the team (null: client, or left the team). */
  uploaderRole: UserRole | null;
  createdAt: Date;
};

/** Non-inline files of the ticket people can still see: general ones and those of live messages, newest first. */
export async function listTicketFiles(ticketId: string, db: Db = appDb): Promise<TicketFile[]> {
  const rows = await db
    .select({ file: files, messageDeletedAt: messages.deletedAt })
    .from(files)
    .leftJoin(messages, eq(files.messageId, messages.id))
    .where(and(eq(files.ticketId, ticketId), eq(files.inline, false)))
    .orderBy(desc(files.createdAt), desc(files.id));
  const live = rows.filter((r) => r.messageDeletedAt === null).map((r) => r.file);
  if (live.length === 0) return [];

  const names = await resolveActorNames(
    live.map((f) => ({ type: f.uploadedByType, id: f.uploadedById })),
    db,
  );
  const teamIds = [...new Set(live.filter((f) => f.uploadedByType === "agency").map((f) => f.uploadedById))];
  const roles = new Map<string, UserRole>(
    teamIds.length
      ? (await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, teamIds))).map((u) => [
          u.id,
          u.role,
        ])
      : [],
  );
  return live.map((f) => ({
    id: f.id,
    name: f.name,
    mime: f.mime,
    sizeBytes: f.sizeBytes,
    messageId: f.messageId,
    uploadedByType: f.uploadedByType,
    uploadedById: f.uploadedById,
    uploaderName: names.get(actorKey({ type: f.uploadedByType, id: f.uploadedById })) ?? "",
    uploaderRole: f.uploadedByType === "agency" ? (roles.get(f.uploadedById) ?? null) : null,
    createdAt: f.createdAt,
  }));
}

/**
 * General attachments: files tied to the ticket itself, not to a message. The actor claims files
 * they uploaded and nobody used; all or nothing. A closed ticket takes no new files, like messages.
 */
export async function addTicketAttachments(
  actor: TicketActor,
  ticketId: string,
  fileIds: string[],
  deps: Deps = {},
): Promise<Result<{ count: number }>> {
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  const ids = [...new Set(fileIds ?? [])];
  if (ids.length === 0) return fail("required");
  return transact(db, async (tx) => {
    // Lock the ticket: a close that lands meanwhile is seen here.
    const [locked] = await tx.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, found.value.id)).for("update");
    if (!locked) throw new Abort("notFound");
    if (locked.status === "closed") throw new Abort("closed");
    const claimed = await claimFiles(tx, {
      ticketId: found.value.id,
      messageId: null,
      uploader: { type: actor.userType, id: actor.user.id },
      fileIds: ids,
    });
    if (!claimed.ok) throw new Abort(claimed.error);
    return claimed.value;
  });
}

/**
 * Removes a general attachment (a message's files go with the message). Same rules as deleting a
 * message, applied to whoever uploaded it. The row goes first, then the stored object.
 */
export async function deleteTicketAttachment(
  actor: TicketActor,
  ticketId: string,
  fileId: string,
  deps: Deps & { storage?: Storage } = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  if (!uuid.safeParse(fileId).success) return fail("notFound");
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.ticketId, found.value.id), isNull(files.messageId), eq(files.inline, false)));
  if (!file) return fail("notFound");

  let role: UserRole | null = null;
  if (file.uploadedByType === "agency") {
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, file.uploadedById));
    role = u?.role ?? null;
  }
  const allowed = canModifyMessage(viewerOf(actor), {
    authorType: file.uploadedByType,
    authorId: file.uploadedById,
    authorRole: role,
  });
  if (!allowed) return fail("forbidden");

  // The conditions make two simultaneous removals count once.
  const [gone] = await db
    .delete(files)
    .where(and(eq(files.id, file.id), isNull(files.messageId), eq(files.inline, false)))
    .returning({ storageKey: files.storageKey });
  if (!gone) return fail("notFound");
  await removeStoredObject(deps.storage ?? getStorage(), gone.storageKey);
  return ok();
}
