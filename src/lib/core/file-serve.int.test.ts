import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import {
  agency,
  clientAssignments,
  clientMemberships,
  clientUsers,
  clients,
  files,
  users,
  type Client,
  type ClientUser,
  type User,
} from "@/lib/db";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { diskStorage, type Storage } from "@/lib/storage";
import { updateCollabVisibility } from "./assignments";
import { deleteMessage, editMessage, postMessage } from "./messages";
import { attachChargeDocument, createCharge } from "./charges";
import { createTicket } from "./tickets";
import { canReadFile, serveFile, type FileViewers } from "./file-serve";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";

let db: Db;
let storage: Storage;
let root: string;
let logoId: string;
let acme: Client;
let beta: Client;
let paula: ClientUser; // member of both companies
let owner: TeamSession;
let collab: TeamSession;

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const nobody: FileViewers = { team: null, portal: null };
const deps = () => ({ db, storage });
const serve = (id: string, viewers: FileViewers = nobody, download = false) =>
  serveFile(id, { download, viewers }, deps());
const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
const asPortal = (user: ClientUser, client: Client): PortalSession => ({ userType: "client", user, client, role: "admin" });
const team = (s: TeamSession): FileViewers => ({ team: s, portal: null });
const web = (s: PortalSession): FileViewers => ({ team: null, portal: s });

async function addFile(
  name: string,
  mime: string,
  bytes: Buffer,
  by: { type: "agency" | "client"; id: string },
  extra: Partial<typeof files.$inferInsert> = {},
) {
  const key = `attachments/2026/11/${randomUUID()}`;
  await storage.put(key, bytes, mime);
  const [row] = await db
    .insert(files)
    .values({ storageKey: key, name, mime, sizeBytes: bytes.length, uploadedByType: by.type, uploadedById: by.id, ...extra })
    .returning({ id: files.id });
  return row.id;
}

async function makeUser(name: string, role: User["role"]): Promise<User> {
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
  return u;
}

async function ticketOf(client: Client) {
  const r = await createTicket(owner, { clientId: client.id, type: "support", title: "T" }, { db });
  if (!r.ok) throw new Error(r.error);
  return r.value.ticketId;
}

const pdf = Buffer.from("%PDF-1.4");

beforeEach(async () => {
  if (db) await db.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
  db = await resetTestDb();
  root = await mkdtemp(path.join(tmpdir(), "velk-serve-"));
  storage = diskStorage(root);
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en", collabClientScope: "all" });
  owner = asTeam(await makeUser("Ana", "owner"));
  collab = asTeam(await makeUser("Cy", "collaborator"));
  [acme] = await db.insert(clients).values({ name: "Acme", supportActive: true }).returning();
  [beta] = await db.insert(clients).values({ name: "Beta", supportActive: true }).returning();
  [paula] = await db.insert(clientUsers).values({ name: "Paula", email: "paula@acme.test" }).returning();
  await db.insert(clientMemberships).values([
    { clientUserId: paula.id, clientId: acme.id, role: "admin" },
    { clientUserId: paula.id, clientId: beta.id, role: "admin" },
  ]);
  logoId = await addFile("logo.png", "image/png", PNG, { type: "agency", id: owner.user.id });
  await db.update(agency).set({ logoFileId: logoId });
});

afterAll(async () => {
  await db?.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("serveFile: logo and malformed ids", () => {
  it("serves the current logo publicly with its type and safe headers", async () => {
    const res = await serve(logoId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Length")).toBe(String(PNG.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("answers 404 to a malformed id and to an unknown uuid", async () => {
    expect((await serve("abc")).status).toBe(404);
    expect((await serve("../../etc/passwd")).status).toBe(404);
    expect((await serve(randomUUID())).status).toBe(404);
  });

  it("stops serving the old logo once the agency points elsewhere", async () => {
    await db.update(agency).set({ logoFileId: null });
    expect((await serve(logoId)).status).toBe(404);
  });

  it("answers 404 when the row exists but the object is gone", async () => {
    const [row] = await db.select().from(files).where(eq(files.id, logoId));
    await storage.remove(row.storageKey);
    expect((await serve(logoId)).status).toBe(404);
  });
});

describe("serveFile: ticket files", () => {
  async function attach(ticketId: string, opts: { by?: { type: "agency" | "client"; id: string }; messageId?: string | null; inline?: boolean; name?: string; mime?: string; bytes?: Buffer } = {}) {
    return addFile(opts.name ?? "doc.pdf", opts.mime ?? "application/pdf", opts.bytes ?? pdf, opts.by ?? { type: "agency", id: owner.user.id }, {
      ticketId,
      messageId: opts.messageId ?? null,
      inline: opts.inline ?? false,
    });
  }

  it("another company's attachment is 404, even for a member of both", async () => {
    const betaTicket = await ticketOf(beta);
    const id = await attach(betaTicket);
    expect((await serve(id, web(asPortal(paula, beta)))).status).toBe(200);
    expect((await serve(id, web(asPortal(paula, acme)))).status).toBe(404);
  });

  it("a team member pasting another company's file url into a message does not make it readable", async () => {
    const betaTicket = await ticketOf(beta);
    const secret = await attach(betaTicket);
    const acmeTicket = await ticketOf(acme);
    // Team member (owner) posts it in Acme's ticket body; the file still belongs to Beta's ticket.
    const posted = await postMessage(owner, acmeTicket, { bodyHtml: `<p><img src="/api/files/${secret}"></p>` }, { db });
    expect(posted.ok).toBe(true);
    expect((await serve(secret, web(asPortal(paula, acme)))).status).toBe(404);
  });

  it("collaborator outside the ticket scope gets 404", async () => {
    await updateCollabVisibility(owner, { clientScope: "assigned", ticketScope: "all", seesUnassigned: true }, { db });
    const id = await attach(await ticketOf(acme));
    expect((await serve(id, team(collab))).status).toBe(404);
    await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
    expect((await serve(id, team(collab))).status).toBe(200);
  });

  it("a deleted message's attachment and inline image are 404 for everyone", async () => {
    const ticketId = await ticketOf(acme);
    const doc = await attach(ticketId);
    const img = await addFile("p.png", "image/png", PNG, { type: "agency", id: owner.user.id }, { inline: true });
    const sent = await postMessage(
      owner,
      ticketId,
      { bodyHtml: `<p>see <img src="/api/files/${img}"></p>`, attachmentIds: [] },
      { db },
    );
    if (!sent.ok) throw new Error(sent.error);
    const messageId = sent.value.messageId;
    await db.update(files).set({ messageId }).where(eq(files.id, doc));

    const viewers = [team(owner), web(asPortal(paula, acme))];
    // Positive control: served while the message is live.
    for (const v of viewers) {
      expect((await serve(doc, v)).status).toBe(200);
      expect((await serve(img, v)).status).toBe(200);
    }
    expect(await deleteMessage(owner, ticketId, messageId, { db })).toEqual({ ok: true, value: { changed: true } });
    for (const v of viewers) {
      expect((await serve(doc, v)).status).toBe(404);
      expect((await serve(img, v)).status).toBe(404);
    }
  });

  it("an inline image an edit removed from the body stops being served", async () => {
    const ticketId = await ticketOf(acme);
    const img = await addFile("p.png", "image/png", PNG, { type: "agency", id: owner.user.id }, { inline: true });
    const sent = await postMessage(owner, ticketId, { bodyHtml: `<p>x <img src="/api/files/${img}"></p>` }, { db });
    if (!sent.ok) throw new Error(sent.error);
    expect((await serve(img, web(asPortal(paula, acme)))).status).toBe(200);
    expect((await editMessage(owner, ticketId, sent.value.messageId, "<p>no image now</p>", { db })).ok).toBe(true);
    expect((await serve(img, web(asPortal(paula, acme)))).status).toBe(404);
    expect((await serve(img, team(owner))).status).toBe(404);
  });

  it("an unattached file opens only for whoever uploaded it, on the same side", async () => {
    const loose = await addFile("draft.pdf", "application/pdf", pdf, { type: "agency", id: owner.user.id });
    expect((await serve(loose, team(owner))).status).toBe(200);
    expect((await serve(loose, team(collab))).status).toBe(404);
    expect((await serve(loose, web(asPortal(paula, acme)))).status).toBe(404);
    // Uploaded by the team, but only a portal session is present: no.
    expect((await serve(loose, web(asPortal(paula, acme)))).status).toBe(404);
    expect((await serve(loose, nobody)).status).toBe(404);
    // A portal person's own upload: only their portal session.
    const mine = await addFile("mine.pdf", "application/pdf", pdf, { type: "client", id: paula.id });
    expect((await serve(mine, web(asPortal(paula, acme)))).status).toBe(200);
    expect((await serve(mine, team(owner))).status).toBe(404);
    // A team session whose user id equals a client's id is still not that client.
    const clone = { ...owner, user: { ...owner.user, id: paula.id } } as TeamSession;
    expect((await serve(mine, team(clone))).status).toBe(404);
  });

  it("canReadFile: a file whose ticket is gone, or an inline image without a message, is refused", async () => {
    const ticketId = await ticketOf(acme);
    const stray = await attach(ticketId, { inline: true, mime: "image/png", name: "x.png" });
    const [row] = await db.select().from(files).where(eq(files.id, stray));
    expect(await canReadFile(team(owner), row, db)).toBe(false);
  });

  it("attachments are served with nosniff, a closed CSP and attachment disposition", async () => {
    const ticketId = await ticketOf(acme);
    const doc = await attach(ticketId, { name: "relatório final.pdf" });
    const zip = await attach(ticketId, { name: "pack.zip", mime: "application/zip", bytes: Buffer.from("PK") });
    const v = team(owner);

    const inline = await serve(doc, v);
    expect(inline.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(inline.headers.get("Content-Disposition")).toContain("filename*=UTF-8''relat%C3%B3rio%20final.pdf");
    expect(inline.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(inline.headers.get("Content-Security-Policy")).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    expect(inline.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(inline.headers.get("Content-Type")).toBe("application/pdf");
    expect(inline.headers.get("Content-Length")).toBe(String(pdf.length));

    const forced = await serve(doc, v, true);
    expect(forced.headers.get("Content-Disposition")).toMatch(/^attachment;/);

    const archive = await serve(zip, v);
    expect(archive.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(archive.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(archive.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("a refusal is always 404, never 403, and carries no file headers", async () => {
    const id = await attach(await ticketOf(beta));
    const res = await serve(id, web(asPortal(paula, acme)));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });
});

describe("serveFile: fiscal documents", () => {
  it("a fiscal document is served only to staff and that company's admins", async () => {
    const manager = asTeam(await makeUser("Mia", "manager"));
    const made = await createCharge(owner, { source: "none", clientId: acme.id, label: "Site", amountCents: 5000, provider: null }, { db, providers: [] });
    if (!made.ok) throw new Error(made.error);
    const key = `documents/2026/11/${randomUUID()}`;
    await storage.put(key, pdf, "application/pdf");
    const [file] = await db
      .insert(files)
      .values({ storageKey: key, name: "nf.pdf", mime: "application/pdf", sizeBytes: pdf.length, uploadedByType: "agency", uploadedById: owner.user.id })
      .returning();
    // Unattached: only the person who uploaded it.
    expect((await serve(file.id, team(owner))).status).toBe(200);
    expect((await serve(file.id, team(manager))).status).toBe(404);
    const attached = await attachChargeDocument(owner, made.value.id, file.id, { db, storage, providers: [] });
    expect(attached.ok).toBe(true);

    for (const staff of [owner, manager]) expect((await serve(file.id, team(staff))).status).toBe(200);
    expect((await serve(file.id, web(asPortal(paula, acme)))).status).toBe(200);
    expect((await serve(file.id, team(collab))).status).toBe(404);
    expect((await serve(file.id, web(asPortal(paula, beta)))).status).toBe(404);
    expect((await serve(file.id, web({ ...asPortal(paula, acme), role: "collaborator" }))).status).toBe(404);
    expect((await serve(file.id, nobody)).status).toBe(404);
    // A team and a portal session at once: each is judged on its own.
    expect((await serve(file.id, { team: collab, portal: web(asPortal(paula, acme)).portal })).status).toBe(200);
    expect((await serve(file.id, { team: collab, portal: web(asPortal(paula, beta)).portal })).status).toBe(404);
  });
});
