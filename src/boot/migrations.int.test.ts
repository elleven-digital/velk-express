import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { emptyTestDb } from "@/test/db";
import { countPendingMigrations, runMigrations } from "./migrations";

const folder = path.join(process.cwd(), "drizzle");
const journalSize = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")).entries.length;

let db: Db;
afterAll(async () => {
  await db?.$client.end();
});

describe("migrations", () => {
  it("reports every migration pending on an empty database, then none after running", async () => {
    db = await emptyTestDb();
    expect(await countPendingMigrations(db, folder)).toBe(journalSize);

    await runMigrations(db, folder);

    expect(await countPendingMigrations(db, folder)).toBe(0);
  });
});
