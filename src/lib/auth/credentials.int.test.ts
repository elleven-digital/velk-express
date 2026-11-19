import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { authTokens, clientMemberships, clientUsers, clients, sessions, users } from "@/lib/db";
import { hashPassword, verifyPassword } from "./password";
import { issueAuthToken, tokenUserType } from "./tokens";
import {
  authenticate,
  authenticateClient,
  completePasswordToken,
  findUserForReset,
  parseSide,
  peekPasswordToken,
  TokenUserMissingError,
  userTypeFor,
} from "./credentials";

let db: Db;
let userId: string;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  const [u] = await db
    .insert(users)
    .values({ name: "Ana", email: "ana@x.com", role: "owner", passwordHash: await hashPassword("old-password") })
    .returning({ id: users.id });
  userId = u.id;
});

afterAll(async () => {
  await db?.$client.end();
});

describe("authenticate", () => {
  it("accepts the right password with a differently cased, padded email", async () => {
    expect((await authenticate("  ANA@x.com ", "old-password", db))?.id).toBe(userId);
  });
  it("refuses a wrong password, an unknown email and a user without password", async () => {
    expect(await authenticate("ana@x.com", "wrong", db)).toBeNull();
    expect(await authenticate("nobody@x.com", "old-password", db)).toBeNull();
    await db.insert(users).values({ name: "Bob", email: "bob@x.com" });
    expect(await authenticate("bob@x.com", "anything", db)).toBeNull();
  });
});

describe("findUserForReset", () => {
  it("finds a team user by normalized email, null otherwise", async () => {
    expect((await findUserForReset("team", " Ana@X.com", db))?.id).toBe(userId);
    expect(await findUserForReset("team", "nobody@x.com", db)).toBeNull();
  });
});

describe("completePasswordToken", () => {
  it("invite: sets password and name, consumes the token", async () => {
    const raw = await issueAuthToken("invite", "agency", userId, db);
    expect((await peekPasswordToken(raw, db))?.purpose).toBe("invite");
    const res = await completePasswordToken({ token: raw, password: "brand-new-pass", name: "Ana Maria" }, db);
    expect(res).toEqual({ userType: "agency", userId });
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.name).toBe("Ana Maria");
    expect(await verifyPassword("brand-new-pass", u.passwordHash!)).toBe(true);
    expect(await completePasswordToken({ token: raw, password: "another-pass-1" }, db)).toBeNull();
    expect(await peekPasswordToken(raw, db)).toBeNull();
  });

  it("reset: changes the password and deletes every session of the user", async () => {
    const other = (await db.insert(users).values({ name: "Z", email: "z@x.com" }).returning({ id: users.id }))[0].id;
    const exp = new Date(Date.now() + 1e9);
    await db.insert(sessions).values([
      { tokenHash: "h1", userType: "agency", userId, expiresAt: exp },
      { tokenHash: "h2", userType: "agency", userId, expiresAt: exp },
      { tokenHash: "h3", userType: "agency", userId: other, expiresAt: exp },
    ]);
    const raw = await issueAuthToken("reset", "agency", userId, db);
    const res = await completePasswordToken({ token: raw, password: "brand-new-pass", name: "Ignored" }, db);
    expect(res).toEqual({ userType: "agency", userId });
    const left = await db.select().from(sessions);
    expect(left.map((s) => s.tokenHash)).toEqual(["h3"]);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.name).toBe("Ana"); // a reset never renames
    expect(await verifyPassword("brand-new-pass", u.passwordHash!)).toBe(true);
  });

  it.each([
    ["invite", "reset"],
    ["reset", "invite"],
  ] as const)("spending a %s link cancels a leftover %s link of the same user", async (spent, leftover) => {
    const first = await issueAuthToken(spent, "agency", userId, db);
    const second = await issueAuthToken(leftover, "agency", userId, db);
    expect(await peekPasswordToken(second, db)).not.toBeNull();
    expect(await completePasswordToken({ token: first, password: "brand-new-pass" }, db)).toEqual({
      userType: "agency",
      userId,
    });
    expect(await peekPasswordToken(second, db)).toBeNull();
    expect(await completePasswordToken({ token: second, password: "attacker-pass-1" }, db)).toBeNull();
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(await verifyPassword("brand-new-pass", u.passwordHash!)).toBe(true);
  });

  it("leaves the unused tokens of other users alone", async () => {
    const other = (await db.insert(users).values({ name: "Z", email: "z@x.com" }).returning({ id: users.id }))[0].id;
    const otherToken = await issueAuthToken("invite", "agency", other, db);
    const raw = await issueAuthToken("reset", "agency", userId, db);
    await completePasswordToken({ token: raw, password: "brand-new-pass" }, db);
    expect(await peekPasswordToken(otherToken, db)).not.toBeNull();
  });

  it("never hashes the password for an unknown, used or expired token", async () => {
    const hash = vi.fn(async () => "hash");
    expect(await completePasswordToken({ token: "bogus", password: "brand-new-pass" }, db, hash)).toBeNull();
    const used = await issueAuthToken("reset", "agency", userId, db);
    expect(await completePasswordToken({ token: used, password: "brand-new-pass" }, db)).not.toBeNull();
    expect(await completePasswordToken({ token: used, password: "brand-new-pass" }, db, hash)).toBeNull();
    const expired = await issueAuthToken("reset", "agency", userId, db);
    await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await completePasswordToken({ token: expired, password: "brand-new-pass" }, db, hash)).toBeNull();
    expect(hash).not.toHaveBeenCalled();
  });

  it("hashes once for a valid token", async () => {
    const hash = vi.fn(async () => "custom-hash");
    const raw = await issueAuthToken("reset", "agency", userId, db);
    expect(await completePasswordToken({ token: raw, password: "brand-new-pass" }, db, hash)).not.toBeNull();
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it("a failed token changes nothing", async () => {
    expect(await completePasswordToken({ token: "bogus", password: "brand-new-pass" }, db)).toBeNull();
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(await verifyPassword("old-password", u.passwordHash!)).toBe(true);
    expect(await db.select().from(authTokens)).toHaveLength(0);
  });
});

describe("sides", () => {
  it("parseSide is portal only for exactly portal", () => {
    expect(parseSide("portal")).toBe("portal");
    for (const v of ["team", "Portal", "", null, undefined, 3, ["portal"]]) expect(parseSide(v)).toBe("team");
    expect(userTypeFor("portal")).toBe("client");
    expect(userTypeFor("team")).toBe("agency");
  });
});

describe("portal credentials", () => {
  let clientUserId: string;
  beforeEach(async () => {
    const [p] = await db
      .insert(clientUsers)
      .values({ name: "Ana", email: "ana@x.com", passwordHash: await hashPassword("old-password") })
      .returning({ id: clientUsers.id });
    clientUserId = p.id;
    const [c] = await db.insert(clients).values({ name: "Acme" }).returning({ id: clients.id });
    await db.insert(clientMemberships).values({ clientUserId: p.id, clientId: c.id, role: "admin" });
  });

  it("authenticateClient refuses a login with no company", async () => {
    await db.delete(clientMemberships);
    expect(await authenticateClient("ana@x.com", "old-password", db)).toBeNull();
  });

  it("authenticateClient finds the portal person; the sides never cross", async () => {
    expect((await authenticateClient(" ANA@x.com ", "old-password", db))?.id).toBe(clientUserId);
    expect(await authenticateClient("ana@x.com", "wrong", db)).toBeNull();
    expect(await authenticateClient("nobody@x.com", "old-password", db)).toBeNull();
    // The team user ana@x.com has the same email and password as the portal person.
    await db.update(clientUsers).set({ email: "only-portal@x.com" });
    expect(await authenticateClient("ana@x.com", "old-password", db)).toBeNull(); // team user is not accepted
    expect(await authenticate("only-portal@x.com", "old-password", db)).toBeNull(); // portal person is not accepted
  });

  it("findUserForReset resolves per side", async () => {
    const portal = await findUserForReset("portal", "ana@x.com", db);
    expect(portal).toMatchObject({ userType: "client", id: clientUserId, email: "ana@x.com", name: "Ana" });
    await db.update(clientUsers).set({ email: "only-portal@x.com" });
    expect(await findUserForReset("team", "only-portal@x.com", db)).toBeNull();
    expect(await findUserForReset("portal", "ana@x.com", db)).toBeNull();
    expect((await findUserForReset("team", "ana@x.com", db))?.userType).toBe("agency");
  });

  it("peek: a client invite names the person; a token whose user is on the other side is invalid", async () => {
    const raw = await issueAuthToken("invite", "client", clientUserId, db);
    expect(await peekPasswordToken(raw, db)).toMatchObject({ userType: "client", purpose: "invite", name: "Ana" });
    // A client token pointing at an id that only exists in users.
    const crossed = await issueAuthToken("invite", "client", userId, db);
    expect(await peekPasswordToken(crossed, db)).toBeNull();
    expect(await completePasswordToken({ token: crossed, password: "attacker-pass-1" }, db)).toBeNull();
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(await verifyPassword("old-password", u.passwordHash!)).toBe(true);
    const [t] = await db.select().from(authTokens).where(eq(authTokens.userId, userId));
    expect(t.usedAt).toBeNull();
  });

  it("client invite sets password and name in client_users and spends the token", async () => {
    const raw = await issueAuthToken("invite", "client", clientUserId, db);
    const res = await completePasswordToken({ token: raw, password: "brand-new-pass", name: "Ana Maria" }, db);
    expect(res).toEqual({ userType: "client", userId: clientUserId });
    const [p] = await db.select().from(clientUsers).where(eq(clientUsers.id, clientUserId));
    expect(p.name).toBe("Ana Maria");
    expect(await verifyPassword("brand-new-pass", p.passwordHash!)).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(await verifyPassword("old-password", u.passwordHash!)).toBe(true);
    expect(await peekPasswordToken(raw, db)).toBeNull();
  });

  it("client reset deletes that person's client sessions and keeps a team session with another id type", async () => {
    const exp = new Date(Date.now() + 1e9);
    await db.insert(sessions).values([
      { tokenHash: "c1", userType: "client", userId: clientUserId, expiresAt: exp },
      { tokenHash: "a1", userType: "agency", userId, expiresAt: exp },
    ]);
    const raw = await issueAuthToken("reset", "client", clientUserId, db);
    await completePasswordToken({ token: raw, password: "brand-new-pass", name: "Ignored" }, db);
    expect((await db.select().from(sessions)).map((s) => s.tokenHash)).toEqual(["a1"]);
    const [p] = await db.select().from(clientUsers).where(eq(clientUsers.id, clientUserId));
    expect(p.name).toBe("Ana");
  });

  it("completing a client token cancels only that person's other tokens, not a team token", async () => {
    const teamToken = await issueAuthToken("reset", "agency", userId, db);
    const leftover = await issueAuthToken("reset", "client", clientUserId, db);
    const raw = await issueAuthToken("invite", "client", clientUserId, db);
    await completePasswordToken({ token: raw, password: "brand-new-pass" }, db);
    expect(await peekPasswordToken(leftover, db)).toBeNull();
    expect(await peekPasswordToken(teamToken, db)).not.toBeNull();
  });

  it("a user deleted between the check and the transaction throws and leaves the token usable", async () => {
    const raw = await issueAuthToken("invite", "client", clientUserId, db);
    const hash = vi.fn(async () => {
      await db.delete(clientUsers).where(eq(clientUsers.id, clientUserId));
      return "hash";
    });
    await expect(completePasswordToken({ token: raw, password: "brand-new-pass" }, db, hash)).rejects.toBeInstanceOf(
      TokenUserMissingError,
    );
    const [t] = await db.select().from(authTokens).where(eq(authTokens.userId, clientUserId));
    expect(t.usedAt).toBeNull();
  });

  it("tokenUserType reads the side of any token, valid or not, and null for unknown", async () => {
    const c = await issueAuthToken("invite", "client", clientUserId, db);
    const a = await issueAuthToken("reset", "agency", userId, db);
    expect(await tokenUserType(c, db)).toBe("client");
    expect(await tokenUserType(a, db)).toBe("agency");
    await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000), usedAt: new Date() });
    expect(await peekPasswordToken(c, db)).toBeNull();
    expect(await tokenUserType(c, db)).toBe("client");
    expect(await tokenUserType(a, db)).toBe("agency");
    expect(await tokenUserType("bogus", db)).toBeNull();
  });

  it("the same holds on the team side", async () => {
    const raw = await issueAuthToken("reset", "agency", userId, db);
    const hash = vi.fn(async () => {
      await db.delete(users).where(eq(users.id, userId));
      return "hash";
    });
    await expect(completePasswordToken({ token: raw, password: "brand-new-pass" }, db, hash)).rejects.toBeInstanceOf(
      TokenUserMissingError,
    );
    const [t] = await db.select().from(authTokens).where(eq(authTokens.userId, userId));
    expect(t.usedAt).toBeNull();
  });
});

describe("completePasswordToken lock order", () => {
  it("waits for the user's row before spending the token, so a link or resend holding that row cannot deadlock with it", async () => {
    const [person] = await db.insert(clientUsers).values({ name: "Pen", email: "pen@x.com" }).returning({ id: clientUsers.id });
    const raw = await issueAuthToken("invite", "client", person.id, db);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    // What linking or resending does: lock the person's row first, then touch the tokens.
    const linker = db.transaction(async (tx) => {
      await tx.select().from(clientUsers).where(eq(clientUsers.id, person.id)).for("update");
      locked();
      await held;
      await tx.delete(authTokens).where(eq(authTokens.userId, person.id));
    });
    await hasLock;
    const completing = completePasswordToken({ token: raw, password: "brand-new-pass" }, db);
    // Give the completion time to reach the row lock (it must not have consumed the token yet).
    await new Promise((r) => setTimeout(r, 300));
    release();
    await linker;
    // No deadlock: the link revoked the token first, so the completion finds nothing to spend.
    expect(await completing).toBeNull();
    const [after] = await db.select().from(clientUsers).where(eq(clientUsers.id, person.id));
    expect(after.passwordHash).toBeNull();
  });
});
