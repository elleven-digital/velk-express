import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { users } from "@/lib/db";
import { TOKEN_TTL, consumeAuthToken, issueAuthToken, peekAuthToken } from "./tokens";

let db: Db;
let userId: string;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  const [u] = await db.insert(users).values({ name: "Ana", email: "ana@x.com" }).returning({ id: users.id });
  userId = u.id;
});

afterAll(async () => {
  await db?.$client.end();
});

describe("auth tokens", () => {
  it("is consumed once, then returns null", async () => {
    const raw = await issueAuthToken("invite", "agency", userId, db);
    expect(await consumeAuthToken(raw, "invite", db)).toEqual({ userType: "agency", userId });
    expect(await consumeAuthToken(raw, "invite", db)).toBeNull();
  });

  it("stores only a hash of the token", async () => {
    const raw = await issueAuthToken("reset", "agency", userId, db);
    const rows = await db.execute<{ token_hash: string }>(sql`SELECT token_hash FROM auth_tokens`);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(raw);
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null for an expired token", async () => {
    const raw = await issueAuthToken("reset", "agency", userId, db);
    await db.execute(sql`UPDATE auth_tokens SET expires_at = now() - interval '1 second'`);
    expect(await peekAuthToken(raw, "reset", db)).toBeNull();
    expect(await consumeAuthToken(raw, "reset", db)).toBeNull();
  });

  it("returns null for an unknown token or the wrong purpose", async () => {
    const raw = await issueAuthToken("reset", "agency", userId, db);
    expect(await consumeAuthToken("nope", "reset", db)).toBeNull();
    expect(await consumeAuthToken(raw, "invite", db)).toBeNull();
    expect(await consumeAuthToken(raw, "reset", db)).not.toBeNull();
  });

  it("a second reset invalidates the first", async () => {
    const first = await issueAuthToken("reset", "agency", userId, db);
    const second = await issueAuthToken("reset", "agency", userId, db);
    expect(await consumeAuthToken(first, "reset", db)).toBeNull();
    expect(await consumeAuthToken(second, "reset", db)).toEqual({ userType: "agency", userId });
  });

  it("keeps an invite when a reset is issued", async () => {
    const invite = await issueAuthToken("invite", "agency", userId, db);
    await issueAuthToken("reset", "agency", userId, db);
    expect(await peekAuthToken(invite, "invite", db)).not.toBeNull();
  });

  it("peek does not consume", async () => {
    const raw = await issueAuthToken("invite", "agency", userId, db);
    expect(await peekAuthToken(raw, "invite", db)).toEqual({ userType: "agency", userId });
    expect(await peekAuthToken(raw, "invite", db)).not.toBeNull();
    expect(await consumeAuthToken(raw, "invite", db)).not.toBeNull();
    expect(await peekAuthToken(raw, "invite", db)).toBeNull();
  });

  it("has the agreed lifetimes", () => {
    expect(TOKEN_TTL.invite).toBe(7 * 24 * 3600_000);
    expect(TOKEN_TTL.reset).toBe(2 * 3600_000);
  });
});
