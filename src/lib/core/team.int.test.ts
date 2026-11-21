import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { agency, authTokens, autoAssignUsers, clientAssignments, clients, quotes, sessions, users, type User } from "@/lib/db";
import { peekPasswordToken, completePasswordToken } from "@/lib/auth/credentials";
import { hashPassword } from "@/lib/auth/password";
import { createSession, resolveTeamSession, TEAM_COOKIE, type CookieStore } from "@/lib/auth/session";
import { issueAuthToken } from "@/lib/auth/tokens";
import type { TeamSession } from "@/lib/auth/session";
import { changeRole, createResetLink, inviteMember, listMembers, removeMember, resendInvite } from "./team";

// getConfig() is lazy: a database URL, a fixed public address and no SMTP.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";
delete process.env.SMTP_HOST;
delete process.env.MAIL_FROM;

let db: Db;
let owner: TeamSession;
let manager: TeamSession;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

async function makeUser(values: { name: string; email: string; role?: User["role"]; password?: boolean }): Promise<User> {
  const [u] = await db
    .insert(users)
    .values({
      name: values.name,
      email: values.email,
      role: values.role ?? "collaborator",
      passwordHash: values.password === false ? null : await hashPassword("some-password"),
    })
    .returning();
  return u;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  owner = asTeam(await makeUser({ name: "Ana", email: "ana@x.com", role: "owner" }));
  manager = asTeam(await makeUser({ name: "Mo", email: "mo@x.com", role: "manager" }));
});

afterAll(async () => {
  await db?.$client.end();
});

const send = (sent: boolean) => vi.fn(async () => ({ sent }));

describe("inviteMember", () => {
  it("creates a pending user, returns the link and reports no mail without SMTP", async () => {
    const res = await inviteMember(owner, { name: " Bia ", email: " Bia@X.com ", role: "collaborator" }, { db });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.emailed).toBe(false);
    expect(res.value.link.startsWith("https://painel.acme.com/set-password/")).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.id, res.value.userId));
    expect(u).toMatchObject({ name: "Bia", email: "bia@x.com", role: "collaborator", passwordHash: null });
    const token = res.value.link.split("/").pop()!;
    expect((await peekPasswordToken(token, db))?.purpose).toBe("invite");
  });

  it("e-mails the invite with the link when mail works", async () => {
    const mail = send(true);
    const res = await inviteMember(owner, { name: "Bia", email: "bia@x.com", role: "manager" }, { db, send: mail });
    expect(res.ok && res.value.emailed).toBe(true);
    expect(mail).toHaveBeenCalledTimes(1);
    const msg = (mail.mock.calls[0] as unknown as [{ to: string; html: string; subject: string }])[0];
    expect(msg.to).toBe("bia@x.com");
    expect(msg.subject).toContain("Studio Acme");
    expect(res.ok && msg.html.includes(res.value.link)).toBe(true);
  });

  it("is forbidden for a manager", async () => {
    const res = await inviteMember(manager, { name: "Bia", email: "bia@x.com", role: "collaborator" }, { db });
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(await db.select().from(users)).toHaveLength(2);
  });

  it("refuses an email that exists, whatever its case", async () => {
    await makeUser({ name: "Bia", email: "bia@x.com" });
    const res = await inviteMember(owner, { name: "Bia 2", email: "Bia@X.com", role: "collaborator" }, { db });
    expect(res).toEqual({ ok: false, error: "emailTaken" });
  });

  it.each([
    ["blank name", { name: "  " }],
    ["long name", { name: "x".repeat(121) }],
    ["bad email", { email: "nope" }],
    ["bad role", { role: "admin" as never }],
  ])("rejects %s", async (_label, patch) => {
    const res = await inviteMember(owner, { name: "Bia", email: "bia@x.com", role: "collaborator", ...patch }, { db });
    expect(res).toEqual({ ok: false, error: "invalid" });
  });
});

describe("resendInvite", () => {
  it("replaces the old link with a fresh one for a pending user", async () => {
    const invited = await inviteMember(owner, { name: "Bia", email: "bia@x.com", role: "collaborator" }, { db });
    if (!invited.ok) throw new Error("invite failed");
    const mail = send(true);
    const res = await resendInvite(owner, invited.value.userId, { db, send: mail });
    expect(res.ok && res.value.emailed).toBe(true);
    if (!res.ok) return;
    expect(await peekPasswordToken(invited.value.link.split("/").pop()!, db)).toBeNull();
    expect((await peekPasswordToken(res.value.link.split("/").pop()!, db))?.purpose).toBe("invite");
  });

  it("only works for users without a password", async () => {
    const res = await resendInvite(owner, manager.user.id, { db });
    expect(res).toEqual({ ok: false, error: "invalid" });
  });

  it("is forbidden for a manager and notFound for a stranger", async () => {
    expect(await resendInvite(manager, owner.user.id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await resendInvite(owner, crypto.randomUUID(), { db })).toEqual({ ok: false, error: "notFound" });
    expect(await resendInvite(owner, "not-a-uuid", { db })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("createResetLink", () => {
  it("issues a working reset link for a member with a password", async () => {
    const res = await createResetLink(owner, manager.user.id, { db });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.link.startsWith("https://painel.acme.com/set-password/")).toBe(true);
    const token = res.value.link.split("/").pop()!;
    expect((await peekPasswordToken(token, db))?.purpose).toBe("reset");
    expect(await completePasswordToken({ token, password: "fresh-password-1" }, db)).toEqual({
      userType: "agency",
      userId: manager.user.id,
    });
  });

  it("refuses a pending member (that one needs an invite) and a manager caller", async () => {
    const pending = await makeUser({ name: "Bia", email: "bia@x.com", password: false });
    expect(await createResetLink(owner, pending.id, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await createResetLink(manager, owner.user.id, { db })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("pending owners", () => {
  it("do not count as the last active owner", async () => {
    const pending = await makeUser({ name: "Pat", email: "pat@x.com", role: "owner", password: false });
    expect(await changeRole(owner, owner.user.id, "manager", { db })).toEqual({ ok: false, error: "lastOwner" });
    // the user holding no password can still be demoted or removed
    expect((await changeRole(owner, pending.id, "manager", { db })).ok).toBe(true);
    const pending2 = await makeUser({ name: "Quin", email: "quin@x.com", role: "owner", password: false });
    expect((await removeMember(owner, pending2.id, { db })).ok).toBe(true);
  });

  it("an active second owner lets the first step down", async () => {
    const second = asTeam(await makeUser({ name: "Sam", email: "sam@x.com", role: "owner" }));
    expect((await changeRole(second, owner.user.id, "manager", { db })).ok).toBe(true);
  });
});

describe("changeRole", () => {
  it("refuses to demote the only owner", async () => {
    expect(await changeRole(owner, owner.user.id, "manager", { db })).toEqual({ ok: false, error: "lastOwner" });
    const [u] = await db.select().from(users).where(eq(users.id, owner.user.id));
    expect(u.role).toBe("owner");
  });

  it("lets an owner demote another owner, and promote a member", async () => {
    expect((await changeRole(owner, manager.user.id, "owner", { db })).ok).toBe(true);
    expect((await changeRole(owner, manager.user.id, "collaborator", { db })).ok).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.id, manager.user.id));
    expect(u.role).toBe("collaborator");
  });

  it("is forbidden for a manager, invalid for an unknown role, notFound for a stranger", async () => {
    expect(await changeRole(manager, owner.user.id, "collaborator", { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await changeRole(owner, manager.user.id, "admin" as never, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await changeRole(owner, crypto.randomUUID(), "manager", { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("takes effect on the member's next request (the session reads the user fresh)", async () => {
    const jar = new Map<string, string>();
    const store: CookieStore = {
      get: (n) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
      set: (n, v) => void jar.set(n, v),
      delete: (n) => void jar.delete(n),
    };
    await createSession("agency", manager.user.id, { store, db, secure: false });
    const token = jar.get(TEAM_COOKIE);
    expect((await resolveTeamSession(token, db))?.user.role).toBe("manager");
    await changeRole(owner, manager.user.id, "collaborator", { db });
    expect((await resolveTeamSession(token, db))?.user.role).toBe("collaborator");
  });
});

describe("removeMember", () => {
  it("refuses to remove yourself", async () => {
    expect(await removeMember(owner, owner.user.id, { db })).toEqual({ ok: false, error: "self" });
    expect(await db.select().from(users)).toHaveLength(2);
  });

  it("removing a quote's creator waits for the quote lock and then clears created_by_id", async () => {
    const [quote] = await db
      .insert(quotes)
      .values({ title: "Q", token: "tok-team", currency: "BRL", prospectName: "P", createdById: manager.user.id })
      .returning();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, quote.id)).for("update");
      locked();
      await held;
    });
    await lockTaken;
    let done = false;
    const removal = removeMember(owner, manager.user.id, { db }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect((await removal).ok).toBe(true);
    const [after] = await db.select().from(quotes).where(eq(quotes.id, quote.id));
    expect(after.createdById).toBeNull();
  });

  it("deletes the member with their sessions and tokens, keeping other people's", async () => {
    const exp = new Date(Date.now() + 1e9);
    await db.insert(sessions).values([
      { tokenHash: "m1", userType: "agency", userId: manager.user.id, expiresAt: exp },
      { tokenHash: "m2", userType: "agency", userId: manager.user.id, expiresAt: exp },
      { tokenHash: "o1", userType: "agency", userId: owner.user.id, expiresAt: exp },
    ]);
    await issueAuthToken("reset", "agency", manager.user.id, db);
    const keep = await issueAuthToken("reset", "agency", owner.user.id, db);

    expect((await removeMember(owner, manager.user.id, { db })).ok).toBe(true);

    expect((await db.select().from(sessions)).map((s) => s.tokenHash)).toEqual(["o1"]);
    expect(await db.select().from(authTokens)).toHaveLength(1);
    expect(await peekPasswordToken(keep, db)).not.toBeNull();
    expect((await db.select().from(users)).map((u) => u.id)).toEqual([owner.user.id]);
  });

  it("removeMember deletes only agency sessions", async () => {
    const exp = new Date(Date.now() + 1e9);
    await db.insert(sessions).values([
      { tokenHash: "agency-s", userType: "agency", userId: manager.user.id, expiresAt: exp },
      { tokenHash: "client-s", userType: "client", userId: manager.user.id, expiresAt: exp },
    ]);
    expect((await removeMember(owner, manager.user.id, { db })).ok).toBe(true);
    expect((await db.select().from(sessions)).map((s) => s.tokenHash)).toEqual(["client-s"]);
  });

  it("removeMember turns off rotations left empty", async () => {
    const n = await makeUser({ name: "Nina", email: "nina@x.com" });
    const m = manager.user.id;
    const [c1, c2] = await db.insert(clients).values([{ name: "One" }, { name: "Two" }]).returning({ id: clients.id });
    await db.insert(clientAssignments).values([
      { clientId: c1.id, userId: m },
      { clientId: c2.id, userId: m },
      { clientId: c2.id, userId: n.id },
    ]);
    await db.insert(autoAssignUsers).values([
      { clientId: c1.id, userId: m },
      { clientId: c2.id, userId: m },
      { clientId: c2.id, userId: n.id },
      { clientId: null, userId: m },
    ]);
    await db.update(clients).set({ autoAssign: true, autoAssignLastUserId: m });
    await db.update(agency).set({ autoAssign: true, autoAssignLastUserId: m });

    expect((await removeMember(owner, m, { db })).ok).toBe(true);

    const rows = await db.select().from(clients);
    const one = rows.find((c) => c.id === c1.id)!;
    const two = rows.find((c) => c.id === c2.id)!;
    expect(one).toMatchObject({ autoAssign: false, autoAssignLastUserId: null });
    expect(two).toMatchObject({ autoAssign: true, autoAssignLastUserId: null });
    expect((await db.select().from(autoAssignUsers).where(eq(autoAssignUsers.clientId, c2.id))).map((r) => r.userId)).toEqual([n.id]);
    const [ag] = await db.select().from(agency);
    expect(ag).toMatchObject({ autoAssign: false, autoAssignLastUserId: null });
  });

  it("removeMember turns off a rotation that was only the member, whatever its pointer", async () => {
    const n = await makeUser({ name: "Nina", email: "nina@x.com" });
    const m = manager.user.id;
    const [c] = await db.insert(clients).values({ name: "Solo" }).returning({ id: clients.id });
    await db.insert(clientAssignments).values({ clientId: c.id, userId: m });
    await db.insert(autoAssignUsers).values({ clientId: c.id, userId: m });
    await db.update(clients).set({ autoAssign: true, autoAssignLastUserId: n.id }).where(eq(clients.id, c.id));
    expect((await removeMember(owner, m, { db })).ok).toBe(true);
    const [row] = await db.select().from(clients).where(eq(clients.id, c.id));
    expect(row).toMatchObject({ autoAssign: false, autoAssignLastUserId: null });
  });

  const isDeadlock = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" &&
    ((r.reason as { code?: string })?.code === "40P01" || (r.reason as { cause?: { code?: string } })?.cause?.code === "40P01");

  it("removeMember and completePasswordToken at the same time never deadlock", async () => {
    for (let round = 0; round < 20; round++) {
      const m = await makeUser({ name: `M${round}`, email: `m${round}@x.com` });
      const raw = await issueAuthToken("reset", "agency", m.id, db);
      const results = await Promise.allSettled([
        removeMember(owner, m.id, { db }),
        completePasswordToken({ token: raw, password: "brand-new-pass" }, db),
      ]);
      expect(results.filter(isDeadlock)).toEqual([]);
    }
  }, 30_000);

  it("removeMember never holds a token row while it waits for the user row (interleaved, would deadlock in the old order)", async () => {
    const m = await makeUser({ name: "Mia", email: "mia@x.com" });
    await issueAuthToken("reset", "agency", m.id, db);
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    let proceed!: () => void;
    const mayProceed = new Promise<void>((r) => (proceed = r));
    // The first half of completePasswordToken: the user's row is locked, the token is next.
    const spend = db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, m.id)).for("update");
      locked();
      await mayProceed;
      // The second half: spend the token. In the old order removeMember already holds it, and each waits for the other.
      await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.userId, m.id));
    });
    await hasLock;
    const removal = removeMember(owner, m.id, { db });
    // Wait until removeMember is blocked on a lock before letting the token be spent.
    let waiterSeen = false;
    for (let i = 0; i < 200; i++) {
      const [row] = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (row.n > 0) {
        waiterSeen = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(waiterSeen).toBe(true);
    proceed();
    const outcome = await Promise.allSettled([spend, removal]);
    expect(outcome.filter(isDeadlock)).toEqual([]);
    expect(outcome[0].status).toBe("fulfilled");
    expect((await db.select().from(authTokens)).filter((t) => t.userId === m.id)).toHaveLength(0);
    expect((await db.select().from(users).where(eq(users.id, m.id)))).toHaveLength(0);
  });

  it("is forbidden for a manager and notFound for a stranger", async () => {
    expect(await removeMember(manager, owner.user.id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await removeMember(owner, crypto.randomUUID(), { db })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("listMembers", () => {
  it("gives the owner every member with e-mail, invite state and clients, oldest first", async () => {
    const collab = await makeUser({ name: "Cy", email: "cy@x.com", password: false });
    const [client] = await db.insert(clients).values({ name: "Acme" }).returning();
    await db.insert(clientAssignments).values({ clientId: client.id, userId: collab.id });
    const res = await listMembers(owner, { db });
    expect(res).toEqual({
      ok: true,
      value: [
        { id: owner.user.id, name: "Ana", email: "ana@x.com", role: "owner", pending: false, clientIds: [] },
        { id: manager.user.id, name: "Mo", email: "mo@x.com", role: "manager", pending: false, clientIds: [] },
        { id: collab.id, name: "Cy", email: "cy@x.com", role: "collaborator", pending: true, clientIds: [client.id] },
      ],
    });
  });

  it("gives a manager names and roles only, and refuses a collaborator", async () => {
    const collab = await makeUser({ name: "Cy", email: "cy@x.com" });
    const res = await listMembers(manager, { db });
    expect(res).toEqual({
      ok: true,
      value: [
        { id: owner.user.id, name: "Ana", role: "owner" },
        { id: manager.user.id, name: "Mo", role: "manager" },
        { id: collab.id, name: "Cy", role: "collaborator" },
      ],
    });
    expect(JSON.stringify(res)).not.toContain("@x.com");
    expect(await listMembers(asTeam(collab), { db })).toEqual({ ok: false, error: "forbidden" });
  });
});
