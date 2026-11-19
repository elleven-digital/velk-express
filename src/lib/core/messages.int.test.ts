import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi, afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientAssignments,
  clientMemberships,
  clientUsers,
  clients,
  files,
  messages,
  ticketReads,
  tickets,
  users,
  type Client,
  type ClientUser,
  type Db,
  type User,
} from "@/lib/db";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { updateCollabVisibility } from "./assignments";
import { deleteMessage, editMessage, markTicketRead, postMessage } from "./messages";
import { loadThread, loadTicketFiles } from "./thread";
import { Abort, transact } from "./tx";
import { claimFiles, listTicketFiles } from "./attachments";
import { createTicket, findTicket, setTicketStatus, type TicketActor } from "./tickets";
import { unreadCountSql, unreadWhere } from "@/lib/unread";
import { diskStorage } from "@/lib/storage";
import { serveFile } from "./file-serve";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let collab2: TeamSession;
let acme: Client;
let beta: Client;
let paula: ClientUser;
let outsider: ClientUser;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
const asPortal = (user: ClientUser, client: Client): PortalSession => ({ userType: "client", user, client, role: "admin" });
const portal = () => asPortal(paula, acme);

async function makeUser(name: string, role: User["role"]): Promise<User> {
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
  return u;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en", collabClientScope: "all" });
  owner = asTeam(await makeUser("Ana", "owner"));
  manager = asTeam(await makeUser("Beto", "manager"));
  collab = asTeam(await makeUser("Cy", "collaborator"));
  collab2 = asTeam(await makeUser("Dai", "collaborator"));
  [acme] = await db.insert(clients).values({ name: "Acme", supportActive: true, generalTicketsEnabled: true }).returning();
  [beta] = await db.insert(clients).values({ name: "Beta", supportActive: true, generalTicketsEnabled: true }).returning();
  [paula] = await db.insert(clientUsers).values({ name: "Paula", email: "paula@acme.test" }).returning();
  [outsider] = await db.insert(clientUsers).values({ name: "Otto", email: "otto@beta.test" }).returning();
  await db.insert(clientMemberships).values([
    { clientUserId: paula.id, clientId: acme.id, role: "admin" },
    { clientUserId: paula.id, clientId: beta.id, role: "admin" },
    { clientUserId: outsider.id, clientId: beta.id, role: "admin" },
  ]);
});

afterAll(async () => {
  await db?.$client.end();
});

async function ticketOf(client: Client = acme, type: "single" | "support" = "support") {
  const r = await createTicket(owner, { clientId: client.id, type, title: "T" }, { db });
  if (!r.ok) throw new Error(r.error);
  return r.value.ticketId;
}

async function post(actor: TicketActor, ticketId: string, bodyHtml: string, extra: { replyToId?: string; attachmentIds?: string[] } = {}) {
  return postMessage(actor, ticketId, { bodyHtml, ...extra }, { db });
}

async function mustPost(actor: TicketActor, ticketId: string, bodyHtml: string, extra: { replyToId?: string; attachmentIds?: string[] } = {}) {
  const r = await post(actor, ticketId, bodyHtml, extra);
  if (!r.ok) throw new Error(r.error);
  return r.value.messageId;
}

async function upload(by: { type: "agency" | "client"; id: string }, name = "a.pdf", inline = false) {
  const [f] = await db
    .insert(files)
    .values({
      storageKey: `attachments/${randomUUID()}`,
      name,
      mime: inline ? "image/png" : "application/pdf",
      sizeBytes: 2_500_000,
      uploadedByType: by.type,
      uploadedById: by.id,
      inline,
    })
    .returning({ id: files.id });
  return f.id;
}

const unread = async (userId: string, ticketId: string) =>
  (await db.select({ n: unreadCountSql(userId) }).from(tickets).where(eq(tickets.id, ticketId)))[0].n;
const messageRow = async (id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0];
const ref = (t: TeamSession) => ({ type: "agency" as const, id: t.user.id });

describe("postMessage", () => {
  it("a client answers a ticket of their own company and last_message_at moves", async () => {
    const id = await ticketOf();
    const before = (await db.select().from(tickets).where(eq(tickets.id, id)))[0].lastMessageAt;
    expect(before).toBeNull();
    const r = await post(portal(), id, "<p>Hello</p>");
    expect(r.ok).toBe(true);
    const after = (await db.select().from(tickets).where(eq(tickets.id, id)))[0].lastMessageAt;
    expect(after).not.toBeNull();
    const [row] = await db.select().from(messages).where(eq(messages.ticketId, id));
    expect(row).toMatchObject({ authorType: "client", authorId: paula.id, bodyText: "Hello" });
  });

  it("postMessage outside the collaborator's scope is notFound", async () => {
    await updateCollabVisibility(owner, { clientScope: "assigned", ticketScope: "all", seesUnassigned: true }, { db });
    const id = await ticketOf(acme);
    expect(await post(collab, id, "<p>hi</p>")).toEqual({ ok: false, error: "notFound" });
    await db.insert(clientAssignments).values({ clientId: acme.id, userId: collab.user.id });
    expect((await post(collab, id, "<p>hi</p>")).ok).toBe(true);
  });

  it("the portal never reaches another company's ticket, even for someone in both", async () => {
    const betaTicket = await ticketOf(beta);
    expect(await post(portal(), betaTicket, "<p>x</p>")).toEqual({ ok: false, error: "notFound" });
    expect(await editMessage(portal(), betaTicket, randomUUID(), "<p>x</p>", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await deleteMessage(portal(), betaTicket, randomUUID(), { db })).toEqual({ ok: false, error: "notFound" });
    const m = await mustPost(owner, betaTicket, "<p>secret</p>");
    expect(await editMessage(portal(), betaTicket, m, "<p>x</p>", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await deleteMessage(portal(), betaTicket, m, { db })).toEqual({ ok: false, error: "notFound" });
    const betaTicketRow = (await findTicket(owner, betaTicket, db));
    if (!betaTicketRow.ok) throw new Error("no ticket");
    expect(await loadThread(portal(), betaTicketRow.value, "en", db)).toEqual([]); // the loader refuses another company's ticket on its own
    expect(await loadTicketFiles(portal(), betaTicketRow.value, "en", db)).toEqual([]);
    expect((await loadThread(owner, betaTicketRow.value, "en", db)).length).toBe(1);
    expect(await findTicket(portal(), betaTicket, db)).toEqual({ ok: false, error: "notFound" });
  });

  it("a reply must point at a live message of the same ticket", async () => {
    const a = await ticketOf();
    const b = await ticketOf();
    const other = await mustPost(owner, b, "<p>other</p>");
    expect(await post(owner, a, "<p>x</p>", { replyToId: other })).toEqual({ ok: false, error: "notFound" });
    const gone = await mustPost(owner, a, "<p>gone</p>");
    await deleteMessage(owner, a, gone, { db });
    expect(await post(owner, a, "<p>x</p>", { replyToId: gone })).toEqual({ ok: false, error: "notFound" });
    expect(await post(owner, a, "<p>x</p>", { replyToId: "nope" })).toEqual({ ok: false, error: "notFound" });
    const live = await mustPost(owner, a, "<p>live</p>");
    const reply = await mustPost(portal(), a, "<p>ok</p>", { replyToId: live });
    expect((await messageRow(reply)).replyToId).toBe(live);
  });

  it("a closed ticket refuses messages on both sides", async () => {
    const id = await ticketOf();
    await setTicketStatus(owner, id, "closed", { db });
    expect(await post(owner, id, "<p>x</p>")).toEqual({ ok: false, error: "closed" });
    expect(await post(portal(), id, "<p>x</p>")).toEqual({ ok: false, error: "closed" });
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("an empty body needs attachments", async () => {
    const id = await ticketOf();
    expect(await post(owner, id, "")).toEqual({ ok: false, error: "required" });
    expect(await post(owner, id, "<p> </p>")).toEqual({ ok: false, error: "required" });
    const file = await upload(ref(owner));
    const r = await post(owner, id, "", { attachmentIds: [file] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await messageRow(r.value.messageId);
    expect(row.bodyHtml).toBe("");
    expect((await db.select().from(files).where(eq(files.id, file)))[0]).toMatchObject({ ticketId: id, messageId: r.value.messageId });
  });

  it("refuses an oversize body", async () => {
    const id = await ticketOf();
    expect(await post(owner, id, `<p>${"a".repeat(100_001)}</p>`)).toEqual({ ok: false, error: "tooLong" });
  });

  it("an attachment from someone else is notFound and no message is stored", async () => {
    const id = await ticketOf();
    const theirs = await upload(ref(collab));
    expect(await post(owner, id, "<p>x</p>", { attachmentIds: [theirs] })).toEqual({ ok: false, error: "notFound" });
    expect(await post(portal(), id, "<p>x</p>", { attachmentIds: [theirs] })).toEqual({ ok: false, error: "notFound" });
    // another company's person cannot use Paula's file either
    const paulas = await upload({ type: "client", id: paula.id });
    expect(await post(owner, id, "<p>x</p>", { attachmentIds: [paulas] })).toEqual({ ok: false, error: "notFound" });
    expect(await post(owner, id, "<p>x</p>", { attachmentIds: [randomUUID()] })).toEqual({ ok: false, error: "notFound" });
    expect(await db.select().from(messages)).toHaveLength(0);
    expect((await db.select().from(files).where(eq(files.id, theirs)))[0].ticketId).toBeNull();
  });

  it("an attachment already claimed or an inline image cannot be attached", async () => {
    const id = await ticketOf();
    const f = await upload(ref(owner));
    await mustPost(owner, id, "<p>1</p>", { attachmentIds: [f] });
    expect(await post(owner, id, "<p>2</p>", { attachmentIds: [f] })).toEqual({ ok: false, error: "notFound" });
    const img = await upload(ref(owner), "i.png", true);
    expect(await post(owner, id, "<p>3</p>", { attachmentIds: [img] })).toEqual({ ok: false, error: "notFound" });
  });

  it("eleven files are too many", async () => {
    const id = await ticketOf();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await upload(ref(owner), `f${i}.pdf`));
    expect(await post(owner, id, "<p>x</p>", { attachmentIds: ids })).toEqual({ ok: false, error: "tooManyFiles" });
    expect(await db.select().from(messages)).toHaveLength(0);
    const ten = ids.slice(0, 10);
    expect((await post(owner, id, "<p>x</p>", { attachmentIds: ten })).ok).toBe(true);
  });

  it("claims the author's inline images in the body", async () => {
    const id = await ticketOf();
    const img = await upload(ref(owner), "i.png", true);
    const m = await mustPost(owner, id, `<p>see</p><img src="/api/files/${img}">`);
    expect((await db.select().from(files).where(eq(files.id, img)))[0]).toMatchObject({ ticketId: id, messageId: m });
  });
});

describe("claimFiles", () => {
  it("ties only the uploader's unclaimed files, all or nothing", async () => {
    const id = await ticketOf();
    const mine = await upload(ref(owner));
    const theirs = await upload(ref(collab));
    // The caller rolls the transaction back on a refusal, so nothing stays claimed.
    const bad = await transact(db, async (tx) => {
      const r = await claimFiles(tx, { ticketId: id, messageId: null, uploader: ref(owner), fileIds: [mine, theirs] });
      if (!r.ok) throw new Abort(r.error);
    });
    expect(bad).toEqual({ ok: false, error: "notFound" });
    expect((await db.select().from(files).where(eq(files.id, mine)))[0].ticketId).toBeNull();
    const good = await claimFiles(db, { ticketId: id, messageId: null, uploader: ref(owner), fileIds: [mine, mine] });
    expect(good).toEqual({ ok: true, value: { count: 1 } });
  });
});

describe("editMessage", () => {
  it("the same body changes nothing; a new one marks the edit", async () => {
    const id = await ticketOf();
    const m = await mustPost(collab, id, "<p>one</p>");
    expect(await editMessage(collab, id, m, "<p>one</p>", { db })).toEqual({ ok: true, value: { changed: false } });
    expect((await messageRow(m)).editedAt).toBeNull();
    expect(await editMessage(collab, id, m, "<p>two</p>", { db })).toEqual({ ok: true, value: { changed: true } });
    expect(await messageRow(m)).toMatchObject({ bodyText: "two", editedByType: "agency", editedById: collab.user.id });
    expect((await messageRow(m)).editedAt).not.toBeNull();
  });


  it("a deletion stays done when removing the stored files fails afterwards", async () => {
    const id = await ticketOf();
    const fileId = await upload(ref(owner), "c.pdf");
    const m = await mustPost(owner, id, "<p>x</p>", { attachmentIds: [fileId] });
    // reading the storage itself fails (a misconfigured installation), after the commit
    const deps = {
      db,
      get storage(): never {
        throw new Error("storage is not configured");
      },
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await deleteMessage(owner, id, m, deps)).toEqual({ ok: true, value: { changed: true } });
    } finally {
      quiet.mockRestore();
    }
    expect(await db.select().from(files).where(eq(files.id, fileId))).toHaveLength(0);
  });
  it("deleting a message removes its files' rows and stored blobs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "velk-msg-"));
    try {
      const storage = diskStorage(root);
      const id = await ticketOf();
      const mine = await upload(ref(owner), "a.pdf");
      const other = await upload(ref(owner), "b.pdf");
      const keys: string[] = [];
      for (const fileId of [mine, other]) {
        const [row] = await db.select().from(files).where(eq(files.id, fileId));
        await storage.put(row.storageKey, Buffer.from("data"), "application/pdf");
        keys.push(row.storageKey);
      }
      const m = await mustPost(owner, id, "<p>x</p>", { attachmentIds: [mine] });
      const kept = await mustPost(owner, id, "<p>y</p>", { attachmentIds: [other] });
      expect(await deleteMessage(owner, id, m, { db, storage })).toEqual({ ok: true, value: { changed: true } });
      expect(await db.select().from(files).where(eq(files.id, mine))).toHaveLength(0);
      expect(await storage.get(keys[0])).toBeNull();
      // the other message keeps its file
      expect(await db.select().from(files).where(eq(files.messageId, kept))).toHaveLength(1);
      expect(await storage.get(keys[1])).not.toBeNull();
      const res = await serveFile(mine, { download: false, viewers: { team: owner, portal: null } }, { db, storage });
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects who may modify whom", async () => {
    const id = await ticketOf();
    const clientMsg = await mustPost(portal(), id, "<p>c</p>");
    const collabMsg = await mustPost(collab, id, "<p>x</p>");
    const ownerMsg = await mustPost(owner, id, "<p>o</p>");
    expect(await editMessage(portal(), id, ownerMsg, "<p>h</p>", { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await editMessage(owner, id, clientMsg, "<p>h</p>", { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await editMessage(manager, id, collabMsg, "<p>fixed</p>", { db })).toEqual({ ok: true, value: { changed: true } });
    expect(await editMessage(manager, id, ownerMsg, "<p>h</p>", { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await editMessage(collab2, id, collabMsg, "<p>h</p>", { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await editMessage(owner, id, collabMsg, "<p>again</p>", { db })).toEqual({ ok: true, value: { changed: true } });
  });

  it("a former member's message can be moderated by a manager", async () => {
    const id = await ticketOf();
    const m = await mustPost(collab2, id, "<p>x</p>");
    await db.delete(users).where(eq(users.id, collab2.user.id));
    expect(await editMessage(manager, id, m, "<p>y</p>", { db })).toEqual({ ok: true, value: { changed: true } });
  });

  it("a deleted message cannot be edited; a message from another ticket is notFound", async () => {
    const id = await ticketOf();
    const other = await ticketOf();
    const m = await mustPost(owner, id, "<p>x</p>");
    expect(await editMessage(owner, other, m, "<p>y</p>", { db })).toEqual({ ok: false, error: "notFound" });
    await deleteMessage(owner, id, m, { db });
    expect(await editMessage(owner, id, m, "<p>y</p>", { db })).toEqual({ ok: false, error: "messageDeleted" });
  });

  it("emptying the text needs files on the message, and edits claim new inline images", async () => {
    const id = await ticketOf();
    const plain = await mustPost(owner, id, "<p>x</p>");
    expect(await editMessage(owner, id, plain, "", { db })).toEqual({ ok: false, error: "required" });
    const file = await upload(ref(owner));
    const withFile = await mustPost(owner, id, "<p>x</p>", { attachmentIds: [file] });
    expect(await editMessage(owner, id, withFile, "<p></p>", { db })).toEqual({ ok: true, value: { changed: true } });
    expect((await messageRow(withFile)).bodyHtml).toBe("");
    const img = await upload(ref(owner), "i.png", true);
    await editMessage(owner, id, plain, `<p>y</p><img src="/api/files/${img}">`, { db });
    expect((await db.select().from(files).where(eq(files.id, img)))[0]).toMatchObject({ ticketId: id, messageId: plain });
    expect(await editMessage(owner, id, plain, `<p>${"a".repeat(100_001)}</p>`, { db })).toEqual({ ok: false, error: "tooLong" });
  });
});

describe("deleteMessage", () => {
  it("deleting twice changes once", async () => {
    const id = await ticketOf();
    const m = await mustPost(owner, id, "<p>x</p>");
    expect(await deleteMessage(owner, id, m, { db })).toEqual({ ok: true, value: { changed: true } });
    expect(await deleteMessage(owner, id, m, { db })).toEqual({ ok: true, value: { changed: false } });
    expect(await messageRow(m)).toMatchObject({ deletedByType: "agency", deletedById: owner.user.id });
  });

  it("respects who may modify whom", async () => {
    const id = await ticketOf();
    const clientMsg = await mustPost(portal(), id, "<p>c</p>");
    expect(await deleteMessage(owner, id, clientMsg, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteMessage(portal(), id, clientMsg, { db })).toEqual({ ok: true, value: { changed: true } });
  });
});

describe("thread", () => {
  it("deleted message body, reply excerpt and attachments never reach the thread", async () => {
    const id = await ticketOf();
    const file = await upload(ref(owner), "secret.pdf");
    const secret = await mustPost(owner, id, "<p>TOPSECRET text</p>", { attachmentIds: [file] });
    const reply = await mustPost(portal(), id, "<p>answering</p>", { replyToId: secret });
    const mine = await mustPost(owner, id, "<p>quoting my own</p>", { replyToId: secret });
    await deleteMessage(owner, id, secret, { db });
    const found = await findTicket(owner, id, db);
    if (!found.ok) throw new Error("x");

    for (const actor of [owner, portal()] as TicketActor[]) {
      const thread = await loadThread(actor, found.value, "en", db);
      expect(JSON.stringify(thread)).not.toContain("TOPSECRET");
      expect(JSON.stringify(thread)).not.toContain("secret.pdf");
      const tomb = thread.find((m) => m.id === secret)!;
      expect(tomb).toMatchObject({ deleted: true, bodyHtml: "", attachments: [], replyTo: null, canEdit: false, canDelete: false });
      for (const rid of [reply, mine]) {
        const quoting = thread.find((m) => m.id === rid)!;
        expect(quoting.replyTo).toMatchObject({ id: secret, excerpt: "", deleted: true });
      }
      const files = await loadTicketFiles(actor, found.value, "en", db);
      expect(files).toEqual([]);
    }
  });

  it("a live reply shows an excerpt, and a deleted message that replied has no quote", async () => {
    const id = await ticketOf();
    const base = await mustPost(owner, id, `<p>${"x".repeat(200)}</p>`);
    const replying = await mustPost(portal(), id, "<p>re</p>", { replyToId: base });
    const found = await findTicket(owner, id, db);
    if (!found.ok) throw new Error("x");
    let thread = await loadThread(owner, found.value, "en", db);
    const quote = thread.find((m) => m.id === replying)!.replyTo!;
    expect(quote).toMatchObject({ id: base, authorName: "Ana", deleted: false });
    expect(quote.excerpt.length).toBeLessThanOrEqual(111);
    await deleteMessage(portal(), id, replying, { db });
    thread = await loadThread(owner, found.value, "en", db);
    expect(thread.find((m) => m.id === replying)!.replyTo).toBeNull();
  });

  it("the portal thread says edited or deleted without who", async () => {
    const id = await ticketOf();
    const edited = await mustPost(collab, id, "<p>one</p>");
    const deleted = await mustPost(collab, id, "<p>two</p>");
    await editMessage(manager, id, edited, "<p>one!</p>", { db });
    await deleteMessage(owner, id, deleted, { db });
    const found = await findTicket(owner, id, db);
    if (!found.ok) throw new Error("x");

    const web = await loadThread(portal(), found.value, "en", db);
    expect(web.find((m) => m.id === edited)).toMatchObject({ edited: true, deleted: false, changedBy: null, canEdit: false });
    expect(web.find((m) => m.id === deleted)).toMatchObject({ edited: false, deleted: true, changedBy: null });

    const team = await loadThread(owner, found.value, "en", db);
    expect(team.find((m) => m.id === edited)!.changedBy).toMatchObject({ name: "Beto" });
    expect(team.find((m) => m.id === deleted)!.changedBy).toMatchObject({ name: "Ana" });
    expect(team.find((m) => m.id === edited)).toMatchObject({ canEdit: true, canDelete: true, mine: false, fromAgency: true });
  });

  it("names a removed person with the localized label and lists live files only", async () => {
    const id = await ticketOf();
    const file = await upload(ref(collab2), "doc.pdf");
    await mustPost(collab2, id, "<p>bye</p>", { attachmentIds: [file] });
    await db.delete(users).where(eq(users.id, collab2.user.id));
    const found = await findTicket(owner, id, db);
    if (!found.ok) throw new Error("x");
    const thread = await loadThread(owner, found.value, "pt", db);
    expect(thread[0].authorName).toBe("Usuário removido");
    expect(thread[0].attachments).toHaveLength(1);
    expect(thread[0].attachments[0]).toMatchObject({ name: "doc.pdf", byName: "Usuário removido", url: `/api/files/${file}`, preview: false });
    expect(thread[0].attachments[0].size).toContain("2,4");
    expect(await listTicketFiles(id, db)).toHaveLength(1);
  });

  it("sanitizes again on the way out", async () => {
    const id = await ticketOf();
    const m = await mustPost(owner, id, "<p>ok</p>");
    await db.update(messages).set({ bodyHtml: '<p>x</p><script>alert(1)</script><a href="https://a.test">l</a>' }).where(eq(messages.id, m));
    const found = await findTicket(owner, id, db);
    if (!found.ok) throw new Error("x");
    const [row] = await loadThread(portal(), found.value, "en", db);
    expect(row.bodyHtml).not.toContain("<script");
    expect(row.bodyHtml).toContain('rel="noopener noreferrer"');
  });
});

describe("unread", () => {
  it("unread never counts the reader's own messages", async () => {
    const id = await ticketOf();
    await mustPost(collab, id, "<p>a</p>");
    await mustPost(collab, id, "<p>b</p>");
    const fromClient = await mustPost(portal(), id, "<p>c</p>");
    expect(await unread(collab.user.id, id)).toBe(1);
    // another member sees all three
    expect(await unread(collab2.user.id, id)).toBe(3);

    // a deleted message no longer counts
    await deleteMessage(portal(), id, fromClient, { db });
    expect(await unread(collab.user.id, id)).toBe(0);
    const another = await mustPost(portal(), id, "<p>d</p>");
    expect(await unread(collab.user.id, id)).toBe(1);

    // marking read with a time after the last message zeroes it
    const [last] = await db.select({ at: messages.createdAt }).from(messages).where(eq(messages.id, another));
    const later = new Date(last.at.getTime() + 1);
    expect(await markTicketRead(collab, id, later, { db })).toEqual({ ok: true, value: undefined });
    expect(await unread(collab.user.id, id)).toBe(0);

    // an older mark does not move it back
    await markTicketRead(collab, id, new Date(0), { db });
    expect(await unread(collab.user.id, id)).toBe(0);
    const [read] = await db.select().from(ticketReads).where(and(eq(ticketReads.userId, collab.user.id), eq(ticketReads.ticketId, id)));
    expect(read.lastReadAt.getTime()).toBe(later.getTime());
  });

  it("an Invalid Date is refused and writes nothing", async () => {
    const id = await ticketOf();
    expect(await markTicketRead(collab, id, new Date("not a date"), { db })).toEqual({ ok: false, error: "invalid" });
    expect(await db.select().from(ticketReads)).toEqual([]);
    // Far past and far future are still sane marks (clamped), never a database error.
    expect((await markTicketRead(collab, id, new Date(-8.64e15), { db })).ok).toBe(true);
    expect((await markTicketRead(collab, id, new Date(8.64e15), { db })).ok).toBe(true);
  });

  it("trusts the database clock: an app clock that lags does not leave a recent message unread", async () => {
    const id = await ticketOf();
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow - 5000);
    try {
      await mustPost(portal(), id, "<p>recent</p>");
      expect(await unread(collab.user.id, id)).toBe(1);
      // `at` is ahead of the lagging app clock (as a database-clock timestamp is); the database caps it at its own now()
      await markTicketRead(collab, id, new Date(realNow + 5000), { db });
    } finally {
      spy.mockRestore();
    }
    expect(await unread(collab.user.id, id)).toBe(0);
  });

  it("a mark in the future becomes now, so later messages still count", async () => {
    const id = await ticketOf();
    await markTicketRead(collab, id, new Date(Date.now() + 3600_000), { db });
    const [read] = await db.select().from(ticketReads).where(eq(ticketReads.userId, collab.user.id));
    expect(read.lastReadAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await new Promise((r) => setTimeout(r, 20));
    await mustPost(portal(), id, "<p>after</p>");
    expect(await unread(collab.user.id, id)).toBe(1);
  });

  it("without a read row, only messages after the person joined count", async () => {
    const id = await ticketOf();
    const before = await mustPost(portal(), id, "<p>old</p>");
    await db.update(messages).set({ createdAt: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, before));
    await db.update(users).set({ createdAt: new Date("2021-01-01T00:00:00Z") }).where(eq(users.id, collab.user.id));
    expect(await unread(collab.user.id, id)).toBe(0);
    await mustPost(portal(), id, "<p>new</p>");
    expect(await unread(collab.user.id, id)).toBe(1);
    const rows = await db.select({ id: tickets.id }).from(tickets).where(unreadWhere(collab.user.id));
    expect(rows.map((r) => r.id)).toEqual([id]);
    // the ticket's creator wrote nothing there, so the portal message counts for them too
    const others = await db.select({ id: tickets.id }).from(tickets).where(unreadWhere(owner.user.id));
    expect(others.map((r) => r.id)).toEqual([id]);
  });

  it("markTicketRead outside the scope is notFound", async () => {
    await updateCollabVisibility(owner, { clientScope: "assigned", ticketScope: "all", seesUnassigned: true }, { db });
    const id = await ticketOf(acme);
    expect(await markTicketRead(collab, id, undefined, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await markTicketRead(collab, "nope", undefined, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await db.select().from(ticketReads)).toHaveLength(0);
  });
});
