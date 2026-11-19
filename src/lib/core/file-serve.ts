import "server-only";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { canAccessTicket, isStaff } from "@/lib/access";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { contentDisposition, opensInline } from "@/lib/attachments";
import { db as appDb, agency, charges, files, messages, tickets, type Db, type FileRow } from "@/lib/db";
import { inlineImageIds } from "@/lib/sanitize";
import { getStorage, type Storage } from "@/lib/storage";

/*
 * Serves a stored file by id. Contract for everything that widens this later:
 *
 * - The agency logo is public. Every other file is decided by `canReadFile`, from the FILE's own
 *   ticket (never from a message that happens to link to it); a refusal is always a plain 404,
 *   so the route never confirms that a file exists.
 * - A file of a soft-deleted message is 404 for everyone, its uploader included.
 * - When a `files` row is removed, its blob is removed from storage too
 *   (deleting the row alone leaves an orphan the app can no longer reach).
 */

export type FileViewers = { team: TeamSession | null; portal: PortalSession | null };

const uuid = z.uuid();

const notFound = () => new Response("Not found", { status: 404 });

/**
 * May either session open this (non-logo) file?
 *
 * - A charge's fiscal document: staff, or an admin of the portal company the charge is for (the
 *   session's company). Nobody else, however they got the id.
 * - No ticket yet (an upload waiting to be sent): only whoever uploaded it, on the same side.
 * - Of a deleted message: nobody.
 * - An inline image: only while the live message body still shows it (an edit that drops the
 *   image stops serving it).
 * - Of a ticket: the team session when `canAccessTicket`, or the portal session of the ticket's company.
 */
export async function canReadFile(viewers: FileViewers, file: FileRow, db: Db = appDb): Promise<boolean> {
  if (!file.ticketId) {
    const { team, portal } = viewers;
    const [charge] = await db.select({ clientId: charges.clientId }).from(charges).where(eq(charges.documentFileId, file.id)).limit(1);
    if (charge) {
      if (team && isStaff(team.user)) return true;
      return !!portal && portal.role === "admin" && charge.clientId !== null && portal.client.id === charge.clientId;
    }
    if (file.uploadedByType === "agency") return !!team && team.user.id === file.uploadedById;
    return !!portal && portal.user.id === file.uploadedById;
  }
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, file.ticketId));
  if (!ticket) return false;

  if (file.messageId) {
    const [message] = await db
      .select({ deletedAt: messages.deletedAt, bodyHtml: messages.bodyHtml, ticketId: messages.ticketId })
      .from(messages)
      .where(eq(messages.id, file.messageId));
    if (!message || message.deletedAt || message.ticketId !== ticket.id) return false;
    if (file.inline && !inlineImageIds(message.bodyHtml).includes(file.id)) return false;
  } else if (file.inline) {
    return false;
  }

  const { team, portal } = viewers;
  if (portal && ticket.clientId === portal.client.id) return true;
  return !!team && (await canAccessTicket(team, ticket, db));
}

export async function serveFile(
  id: string,
  opts: { download: boolean; viewers: FileViewers },
  deps: { db?: Db; storage?: Storage } = {},
): Promise<Response> {
  if (!uuid.safeParse(id).success) return notFound();
  const db = deps.db ?? appDb;

  const [file] = await db.select().from(files).where(eq(files.id, id));
  if (!file) return notFound();
  const [brand] = await db.select({ logoFileId: agency.logoFileId }).from(agency).limit(1);
  const isLogo = !!brand && brand.logoFileId === id;
  if (!isLogo && !(await canReadFile(opts.viewers, file, db))) return notFound();

  const object = await (deps.storage ?? getStorage()).get(file.storageKey);
  if (!object) return notFound();

  const headers: Record<string, string> = {
    "Content-Type": file.mime,
    "Content-Length": String(file.sizeBytes),
    "X-Content-Type-Options": "nosniff",
  };
  if (isLogo) {
    headers["Content-Disposition"] = "inline";
    headers["Cache-Control"] = "public, max-age=300";
  } else {
    headers["Content-Disposition"] = contentDisposition(file.name, !opts.download && opensInline(file.mime));
    headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
    // Checked on every open, so a deleted message's file stops opening.
    headers["Cache-Control"] = "private, no-cache";
  }
  return new Response(Readable.toWeb(object.stream) as ReadableStream, { headers });
}
