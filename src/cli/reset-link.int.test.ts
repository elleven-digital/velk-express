import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { clientUsers, instance, users } from "@/lib/db";
import { completePasswordToken } from "@/lib/auth/credentials";
import { issueAuthToken } from "@/lib/auth/tokens";
import { createResetLink } from "./reset-link";

let db: Db;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(instance).values({ id: 1, secretKey: "k", appUrl: "https://saved.example" });
  await db.insert(users).values({ name: "Owner", email: "owner@x.com", role: "owner" });
  await db.insert(clientUsers).values({ name: "Portal", email: "portal@x.com" });
});

afterAll(async () => {
  await db?.$client.end();
});

function tokenOf(link: string): string {
  return link.split("/set-password/")[1];
}

describe("createResetLink", () => {
  it("issues a link a team user can redeem with completePasswordToken", async () => {
    const res = await createResetLink(db, "  Owner@X.com ", "https://app.example");
    if (!res.ok) throw new Error("expected ok");
    expect(res.link).toMatch(/^https:\/\/app\.example\/set-password\/[0-9a-f]{64}$/);
    expect(res.absolute).toBe(true);
    const owner = await completePasswordToken({ token: tokenOf(res.link), password: "a-new-password-1" }, db);
    expect(owner?.userType).toBe("agency");
  });

  it("cancels the user's earlier reset links", async () => {
    const [u] = await db.select().from(users);
    const old = await issueAuthToken("reset", "agency", u.id, db);
    const res = await createResetLink(db, "owner@x.com", null);
    if (!res.ok) throw new Error("expected ok");
    expect(await completePasswordToken({ token: old, password: "a-new-password-1" }, db)).toBeNull();
    expect(await completePasswordToken({ token: tokenOf(res.link), password: "a-new-password-1" }, db)).not.toBeNull();
  });

  it("falls back to the address saved at install, then to the bare path", async () => {
    const saved = await createResetLink(db, "owner@x.com", null);
    if (!saved.ok) throw new Error("expected ok");
    expect(saved.link.startsWith("https://saved.example/set-password/")).toBe(true);

    await db.update(instance).set({ appUrl: null });
    const bare = await createResetLink(db, "owner@x.com", null);
    if (!bare.ok) throw new Error("expected ok");
    expect(bare.absolute).toBe(false);
    expect(bare.link.startsWith("/set-password/")).toBe(true);
  });

  it("refuses a portal user's email", async () => {
    expect(await createResetLink(db, "portal@x.com", null)).toEqual({ ok: false, reason: "notFound" });
  });

  it("refuses an unknown or empty email", async () => {
    expect(await createResetLink(db, "nobody@x.com", null)).toEqual({ ok: false, reason: "notFound" });
    expect(await createResetLink(db, "  ", null)).toEqual({ ok: false, reason: "invalidEmail" });
  });
});
