import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { TeamSession } from "@/lib/auth/session";
import { db as appDb, files, messages, ticketReads, tickets, users, type Db, type UserRole } from "@/lib/db";
import { canModifyMessage, viewerOf } from "@/lib/message-rules";
import { inlineImageIds, MESSAGE_MAX_CHARS, messageBody } from "@/lib/sanitize";
import { getStorage, type Storage } from "@/lib/storage";
import { claimFiles } from "./attachments";
import { removeStoredObject } from "./file-cleanup";
import { fail, ok, type Result } from "./result";
import { Abort, transact } from "./tx";
import { findTicket, type TicketActor } from "./tickets";
import type { Uploader } from "./uploads";

/** Test seam: the database. */
type Deps = { db?: Db };
/** Deletions also remove stored objects, so they take a storage seam too. */
type DeleteDeps = Deps & { storage?: Storage };

const uuid = z.uuid();

/**
 * Ties the inline images of a sanitized body to the message when the author uploaded them and
 * nobody claimed them. Someone else's image, or one already used elsewhere, simply does not match.
 */
async function claimInlineImages(
  tx: Db,
  input: { ticketId: string; messageId: string; author: Uploader; bodyHtml: string },
): Promise<void> {
  const imageIds = inlineImageIds(input.bodyHtml);
  if (imageIds.length === 0) return;
  await tx
    .update(files)
    .set({ ticketId: input.ticketId, messageId: input.messageId })
    .where(
      and(
        inArray(files.id, imageIds),
        eq(files.inline, true),
        eq(files.uploadedByType, input.author.type),
        eq(files.uploadedById, input.author.id),
        isNull(files.ticketId),
        isNull(files.messageId),
      ),
    );
}

/**
 * Inserts a message, claims the inline images in its body that the author uploaded and nobody
 * claimed (they get the ticket and the message), and bumps `tickets.last_message_at`.
 * Runs inside the caller's transaction (`tx`); the body is already sanitized.
 */
export async function insertMessage(
  tx: Db,
  input: {
    ticketId: string;
    author: Uploader;
    body: { bodyHtml: string; bodyText: string };
    replyToId?: string | null;
  },
): Promise<string> {
  const [row] = await tx
    .insert(messages)
    .values({
      ticketId: input.ticketId,
      authorType: input.author.type,
      authorId: input.author.id,
      bodyHtml: input.body.bodyHtml,
      bodyText: input.body.bodyText,
      replyToId: input.replyToId ?? null,
    })
    .returning({ id: messages.id });
  await claimInlineImages(tx, { ticketId: input.ticketId, messageId: row.id, author: input.author, bodyHtml: input.body.bodyHtml });
  await tx.update(tickets).set({ lastMessageAt: sql`now()` }).where(eq(tickets.id, input.ticketId));
  return row.id;
}

const authorOf = (actor: TicketActor): Uploader => ({ type: actor.userType, id: actor.user.id });

/**
 * A message on a ticket, from either side. Closed tickets refuse it. The body may be empty only
 * when files go with it. A reply must quote a live message of the same ticket. The message and
 * the claim of its files are one transaction: a refused claim leaves no message behind.
 */
export async function postMessage(
  actor: TicketActor,
  ticketId: string,
  input: { bodyHtml: string; replyToId?: string | null; attachmentIds?: string[] },
  deps: Deps = {},
): Promise<Result<{ messageId: string }>> {
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  if (found.value.status === "closed") return fail("closed");

  const raw = input.bodyHtml ?? "";
  if (raw.length > MESSAGE_MAX_CHARS) return fail("tooLong");
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  const parsed = raw ? messageBody(raw) : null;
  if (!parsed && attachmentIds.length === 0) return fail("required");
  const body = parsed ?? { bodyHtml: "", bodyText: "" };

  const replyToId = input.replyToId || null;
  const author = authorOf(actor);

  return transact(db, async (tx) => {
    // Lock the ticket: a close that lands meanwhile is seen here, and posts to it serialize.
    const [locked] = await tx.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, found.value.id)).for("update");
    if (!locked) throw new Abort("notFound");
    if (locked.status === "closed") throw new Abort("closed");
    if (replyToId) {
      const live = uuid.safeParse(replyToId).success
        ? await tx
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.id, replyToId), eq(messages.ticketId, found.value.id), isNull(messages.deletedAt)))
        : [];
      if (live.length === 0) throw new Abort("notFound");
    }
    const messageId = await insertMessage(tx, { ticketId: found.value.id, author, body, replyToId });
    const claimed = await claimFiles(tx, { ticketId: found.value.id, messageId, uploader: author, fileIds: attachmentIds });
    if (!claimed.ok) throw new Abort(claimed.error);
    return { messageId };
  });
}

/** The ticket's message and the role its author has on the team now (null: client, or left). */
async function messageForChange(db: Db, ticketId: string, messageId: string) {
  if (!uuid.safeParse(messageId).success) return null;
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.ticketId, ticketId)));
  if (!message) return null;
  let authorRole: UserRole | null = null;
  if (message.authorType === "agency") {
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, message.authorId));
    authorRole = u?.role ?? null;
  }
  return { message, authorRole };
}

/**
 * Edits a message's body. Same rules as deleting; a deleted message cannot be edited; the same
 * body changes nothing. The text may be emptied only when files go with the message.
 */
export async function editMessage(
  actor: TicketActor,
  ticketId: string,
  messageId: string,
  bodyHtml: string,
  deps: Deps = {},
): Promise<Result<{ changed: boolean }>> {
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  const target = await messageForChange(db, found.value.id, messageId);
  if (!target) return fail("notFound");
  const { message, authorRole } = target;
  const allowed = canModifyMessage(viewerOf(actor), {
    authorType: message.authorType,
    authorId: message.authorId,
    authorRole,
  });
  if (!allowed) return fail("forbidden");
  if (message.deletedAt) return fail("messageDeleted");

  const raw = bodyHtml ?? "";
  if (raw.length > MESSAGE_MAX_CHARS) return fail("tooLong");
  const parsed = raw ? messageBody(raw) : null;

  return transact(db, async (tx) => {
    const [row] = await tx.select().from(messages).where(eq(messages.id, message.id)).for("update");
    if (!row) throw new Abort("notFound");
    if (row.deletedAt) throw new Abort("messageDeleted");
    let body = parsed;
    if (!body) {
      const [attached] = await tx
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.messageId, row.id), eq(files.inline, false)))
        .limit(1);
      if (!attached) throw new Abort("required");
      body = { bodyHtml: "", bodyText: "" };
    }
    if (body.bodyHtml === row.bodyHtml) return { changed: false };
    await tx
      .update(messages)
      .set({
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText,
        editedAt: sql`now()`,
        editedByType: actor.userType,
        editedById: actor.user.id,
      })
      .where(eq(messages.id, row.id));
    await claimInlineImages(tx, {
      ticketId: found.value.id,
      messageId: row.id,
      author: authorOf(actor),
      bodyHtml: body.bodyHtml,
    });
    return { changed: true };
  });
}

/**
 * Deletes a message (soft): the row stays as a tombstone, its body is no longer served, and its
 * files go for good: the rows in the same transaction, the stored objects after the commit (a
 * failed removal is only logged, since nothing points at the object any more). Deleting it again
 * changes nothing.
 */
export async function deleteMessage(
  actor: TicketActor,
  ticketId: string,
  messageId: string,
  deps: DeleteDeps = {},
): Promise<Result<{ changed: boolean }>> {
  const db = deps.db ?? appDb;
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  const target = await messageForChange(db, found.value.id, messageId);
  if (!target) return fail("notFound");
  const allowed = canModifyMessage(viewerOf(actor), {
    authorType: target.message.authorType,
    authorId: target.message.authorId,
    authorRole: target.authorRole,
  });
  if (!allowed) return fail("forbidden");
  // The condition makes two simultaneous deletions count once.
  const deleted = await transact(db, async (tx) => {
    const rows = await tx
      .update(messages)
      .set({ deletedAt: sql`now()`, deletedByType: actor.userType, deletedById: actor.user.id })
      .where(and(eq(messages.id, target.message.id), isNull(messages.deletedAt)))
      .returning({ id: messages.id });
    if (rows.length === 0) return null;
    const gone = await tx.delete(files).where(eq(files.messageId, target.message.id)).returning({ storageKey: files.storageKey });
    return gone.map((f) => f.storageKey);
  });
  if (!deleted.ok) return deleted;
  const storageKeys = deleted.value;
  if (storageKeys === null) return ok({ changed: false });
  // The deletion is already committed: nothing after it may turn it into a failure.
  try {
    const storage = deps.storage ?? getStorage();
    await Promise.all(storageKeys.map((key) => removeStoredObject(storage, key)));
  } catch (error) {
    console.error("Could not remove the files of a deleted message", error);
  }
  return ok({ changed: true });
}

/**
 * Marks the ticket read for a team member up to `at` (default: now; an Invalid Date is `invalid`). Never moves the mark back
 * and never past the database's now. Called from a client effect once the page is on screen,
 * never while rendering (a prefetch must not mark anything read).
 */
export async function markTicketRead(
  actor: TeamSession,
  ticketId: string,
  at?: Date,
  deps: Deps = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  // The mark comes from the browser: an unparseable date writes nothing, and a date outside what
  // the database can hold is clamped instead of failing the insert. The upper bound is the database's
  // own `now()` (below), never the app's clock: `renderedAt` comes from the database, and a second,
  // lagging clock would leave a recent message unread and re-trigger the page's revalidation.
  if (at && Number.isNaN(at.getTime())) return fail("invalid");
  const found = await findTicket(actor, ticketId, db);
  if (!found.ok) return found;
  const mark = at
    ? sql`least(${new Date(Math.min(Math.max(at.getTime(), 0), Date.now() + 86_400_000)).toISOString()}::timestamptz, now())`
    : sql`now()`;
  await db
    .insert(ticketReads)
    .values({ userId: actor.user.id, ticketId: found.value.id, lastReadAt: mark })
    .onConflictDoUpdate({
      target: [ticketReads.userId, ticketReads.ticketId],
      set: { lastReadAt: sql`greatest(${ticketReads.lastReadAt}, excluded.last_read_at)` },
    });
  return ok();
}

export type ActorRef = { type: "agency" | "client"; id: string };

/**
 * Names for polymorphic authors (messages, edits, deletions, ticket creators).
 *
 * CONTRACT: authors are stored as (`*_type` agency|client, id) with NO foreign key, so the row
 * must outlive a removed team member or portal person. Names are therefore always resolved with a
 * LEFT JOIN on `users` / `client_users` by type, never an INNER JOIN (which would drop the message
 * along with the person). A missing row maps to null, and the caller renders the localized
 * "removed user" label (`dict.common.removedUser`). Keys are `actorKey(ref)`.
 */
export const actorKey = (ref: ActorRef): string => `${ref.type}:${ref.id}`;

export async function resolveActorNames(refs: ActorRef[], db: Db): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  const unique = [...new Map(refs.map((r) => [actorKey(r), r])).values()];
  if (unique.length === 0) return names;
  const values = sql.join(unique.map((r) => sql`(${r.type}::text, ${r.id}::uuid)`), sql`, `);
  const rows = await db.execute<{ type: string; id: string; name: string | null }>(sql`
    select r.type, r.id, coalesce(u.name, c.name) as name
    from (values ${values}) as r(type, id)
    left join users u on r.type = 'agency' and u.id = r.id
    left join client_users c on r.type = 'client' and c.id = r.id`);
  for (const r of rows) names.set(actorKey({ type: r.type as ActorRef["type"], id: r.id }), r.name);
  return names;
}
