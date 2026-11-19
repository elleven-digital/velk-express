import "server-only";
import { Readable } from "node:stream";
import {
  ATTACHMENT_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  documentMime,
  INLINE_IMAGE_MAX_BYTES,
  attachmentMime,
  attachmentName,
  inlineImageMime,
} from "@/lib/attachments";
import { and, eq, gte, isNull, like, sql } from "drizzle-orm";
import { agency, db as appDb, files, type Db } from "@/lib/db";
import { getStorage, newFileKey, TooLargeError, type Storage } from "@/lib/storage";

/** Streams an uploaded file to storage and records it. The caller has already worked out who is uploading. */

/** `staff` (owner or manager) is set by the team side only; a fiscal document needs it. */
export type Uploader = { type: "agency" | "client"; id: string; staff?: boolean };
export type Uploaded = { id: string; url: string; name: string; mime: string; size: number };
export type UploadResult =
  | { status: 200; body: Uploaded }
  | { status: 400 | 401 | 413 | 415 | 429 | 503; body: { error: string } };

const refuse = (status: 400 | 401 | 413 | 415 | 429 | 503, error: string): UploadResult => ({ status, body: { error } });

const MAX_NAME_HEADER = 1024;

/** What one person may hold unclaimed (uploaded, not yet attached to a ticket or message) over the last 24 hours. */
export const UNCLAIMED_MAX_FILES = 40;
export const UNCLAIMED_MAX_BYTES = 300 * 1024 * 1024;
const UNCLAIMED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True when the person already holds the limit of unclaimed uploads. Counts the same rows the orphan sweep would
 * collect (`attachments/` keys with no ticket and no message, not the agency logo); fiscal documents live under
 * `documents/` and are not counted. Checked before streaming, so two racing uploads can exceed the limit by a few.
 */
export async function unclaimedLimitReached(db: Db, uploader: Uploader, now: number = Date.now()): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::float8`,
    })
    .from(files)
    .where(
      and(
        eq(files.uploadedByType, uploader.type),
        eq(files.uploadedById, uploader.id),
        like(files.storageKey, "attachments/%"),
        isNull(files.ticketId),
        isNull(files.messageId),
        gte(files.createdAt, new Date(now - UNCLAIMED_WINDOW_MS)),
        sql`${files.id} not in (select ${agency.logoFileId} from ${agency} where ${agency.logoFileId} is not null)`,
      ),
    );
  return row.count >= UNCLAIMED_MAX_FILES || row.bytes >= UNCLAIMED_MAX_BYTES;
}

/** Decodes the x-file-name header (encodeURIComponent); null when missing, too long or malformed. */
function decodeName(raw: string | null): string | null {
  if (!raw || raw.length > MAX_NAME_HEADER) return null;
  try {
    const name = decodeURIComponent(raw);
    return name.trim() ? name : null;
  } catch {
    return null;
  }
}

async function removeStored(storage: Storage, key: string): Promise<void> {
  try {
    await storage.remove(key);
  } catch (err) {
    // An orphaned object is harmless; there is no row pointing at it.
    console.error("Could not remove a stored file:", err);
  }
}

export async function receiveUpload(
  input: {
    uploader: Uploader | null;
    purpose: string | null;
    fileName: string | null;
    contentLength: string | null;
    body: ReadableStream<Uint8Array> | null;
  },
  deps: { db?: Db; storage?: Storage } = {},
): Promise<UploadResult> {
  const { uploader, purpose } = input;
  if (!uploader) return refuse(401, "unauthorized");
  if (purpose !== "attachment" && purpose !== "inline" && purpose !== "document") return refuse(400, "invalid_purpose");
  // The fiscal document of a charge is staff's: no portal person and no collaborator uploads one.
  if (purpose === "document" && !(uploader.type === "agency" && uploader.staff === true)) return refuse(401, "unauthorized");

  const decoded = decodeName(input.fileName);
  if (!decoded) return refuse(400, "invalid_name");
  const name = attachmentName(decoded);
  const inline = purpose === "inline";
  // The type comes from the cleaned name, which is also the name that is stored.
  const document = purpose === "document";
  const mime = document ? documentMime(name) : inline ? inlineImageMime(name) : attachmentMime(name);
  if (!mime) return refuse(415, "unsupported_type");

  const declaredRaw = input.contentLength?.trim() ?? "";
  const declared = /^\d{1,15}$/.test(declaredRaw) ? Number(declaredRaw) : 0;
  if (declared <= 0 || !input.body) return refuse(400, "invalid_length");
  const maxBytes = document ? DOCUMENT_MAX_BYTES : inline ? INLINE_IMAGE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
  if (declared > maxBytes) {
    await input.body.cancel().catch(() => undefined);
    return refuse(413, "too_large");
  }

  const db = deps.db ?? appDb;
  if (!document && (await unclaimedLimitReached(db, uploader))) {
    await input.body.cancel().catch(() => undefined);
    return refuse(429, "too_many_unclaimed");
  }
  const storage = deps.storage ?? getStorage();
  const key = newFileKey(document ? "documents" : "attachments");
  const source = Readable.fromWeb(input.body as import("node:stream/web").ReadableStream<Uint8Array>);

  let size: number;
  try {
    ({ size } = await storage.putStream(key, source, mime, { maxBytes }));
  } catch (err) {
    source.destroy();
    if (err instanceof TooLargeError) return refuse(413, "too_large");
    console.error("Could not store an upload:", err);
    return refuse(503, "storage_unavailable");
  }

  if (size !== declared) {
    await removeStored(storage, key);
    return refuse(400, "length_mismatch");
  }

  try {
    const [row] = await db
      .insert(files)
      .values({
        storageKey: key,
        name,
        mime,
        sizeBytes: size,
        uploadedByType: uploader.type,
        uploadedById: uploader.id,
        inline,
      })
      .returning({ id: files.id });
    return { status: 200, body: { id: row.id, url: `/api/files/${row.id}`, name, mime, size } };
  } catch (err) {
    await removeStored(storage, key);
    throw err;
  }
}
