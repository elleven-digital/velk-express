import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { agency, charges, clients, files, tickets } from "@/lib/db/schema";
import { diskStorage, type Storage } from "@/lib/storage";
import { sweepOrphans, sweepStaleTemps } from "./orphans";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let root: string;
let storage: Storage;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  if (db) await db.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
  db = await resetTestDb();
  root = await mkdtemp(path.join(tmpdir(), "velk-orphans-"));
  storage = diskStorage(root);
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
});

afterAll(async () => {
  await db?.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function addFile(ageMs: number, extra: Partial<typeof files.$inferInsert> = {}) {
  const key = extra.storageKey ?? `attachments/2026/11/${randomUUID()}`;
  await storage.put(key, Buffer.from("x"), "application/pdf");
  const [row] = await db
    .insert(files)
    .values({
      storageKey: key,
      name: "a.pdf",
      mime: "application/pdf",
      sizeBytes: 1,
      uploadedByType: "agency",
      uploadedById: randomUUID(),
      ...extra,
    })
    .returning({ id: files.id });
  await db.execute(sql`update files set created_at = now() - ${ageMs / 1000} * interval '1 second' where id = ${row.id}`);
  return { id: row.id, key };
}

const rowExists = async (id: string) => (await db.select({ id: files.id }).from(files).where(eq(files.id, id))).length === 1;
const blobExists = async (key: string) => (await storage.get(key)) !== null;

describe("sweepOrphans", () => {
  it("only sweeps uploads stored under attachments/", async () => {
    const upload = await addFile(25 * 60 * 60 * 1000);
    const other = await addFile(25 * 60 * 60 * 1000, { storageKey: `invoices/2026/11/${randomUUID()}` });
    expect(await sweepOrphans({ db, storage })).toEqual({ files: 1, temps: 0 });
    expect(await rowExists(upload.id)).toBe(false);
    expect(await rowExists(other.id)).toBe(true);
  });

  it("sweeps stale fiscal documents that no charge references", async () => {
    const day = 25 * 60 * 60 * 1000;
    const doc = (extra: Partial<typeof files.$inferInsert> = {}) => addFile(day, { storageKey: `documents/2026/11/${randomUUID()}`, ...extra });
    const stray = await doc();
    const fresh = await addFile(60 * 60 * 1000, { storageKey: `documents/2026/11/${randomUUID()}` });
    const held = await doc();
    await db.insert(charges).values({
      source: "none",
      kind: "one_time",
      status: "paid",
      label: "Hosting",
      amountCents: 1000,
      currency: "BRL",
      payToken: "tok-doc",
      documentFileId: held.id,
    });
    expect(await sweepOrphans({ db, storage })).toEqual({ files: 1, temps: 0 });
    expect(await rowExists(stray.id)).toBe(false);
    expect(await blobExists(stray.key)).toBe(false);
    for (const f of [fresh, held]) {
      expect(await rowExists(f.id)).toBe(true);
      expect(await blobExists(f.key)).toBe(true);
    }
  });

  it("removes unattached files older than a day, with their objects, and keeps the rest", async () => {
    const [client] = await db.insert(clients).values({ name: "Acme" }).returning();
    const [ticket] = await db
      .insert(tickets)
      .values({ number: 1, clientId: client.id, type: "support", title: "T", createdByType: "agency", createdById: randomUUID() })
      .returning();
    const stale = await addFile(25 * 60 * 60 * 1000);
    const staleInline = await addFile(30 * 60 * 60 * 1000, { inline: true });
    const fresh = await addFile(2 * 60 * 60 * 1000);
    const attachedOld = await addFile(40 * 60 * 60 * 1000, { ticketId: ticket.id });
    const logo = await addFile(40 * 60 * 60 * 1000);
    await db.update(agency).set({ logoFileId: logo.id });

    const result = await sweepOrphans({ db, storage });
    expect(result).toEqual({ files: 2, temps: 0 });
    for (const f of [stale, staleInline]) {
      expect(await rowExists(f.id)).toBe(false);
      expect(await blobExists(f.key)).toBe(false);
    }
    for (const f of [fresh, attachedOld, logo]) {
      expect(await rowExists(f.id)).toBe(true);
      expect(await blobExists(f.key)).toBe(true);
    }
  });

  it("skips stale rows another transaction holds and sweeps the others", async () => {
    const day = 25 * 60 * 60 * 1000;
    const claiming = await addFile(day);
    const claimingDoc = await addFile(day, { storageKey: `documents/2026/11/${randomUUID()}` });
    const stray = await addFile(day);
    const strayDoc = await addFile(day, { storageKey: `documents/2026/11/${randomUUID()}` });

    // A claim in progress: the rows are locked and not attached yet.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => (markLocked = resolve));
    const claim = db.transaction(async (tx) => {
      await tx.select({ id: files.id }).from(files).where(inArray(files.id, [claiming.id, claimingDoc.id])).for("update");
      markLocked();
      await released;
    });
    await locked;
    try {
      expect(await sweepOrphans({ db, storage })).toEqual({ files: 2, temps: 0 });
    } finally {
      release();
      await claim;
    }
    for (const f of [stray, strayDoc]) {
      expect(await rowExists(f.id)).toBe(false);
      expect(await blobExists(f.key)).toBe(false);
    }
    for (const f of [claiming, claimingDoc]) {
      expect(await rowExists(f.id)).toBe(true);
      expect(await blobExists(f.key)).toBe(true);
    }
  });

  it("removes stale *.tmp files under the disk root and only those", async () => {
    const dir = path.join(root, "attachments", "2026", "11");
    await mkdir(dir, { recursive: true });
    const old = path.join(dir, "x.abc12345.tmp");
    const young = path.join(dir, "y.abc12345.tmp");
    const real = path.join(dir, "keep.pdf");
    for (const f of [old, young, real]) await writeFile(f, "z");
    const past = new Date(Date.now() - 2 * DAY);
    await utimes(old, past, past);
    await utimes(real, past, past);

    const result = await sweepOrphans({ db, storage, diskRoot: root });
    expect(result.temps).toBe(1);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(young)).resolves.toBeTruthy();
    await expect(stat(real)).resolves.toBeTruthy();
  });

  it("a missing disk root is fine", async () => {
    expect(await sweepStaleTemps(path.join(root, "nope"), DAY)).toBe(0);
  });
});
