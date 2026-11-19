import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { clientMemberships, clientUsers, clients, sessions, users } from "@/lib/db";
import {
  PORTAL_COOKIE,
  TEAM_COOKIE,
  createSession,
  destroySession,
  listCompanies,
  resolvePortalSession,
  resolveTeamSession,
  switchActiveCompany,
  type CookieStore,
} from "./session";

let db: Db;
let userId: string;

function fakeStore() {
  const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
  const store: CookieStore = {
    get: (name) => (jar.has(name) ? { value: jar.get(name)!.value } : undefined),
    set: (name, value, options) => void jar.set(name, { value, options }),
    delete: (name) => void jar.delete(name),
  };
  return { jar, store };
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  const [u] = await db
    .insert(users)
    .values({ name: "Ana", email: "ana@x.com", role: "owner" })
    .returning({ id: users.id });
  userId = u.id;
});

afterAll(async () => {
  await db?.$client.end();
});

describe("sessions", () => {
  it("stores the hash of the cookie token, never the token itself", async () => {
    const { jar, store } = fakeStore();
    await createSession("agency", userId, { store, db, secure: true });
    const cookie = jar.get(TEAM_COOKIE)!;
    expect(cookie.value).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(cookie.value);
    expect(rows[0].userId).toBe(userId);
    const days = (rows[0].expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it("resolves the session user and ignores expired or unknown tokens", async () => {
    const { jar, store } = fakeStore();
    await createSession("agency", userId, { store, db, secure: false });
    const token = jar.get(TEAM_COOKIE)!.value;
    const s = await resolveTeamSession(token, db);
    expect(s?.userType).toBe("agency");
    expect(s?.user.id).toBe(userId);
    expect(await resolveTeamSession("unknown", db)).toBeNull();
    expect(await resolveTeamSession(undefined, db)).toBeNull();
    await db.execute(sql`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    expect(await resolveTeamSession(token, db)).toBeNull();
  });

  it("destroySession deletes the row and the cookie", async () => {
    const { jar, store } = fakeStore();
    await createSession("agency", userId, { store, db, secure: false });
    await destroySession("agency", { store, db });
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(jar.has(TEAM_COOKIE)).toBe(false);
  });

  it("does not resolve when the user is gone", async () => {
    const { jar, store } = fakeStore();
    await createSession("agency", userId, { store, db, secure: false });
    await db.delete(users).where(eq(users.id, userId));
    expect(await resolveTeamSession(jar.get(TEAM_COOKIE)!.value, db)).toBeNull();
  });
});

describe("separate team and portal sessions", () => {
  let personId: string;
  let a: string;
  let b: string;
  let c: string;

  beforeEach(async () => {
    const [p] = await db.insert(clientUsers).values({ name: "Pat", email: "pat@x.com" }).returning({ id: clientUsers.id });
    personId = p.id;
    const cs = await db
      .insert(clients)
      .values([{ name: "Acme" }, { name: "Beta" }, { name: "Gamma" }])
      .returning({ id: clients.id, name: clients.name });
    [a, b, c] = ["Acme", "Beta", "Gamma"].map((n) => cs.find((x) => x.name === n)!.id);
    await db.insert(clientMemberships).values({ clientUserId: personId, clientId: a, role: "collaborator", createdAt: new Date("2026-01-01") });
    await db.insert(clientMemberships).values({ clientUserId: personId, clientId: b, role: "admin", createdAt: new Date("2026-02-01") });
  });

  it("writes only the cookie of its own side", async () => {
    const team = fakeStore();
    await createSession("agency", userId, { store: team.store, db, secure: false });
    expect([...team.jar.keys()]).toEqual([TEAM_COOKIE]);
    const portal = fakeStore();
    await createSession("client", personId, { store: portal.store, db, secure: false });
    expect([...portal.jar.keys()]).toEqual([PORTAL_COOKIE]);
  });

  it("destroySession on one side leaves the other cookie and row alone", async () => {
    const { jar, store } = fakeStore();
    await createSession("agency", userId, { store, db, secure: false });
    await createSession("client", personId, { store, db, secure: false });
    await destroySession("client", { store, db });
    expect(jar.has(PORTAL_COOKIE)).toBe(false);
    expect(jar.has(TEAM_COOKIE)).toBe(true);
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].userType).toBe("agency");
  });

  it("never lets one side's cookie authenticate on the other", async () => {
    const { jar, store } = fakeStore();
    await createSession("agency", userId, { store, db, secure: false });
    await createSession("client", personId, { store, db, secure: false });
    expect(await resolvePortalSession(jar.get(TEAM_COOKIE)!.value, db)).toBeNull();
    expect(await resolveTeamSession(jar.get(PORTAL_COOKIE)!.value, db)).toBeNull();
    expect((await resolvePortalSession(jar.get(PORTAL_COOKIE)!.value, db))?.userType).toBe("client");
  });

  it("starts in the oldest membership, with the role of that membership", async () => {
    const { jar, store } = fakeStore();
    await createSession("client", personId, { store, db, secure: false });
    const s = await resolvePortalSession(jar.get(PORTAL_COOKIE)!.value, db);
    expect(s?.client.id).toBe(a);
    expect(s?.role).toBe("collaborator");
    expect(s?.user.id).toBe(personId);
  });

  it("switches the active company among memberships only", async () => {
    const { jar, store } = fakeStore();
    await createSession("client", personId, { store, db, secure: false });
    const token = jar.get(PORTAL_COOKIE)!.value;
    expect(await switchActiveCompany(b, { store, db })).toEqual({ ok: true, value: undefined });
    const s = await resolvePortalSession(token, db);
    expect(s?.client.id).toBe(b);
    expect(s?.role).toBe("admin");
    expect(await switchActiveCompany(c, { store, db })).toEqual({ ok: false, error: "notMember" });
    expect((await resolvePortalSession(token, db))?.client.id).toBe(b);
  });

  it("answers notMember (and does not throw) for a malformed company id", async () => {
    const { store } = fakeStore();
    await createSession("client", personId, { store, db, secure: false });
    expect(await switchActiveCompany("not-a-uuid", { store, db })).toEqual({ ok: false, error: "notMember" });
    expect(await switchActiveCompany("", { store, db })).toEqual({ ok: false, error: "notMember" });
  });

  it("switchActiveCompany refuses a team token sent as vx_portal", async () => {
    const team = fakeStore();
    await createSession("agency", userId, { store: team.store, db, secure: false });
    const { store } = fakeStore();
    store.set(PORTAL_COOKIE, team.jar.get(TEAM_COOKIE)!.value);
    expect(await switchActiveCompany(a, { store, db })).toEqual({ ok: false, error: "notSignedIn" });
    expect((await db.select().from(sessions))[0].clientId).toBeNull();
  });

  it("switchActiveCompany refuses an expired portal session", async () => {
    const { store } = fakeStore();
    await createSession("client", personId, { store, db, secure: false });
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    const before = (await db.select().from(sessions))[0].clientId;
    expect(await switchActiveCompany(b, { store, db })).toEqual({ ok: false, error: "notSignedIn" });
    expect((await db.select().from(sessions))[0].clientId).toBe(before);
  });

  it("refuses to switch without a portal cookie", async () => {
    const { store } = fakeStore();
    expect(await switchActiveCompany(a, { store, db })).toEqual({ ok: false, error: "notSignedIn" });
  });

  it("falls back when memberships are removed, and stops resolving with none", async () => {
    const { jar, store } = fakeStore();
    await createSession("client", personId, { store, db, secure: false });
    const token = jar.get(PORTAL_COOKIE)!.value;
    await switchActiveCompany(b, { store, db });
    await db.delete(clientMemberships).where(eq(clientMemberships.clientId, b));
    expect((await resolvePortalSession(token, db))?.client.id).toBe(a);
    await db.delete(clientMemberships).where(eq(clientMemberships.clientId, a));
    expect(await resolvePortalSession(token, db)).toBeNull();
  });

  it("lists the companies with the person's role in each, ordered by name", async () => {
    const list = await listCompanies(personId, db);
    expect(list).toEqual([
      { id: a, name: "Acme", role: "collaborator" },
      { id: b, name: "Beta", role: "admin" },
    ]);
  });
});
