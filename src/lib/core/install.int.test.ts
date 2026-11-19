import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { installAgency, type InstallInput } from "./install";

// getConfig() is lazy; give it a database URL and no APP_URL override.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
delete process.env.APP_URL;

let db: Db;

const valid: InstallInput = {
  agencyName: "Studio Acme",
  ownerName: "Ana",
  ownerEmail: " Ana@X.com ",
  password: "correct horse",
  currency: "BRL",
  locale: "pt",
  timeZone: "Europe/Lisbon",
  appUrl: "https://painel.acme.com/",
};

async function count(table: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
  return rows[0].n;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
});

afterAll(async () => {
  await db?.$client.end();
});

describe("installAgency", () => {
  it("creates the agency and an owner with a normalized email", async () => {
    const res = await installAgency(valid, db);
    expect(res.ok).toBe(true);
    const users = await db.execute<{ email: string; role: string; name: string }>(sql`SELECT email, role, name FROM users`);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "ana@x.com", role: "owner", name: "Ana" });
    const ag = await db.execute<{ name: string; currency: string; locale: string; time_zone: string }>(
      sql`SELECT name, currency, locale, time_zone FROM agency`,
    );
    expect(ag[0]).toEqual({ name: "Studio Acme", currency: "BRL", locale: "pt", time_zone: "Europe/Lisbon" });
    const owners = await db.execute<{ locale: string | null }>(sql`SELECT locale FROM users WHERE role = 'owner'`);
    expect(owners[0].locale).toBeNull(); // the agency language applies until the owner picks their own
    const inst = await db.execute<{ app_url: string | null }>(sql`SELECT app_url FROM instance`);
    expect(inst[0].app_url).toBe("https://painel.acme.com");
  });

  it("stores a hashed password, never the plain one", async () => {
    await installAgency(valid, db);
    const rows = await db.execute<{ password_hash: string }>(sql`SELECT password_hash FROM users`);
    expect(rows[0].password_hash).not.toContain("correct horse");
    expect(rows[0].password_hash.startsWith("$2")).toBe(true);
  });

  it("rejects a second install", async () => {
    expect((await installAgency(valid, db)).ok).toBe(true);
    const second = await installAgency({ ...valid, ownerEmail: "other@x.com" }, db);
    expect(second).toEqual({ ok: false, error: "alreadyInstalled" });
    expect(await count("users")).toBe(1);
  });

  it("lets exactly one of two simultaneous installs win", async () => {
    const results = await Promise.all([
      installAgency(valid, db),
      installAgency({ ...valid, ownerEmail: "other@x.com" }, db),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "alreadyInstalled" }]);
    expect(await count("agency")).toBe(1);
    expect(await count("users")).toBe(1);
  });

  it("works when the boot step never created the instance row", async () => {
    await db.execute(sql`DELETE FROM instance`);
    expect((await installAgency(valid, db)).ok).toBe(true);
    expect(await count("instance")).toBe(1);
  });

  it("stores an alias zone in the runtime's own spelling", async () => {
    expect((await installAgency({ ...valid, timeZone: "Asia/Kolkata" }, db)).ok).toBe(true);
    const ag = await db.execute<{ time_zone: string }>(sql`SELECT time_zone FROM agency`);
    expect(ag[0].time_zone).toBe(new Intl.DateTimeFormat("en", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone);
  });

  it("refuses a time zone the runtime does not know, with its own error, and creates nothing", async () => {
    for (const timeZone of ["Mars/Base", "", "+03:00", "x".repeat(5000)]) {
      expect(await installAgency({ ...valid, timeZone }, db)).toEqual({ ok: false, error: "invalidTimeZone" });
    }
    expect(await count("agency")).toBe(0);
  });

  it.each([
    ["short password", { password: "1234567" }],
    ["password over 72 bytes", { password: "é".repeat(37) }],
    ["blank agency name", { agencyName: "   " }],
    ["blank owner name", { ownerName: "" }],
    ["bad email", { ownerEmail: "nope" }],
    ["bad currency", { currency: "GBP" as never }],
    ["bad locale", { locale: "fr" as never }],
    ["bad url", { appUrl: "javascript:x" }],
  ])("rejects %s", async (_label, patch) => {
    const res = await installAgency({ ...valid, ...patch }, db);
    expect(res).toEqual({ ok: false, error: "invalid" });
    expect(await count("agency")).toBe(0);
  });
});
