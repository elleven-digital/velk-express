import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { clients, files, tickets } from "@/lib/db";
import { diskStorage, type Storage } from "@/lib/storage";
import { receiveUpload, type Uploader } from "./uploads";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

const MB25 = 25 * 1024 * 1024;
const MB8 = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;

let db: Db;
let storage: Storage;
let root: string;
const uploader: Uploader = { type: "agency", id: randomUUID() };

beforeEach(async () => {
  if (db) await db.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
  db = await resetTestDb();
  root = await mkdtemp(path.join(tmpdir(), "velk-uploads-"));
  storage = diskStorage(root);
});

afterAll(async () => {
  await db?.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
});

/** A body of `total` bytes produced in 64 KiB pieces; the hash is of what was produced. */
function generated(total: number) {
  const hash = createHash("sha256");
  let sent = 0;
  // highWaterMark 0: nothing is produced until the consumer actually reads.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(CHUNK, total - sent);
      const chunk = new Uint8Array(n);
      for (let i = 0; i < n; i += 4096) chunk[i] = (sent + i) & 0xff;
      sent += n;
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  return { stream, sha256: () => hash.digest("hex"), sent: () => sent };
}

const encoded = (name: string) => encodeURIComponent(name);

type Over = Partial<Parameters<typeof receiveUpload>[0]>;
function call(size: number, over: Over = {}) {
  const body = generated(size);
  const promise = receiveUpload(
    {
      uploader,
      purpose: "attachment",
      fileName: encoded("report.pdf"),
      contentLength: String(size),
      body: body.stream,
      ...over,
    },
    { db, storage },
  );
  return { promise, body };
}

async function storedFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else out.push(path.join(dir, e.name));
    }
  }
  await walk(root);
  return out;
}

const rows = () => db.select().from(files);

describe("receiveUpload", () => {
  it("accepts exactly 25 MB and stores every byte", async () => {
    const { promise, body } = call(MB25);
    const res = await promise;
    expect(res.status).toBe(200);
    if (res.status !== 200) throw new Error("unreachable");
    expect(res.body).toMatchObject({ name: "report.pdf", mime: "application/pdf", size: MB25 });
    expect(res.body.url).toBe(`/api/files/${res.body.id}`);

    const [row] = await rows();
    expect(row).toMatchObject({
      id: res.body.id,
      sizeBytes: MB25,
      inline: false,
      ticketId: null,
      messageId: null,
      uploadedByType: "agency",
      uploadedById: uploader.id,
    });
    expect(row.storageKey).toMatch(/^attachments\/\d{4}\/\d{2}\//);
    const stored = await readFile(path.join(root, row.storageKey));
    expect(stored.length).toBe(26_214_400);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(body.sha256());
  }, 60_000);

  it("refuses 25 MB + 1 byte with 413, storing nothing", async () => {
    // Declared above the limit: refused without reading the body.
    const declared = call(MB25 + 1);
    expect((await declared.promise).status).toBe(413);
    expect(declared.body.sent()).toBe(0);

    // Declared small but the body keeps coming: cut off while streaming.
    const lying = call(MB25 + 1, { contentLength: "10" });
    const res = await lying.promise;
    expect([413, 400]).toContain(res.status);
    expect(lying.body.sent()).toBeLessThan(MB25 + 1 + CHUNK);

    expect(await rows()).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  }, 60_000);

  it.each(["page.html", "page.htm", "image.svg", "script.js", "noextension", "evil.pdf.html"])(
    "refuses %s with 415",
    async (name) => {
      const { promise, body } = call(100, { fileName: encoded(name) });
      expect((await promise).status).toBe(415);
      expect(body.sent()).toBe(0);
      expect(await rows()).toEqual([]);
      expect(await storedFiles()).toEqual([]);
    },
  );

  it("stores inline images up to 8 MiB and flags the row", async () => {
    const { promise } = call(MB8, { purpose: "inline", fileName: encoded("shot.png") });
    const res = await promise;
    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({ inline: true, mime: "image/png", sizeBytes: MB8 });
  });

  it("refuses an inline image over 8 MiB and a non-image inline file", async () => {
    expect((await call(MB8 + 1, { purpose: "inline", fileName: encoded("shot.png") }).promise).status).toBe(413);
    expect((await call(100, { purpose: "inline", fileName: encoded("a.pdf") }).promise).status).toBe(415);
    expect(await rows()).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  });

  it("refuses without an uploader (401), with a bad purpose (400) and with a bad name (400)", async () => {
    const a = call(10, { uploader: null });
    expect((await a.promise).status).toBe(401);
    expect(a.body.sent()).toBe(0);
    expect((await call(10, { purpose: "x" }).promise).status).toBe(400);
    expect((await call(10, { purpose: null }).promise).status).toBe(400);
    expect((await call(10, { fileName: "%E0%A4%A" }).promise).status).toBe(400);
    expect((await call(10, { fileName: null }).promise).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it("requires a numeric, non-zero Content-Length", async () => {
    for (const contentLength of [null, "abc", "0", "-5", "1.5"]) {
      expect((await call(10, { contentLength }).promise).status).toBe(400);
    }
    expect((await call(10, { body: null }).promise).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it("removes the object and answers 400 when the stored size differs from the declared one", async () => {
    const res = await call(100, { contentLength: "200" }).promise;
    expect(res.status).toBe(400);
    expect(await rows()).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  });

  it("answers 503 and stores no row when the storage fails", async () => {
    const failing: Storage = {
      ...storage,
      putStream: async (_key, body) => {
        body.destroy();
        throw new Error("disk full");
      },
    };
    const res = await receiveUpload(
      { uploader, purpose: "attachment", fileName: encoded("a.pdf"), contentLength: "10", body: generated(10).stream },
      { db, storage: failing },
    );
    expect(res.status).toBe(503);
    expect(await rows()).toEqual([]);
  });

  it("removes the object and rethrows when the row cannot be written", async () => {
    const brokenDb = {
      select: db.select.bind(db),
      insert: () => {
        throw new Error("db down");
      },
    } as unknown as Db;
    await expect(
      receiveUpload(
        { uploader, purpose: "attachment", fileName: encoded("a.pdf"), contentLength: "10", body: generated(10).stream },
        { db: brokenDb, storage },
      ),
    ).rejects.toThrow("db down");
    expect(await storedFiles()).toEqual([]);
  });

  it("records a portal uploader", async () => {
    const portal: Uploader = { type: "client", id: randomUUID() };
    expect((await call(10, { uploader: portal }).promise).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ uploadedByType: "client", uploadedById: portal.id });
  });

  it("sanitizes the stored name", async () => {
    await call(10, { fileName: encoded('../../ev"il<>.pdf') }).promise;
    expect((await rows())[0].name).toBe("evil.pdf");
  });
});

describe("receiveUpload: fiscal documents", () => {
  const staff: Uploader = { type: "agency", id: uploader.id, staff: true };
  const doc = (name: string, size: number, over: Over = {}) => call(size, { uploader: staff, purpose: "document", fileName: encoded(name), ...over });

  it("document uploads accept pdf, png, jpeg and webp up to 8 MB", async () => {
    for (const [name, mime] of [
      ["nf.pdf", "application/pdf"],
      ["nf.png", "image/png"],
      ["nf.jpg", "image/jpeg"],
      ["nf.jpeg", "image/jpeg"],
      ["nf.webp", "image/webp"],
    ] as const) {
      const res = await doc(name, 1000).promise;
      expect(res.status).toBe(200);
      if (res.status === 200) expect(res.body.mime).toBe(mime);
    }
    const exact = await doc("big.pdf", MB8).promise;
    expect(exact.status).toBe(200);
    const stored = await rows();
    expect(stored).toHaveLength(6);
    for (const row of stored) {
      expect(row.storageKey).toMatch(/^documents\/\d{4}\/\d{2}\//);
      expect(row).toMatchObject({ uploadedByType: "agency", inline: false, ticketId: null });
    }

    // Over the limit, other types and other people are refused, storing nothing more.
    const tooBig = doc("big.pdf", MB8 + 1);
    expect((await tooBig.promise).status).toBe(413);
    expect(tooBig.body.sent()).toBe(0);
    expect((await doc("photo.gif", 100).promise).status).toBe(415);
    expect((await doc("notes.txt", 100).promise).status).toBe(415);
    expect((await doc("nf.pdf", 100, { uploader: { type: "agency", id: uploader.id } }).promise).status).toBe(401);
    expect((await doc("nf.pdf", 100, { uploader: { type: "client", id: uploader.id, staff: true } }).promise).status).toBe(401);
    expect((await doc("nf.pdf", 100, { uploader: null }).promise).status).toBe(401);
    expect(await rows()).toHaveLength(6);
  }, 60_000);
});

describe("unclaimed upload limit", () => {
  const MB = 1024 * 1024;

  async function seed(n: number, over: Partial<typeof files.$inferInsert> = {}, who: Uploader = uploader, prefix = "attachments") {
    const rowsToAdd = Array.from({ length: n }, () => ({
      storageKey: `${prefix}/2026/11/${randomUUID()}`,
      name: "a.pdf",
      mime: "application/pdf",
      sizeBytes: 1,
      uploadedByType: who.type,
      uploadedById: who.id,
      ...over,
    }));
    await db.insert(files).values(rowsToAdd);
  }

  it("refuses with 429 once 40 unclaimed files are held, without reading the body", async () => {
    await seed(40);
    const { promise, body } = call(100);
    const res = await promise;
    expect(res).toEqual({ status: 429, body: { error: "too_many_unclaimed" } });
    expect(body.sent()).toBe(0);
    expect(await rows()).toHaveLength(40);
  });

  it("accepts the 40th file (39 held)", async () => {
    await seed(39);
    expect((await call(100).promise).status).toBe(200);
  });

  it("accepts when 40 files are attached to a ticket and none are loose", async () => {
    const [client] = await db.insert(clients).values({ name: "Acme" }).returning();
    const [ticket] = await db
      .insert(tickets)
      .values({ number: 1, clientId: client.id, type: "support", title: "T", createdByType: "agency", createdById: uploader.id })
      .returning();
    await seed(40, { ticketId: ticket.id });
    expect((await call(100).promise).status).toBe(200);
  });

  it("refuses with 429 at 300 MB of unclaimed files", async () => {
    await seed(12, { sizeBytes: 25 * MB });
    const res = await call(100).promise;
    expect(res.status).toBe(429);
  });

  it("accepts just under 300 MB", async () => {
    await seed(11, { sizeBytes: 25 * MB });
    expect((await call(100).promise).status).toBe(200);
  });

  it("does not count other people's files", async () => {
    await seed(40, {}, { type: "client", id: randomUUID() });
    await seed(40, {}, { type: "agency", id: randomUUID() });
    expect((await call(100).promise).status).toBe(200);
  });

  it("does not count files older than 24 hours", async () => {
    await seed(40, { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    expect((await call(100).promise).status).toBe(200);
  });

  it("does not count fiscal documents and does not limit their upload", async () => {
    await seed(40, {}, uploader, "documents");
    expect((await call(100).promise).status).toBe(200);
    await seed(40);
    const doc = call(100, { purpose: "document", fileName: encoded("nf.pdf"), uploader: { ...uploader, staff: true } });
    expect((await doc.promise).status).toBe(200);
  });
});
