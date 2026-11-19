import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import {
  agency,
  clientMemberships,
  clientUsers,
  clients,
  files,
  users,
  type Client,
  type ClientUser,
  type Db,
  type User,
} from "@/lib/db";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { diskStorage, type Storage } from "@/lib/storage";
import { addTicketAttachments, deleteTicketAttachment, listTicketFiles } from "./attachments";
import { postMessage } from "./messages";
import { createTicket, setTicketStatus, type TicketActor } from "./tickets";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let storage: Storage;
let root: string;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let collab2: TeamSession;
let acme: Client;
let beta: Client;
let paula: ClientUser;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
const asPortal = (user: ClientUser, client: Client): PortalSession => ({ userType: "client", user, client, role: "admin" });
const portal = () => asPortal(paula, acme);
const ref = (a: TicketActor) => ({ type: a.userType, id: a.user.id });

async function makeUser(name: string, role: User["role"]): Promise<User> {
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
  return u;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
  db = await resetTestDb();
  root = await mkdtemp(path.join(tmpdir(), "velk-attach-"));
  storage = diskStorage(root);
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en", collabClientScope: "all" });
  owner = asTeam(await makeUser("Ana", "owner"));
  manager = asTeam(await makeUser("Beto", "manager"));
  collab = asTeam(await makeUser("Cy", "collaborator"));
  collab2 = asTeam(await makeUser("Dai", "collaborator"));
  [acme] = await db.insert(clients).values({ name: "Acme", supportActive: true }).returning();
  [beta] = await db.insert(clients).values({ name: "Beta", supportActive: true }).returning();
  [paula] = await db.insert(clientUsers).values({ name: "Paula", email: "paula@acme.test" }).returning();
  await db.insert(clientMemberships).values([{ clientUserId: paula.id, clientId: acme.id, role: "admin" }]);
});

afterAll(async () => {
  await db?.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function ticketOf(client: Client = acme) {
  const r = await createTicket(owner, { clientId: client.id, type: "support", title: "T" }, { db });
  if (!r.ok) throw new Error(r.error);
  return r.value.ticketId;
}

/** An upload waiting to be claimed, with a real stored object. */
async function upload(by: { type: "agency" | "client"; id: string }, name = "a.pdf", inline = false) {
  const key = `attachments/${randomUUID()}`;
  await storage.put(key, Buffer.from("data"), "application/pdf");
  const [f] = await db
    .insert(files)
    .values({
      storageKey: key,
      name,
      mime: inline ? "image/png" : "application/pdf",
      sizeBytes: 4,
      uploadedByType: by.type,
      uploadedById: by.id,
      inline,
    })
    .returning({ id: files.id, storageKey: files.storageKey });
  return f;
}

async function attached(actor: TicketActor, ticketId: string, name = "a.pdf") {
  const f = await upload(ref(actor), name);
  const r = await addTicketAttachments(actor, ticketId, [f.id], { db });
  if (!r.ok) throw new Error(r.error);
  return f;
}

const rowExists = async (id: string) => (await db.select({ id: files.id }).from(files).where(eq(files.id, id))).length === 1;
const blobExists = async (key: string) => (await storage.get(key)) !== null;
const remove = (actor: TicketActor, ticketId: string, fileId: string) =>
  deleteTicketAttachment(actor, ticketId, fileId, { db, storage });

describe("addTicketAttachments", () => {
  it("ties the actor's uploads to the ticket, with no message", async () => {
    const id = await ticketOf();
    const a = await upload(ref(owner));
    const b = await upload(ref(owner), "b.pdf");
    expect(await addTicketAttachments(owner, id, [a.id, b.id], { db })).toEqual({ ok: true, value: { count: 2 } });
    const rows = await db.select().from(files).where(eq(files.ticketId, id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.messageId === null)).toBe(true);
  });

  it("someone else's upload is notFound and nothing is tied", async () => {
    const id = await ticketOf();
    const mine = await upload(ref(owner));
    const theirs = await upload(ref(collab));
    expect(await addTicketAttachments(owner, id, [mine.id, theirs.id], { db })).toEqual({ ok: false, error: "notFound" });
    const rows = await db.select().from(files).where(eq(files.ticketId, id));
    expect(rows).toHaveLength(0);
  });

  it("an empty list is required; an inline image, a used file and a bad id are notFound", async () => {
    const id = await ticketOf();
    expect(await addTicketAttachments(owner, id, [], { db })).toEqual({ ok: false, error: "required" });
    const inline = await upload(ref(owner), "p.png", true);
    expect(await addTicketAttachments(owner, id, [inline.id], { db })).toEqual({ ok: false, error: "notFound" });
    const used = await attached(owner, id);
    expect(await addTicketAttachments(owner, id, [used.id], { db })).toEqual({ ok: false, error: "notFound" });
    expect(await addTicketAttachments(owner, id, ["nope"], { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("more than one batch is tooManyFiles", async () => {
    const id = await ticketOf();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push((await upload(ref(owner), `f${i}.pdf`)).id);
    expect(await addTicketAttachments(owner, id, ids, { db })).toEqual({ ok: false, error: "tooManyFiles" });
  });

  it("another company's ticket is notFound for the portal; a closed ticket takes no files", async () => {
    const betaTicket = await ticketOf(beta);
    const f = await upload(ref(portal()));
    expect(await addTicketAttachments(portal(), betaTicket, [f.id], { db })).toEqual({ ok: false, error: "notFound" });
    const id = await ticketOf();
    await setTicketStatus(owner, id, "closed", { db });
    expect(await addTicketAttachments(portal(), id, [f.id], { db })).toEqual({ ok: false, error: "closed" });
  });
});

describe("deleteTicketAttachment", () => {
  it("a client removes their own general attachment: row and object are gone", async () => {
    const id = await ticketOf();
    const f = await attached(portal(), id);
    expect(await blobExists(f.storageKey)).toBe(true);
    expect(await remove(portal(), id, f.id)).toEqual({ ok: true, value: undefined });
    expect(await rowExists(f.id)).toBe(false);
    expect(await blobExists(f.storageKey)).toBe(false);
  });

  it("a client cannot remove the team's attachment", async () => {
    const id = await ticketOf();
    const f = await attached(owner, id);
    expect(await remove(portal(), id, f.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await rowExists(f.id)).toBe(true);
    expect(await blobExists(f.storageKey)).toBe(true);
  });

  it("a manager removes a collaborator's; a collaborator cannot remove the owner's or a peer's", async () => {
    const id = await ticketOf();
    const byCollab = await attached(collab, id);
    const byOwner = await attached(owner, id, "o.pdf");
    expect(await remove(collab, id, byOwner.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await remove(collab2, id, byCollab.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await remove(manager, id, byOwner.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await remove(manager, id, byCollab.id)).toEqual({ ok: true, value: undefined });
    expect(await rowExists(byCollab.id)).toBe(false);
    expect(await remove(owner, id, byOwner.id)).toEqual({ ok: true, value: undefined });
  });

  it("a message's file is notFound here, as is a file of another ticket, a bad id, and a repeat", async () => {
    const id = await ticketOf();
    const other = await ticketOf();
    const f = await upload(ref(owner));
    const sent = await postMessage(owner, id, { bodyHtml: "<p>x</p>", attachmentIds: [f.id] }, { db });
    expect(sent.ok).toBe(true);
    expect(await remove(owner, id, f.id)).toEqual({ ok: false, error: "notFound" });
    expect(await rowExists(f.id)).toBe(true);
    const g = await attached(owner, id, "g.pdf");
    expect(await remove(owner, other, g.id)).toEqual({ ok: false, error: "notFound" });
    expect(await remove(owner, id, "nope")).toEqual({ ok: false, error: "notFound" });
    expect(await remove(owner, id, g.id)).toEqual({ ok: true, value: undefined });
    expect(await remove(owner, id, g.id)).toEqual({ ok: false, error: "notFound" });
  });

  it("another company's ticket is notFound for the portal", async () => {
    const betaTicket = await ticketOf(beta);
    const f = await attached(owner, betaTicket);
    expect(await remove(portal(), betaTicket, f.id)).toEqual({ ok: false, error: "notFound" });
  });

  it("an attachment of someone who left the team can be removed by a manager", async () => {
    const id = await ticketOf();
    const f = await attached(collab, id);
    await db.delete(users).where(eq(users.id, collab.user.id));
    expect(await remove(manager, id, f.id)).toEqual({ ok: true, value: undefined });
  });
});

describe("listTicketFiles", () => {
  it("leaves out inline images and the files of deleted messages", async () => {
    const id = await ticketOf();
    const general = await attached(owner, id, "general.pdf");
    const sentFile = await upload(ref(owner), "kept.pdf");
    const img = await upload(ref(owner), "p.png", true);
    const live = await postMessage(
      owner,
      id,
      { bodyHtml: `<p>x <img src="/api/files/${img.id}"></p>`, attachmentIds: [sentFile.id] },
      { db },
    );
    if (!live.ok) throw new Error(live.error);
    const gone = await upload(ref(owner), "gone.pdf");
    const doomed = await postMessage(owner, id, { bodyHtml: "<p>y</p>", attachmentIds: [gone.id] }, { db });
    if (!doomed.ok) throw new Error(doomed.error);
    const { deleteMessage } = await import("./messages");
    await deleteMessage(owner, id, doomed.value.messageId, { db });

    const names = (await listTicketFiles(id, db)).map((f) => f.name).sort();
    expect(names).toEqual(["general.pdf", "kept.pdf"]);
    expect(await db.select().from(files).where(and(eq(files.ticketId, id), eq(files.inline, true)))).toHaveLength(1);
    expect(general.id).toBeTruthy();
  });
});
