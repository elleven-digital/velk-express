import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import { agency, files, type Db } from "@/lib/db";
import { diskStorage, type Storage } from "@/lib/storage";
import { maybeSweepOrphans, resetSweepThrottle } from "./file-cleanup";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let root: string;
let storage: Storage;

beforeEach(async () => {
  if (db) await db.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
  db = await resetTestDb();
  root = await mkdtemp(path.join(tmpdir(), "velk-cleanup-"));
  storage = diskStorage(root);
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  resetSweepThrottle();
});

afterAll(async () => {
  await db?.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function staleFile() {
  const key = `attachments/${randomUUID()}`;
  await storage.put(key, Buffer.from("x"), "application/pdf");
  const [row] = await db
    .insert(files)
    .values({ storageKey: key, name: "a.pdf", mime: "application/pdf", sizeBytes: 1, uploadedByType: "agency", uploadedById: randomUUID() })
    .returning({ id: files.id });
  await db.execute(sql`update files set created_at = now() - interval '2 days' where id = ${row.id}`);
  return row.id;
}

const wait = () => new Promise((r) => setTimeout(r, 300));
const exists = async (id: string) => (await db.select({ id: files.id }).from(files).where(eq(files.id, id))).length === 1;

describe("maybeSweepOrphans", () => {
  it("runs once, then not again within the hour", async () => {
    const first = await staleFile();
    maybeSweepOrphans({ db, storage });
    await wait();
    expect(await exists(first)).toBe(false);

    const second = await staleFile();
    maybeSweepOrphans({ db, storage });
    await wait();
    expect(await exists(second)).toBe(true);

    // An hour later it runs again.
    maybeSweepOrphans({ db, storage, now: Date.now() + 61 * 60 * 1000 });
    await wait();
    expect(await exists(second)).toBe(false);
  });
});
