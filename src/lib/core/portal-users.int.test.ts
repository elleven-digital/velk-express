import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import {
  agency,
  authTokens,
  clientMemberships,
  clientUsers,
  clients,
  sessions,
  users,
  type Client,
  type ClientRole,
  type ClientUser,
  type User,
} from "@/lib/db";
import { peekPasswordToken } from "@/lib/auth/credentials";
import { hashPassword } from "@/lib/auth/password";
import {
  PORTAL_COOKIE,
  createSession,
  resolvePortalSession,
  switchActiveCompany,
  type CookieStore,
  type PortalSession,
  type TeamSession,
} from "@/lib/auth/session";
import { issueAuthToken } from "@/lib/auth/tokens";
import {
  createPortalResetLink,
  ensurePortalLogin,
  invitePortalUser,
  lockPortalCompany,
  linkForPortalAdmin,
  listCompanyUsers,
  removePortalUser,
  resendPortalInvite,
  setPortalRole,
} from "./portal-users";

// getConfig() is lazy: a database URL, a fixed public address and no SMTP.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://painel.acme.com";
delete process.env.SMTP_HOST;
delete process.env.MAIL_FROM;

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let A: Client;
let B: Client;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });
const send = (sent: boolean) => vi.fn(async () => ({ sent }));

async function makePerson(name: string, email: string, opts: { password?: boolean } = {}): Promise<ClientUser> {
  const [p] = await db
    .insert(clientUsers)
    .values({ name, email, passwordHash: opts.password === false ? null : await hashPassword("some-password") })
    .returning();
  return p;
}

async function join(person: ClientUser, client: Client, role: ClientRole) {
  await db.insert(clientMemberships).values({ clientUserId: person.id, clientId: client.id, role });
}

/** Links an existing login the way the team does: ask, read what is shown, then confirm exactly that. */
async function linkWithConfirm(
  actor: TeamSession,
  client: Client,
  input: { name: string; email: string; role: ClientRole },
  deps: { db: Db; send?: ReturnType<typeof send> },
) {
  const asked = await invitePortalUser(actor, client.id, input, deps);
  if (!asked.ok || asked.value.outcome !== "confirm") throw new Error("expected a confirm");
  return invitePortalUser(
    actor,
    client.id,
    { ...input, confirm: { clientUserId: asked.value.clientUserId, active: asked.value.existing!.active, willBeAdmin: asked.value.existing!.willBeAdmin } },
    deps,
  );
}

/** A portal actor as the session resolver would build it. */
function asPortal(person: ClientUser, client: Client, role: ClientRole): PortalSession {
  return { userType: "client", user: person, client, role };
}

const roleIn = async (personId: string, client: Client) =>
  (
    await db
      .select({ role: clientMemberships.role })
      .from(clientMemberships)
      .where(and(eq(clientMemberships.clientUserId, personId), eq(clientMemberships.clientId, client.id)))
  )[0]?.role;

function fakeStore() {
  const jar = new Map<string, { value: string }>();
  const store: CookieStore = {
    get: (name) => jar.get(name),
    set: (name, value) => void jar.set(name, { value }),
    delete: (name) => void jar.delete(name),
  };
  return { jar, store };
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  const rows = await db
    .insert(users)
    .values([
      { name: "Ana", email: "ana@x.com", role: "owner" },
      { name: "Mo", email: "mo@x.com", role: "manager" },
      { name: "Cris", email: "cris@x.com", role: "collaborator" },
    ])
    .returning();
  owner = asTeam(rows[0]);
  manager = asTeam(rows[1]);
  collab = asTeam(rows[2]);
  [A, B] = await db.insert(clients).values([{ name: "Alpha" }, { name: "Beta" }]).returning();
});

afterAll(async () => {
  await db?.$client.end();
});

describe("invitePortalUser", () => {
  it("makes the first login of a company an admin whatever role was asked, and keeps the second as asked", async () => {
    const first = await invitePortalUser(manager, A.id, { name: "Bia", email: "bia@x.com", role: "collaborator" }, { db });
    const second = await invitePortalUser(manager, A.id, { name: "Caio", email: "caio@x.com", role: "collaborator" }, { db });
    if (!first.ok || !second.ok) throw new Error("invite failed");
    expect(await roleIn(first.value.clientUserId, A)).toBe("admin");
    expect(await roleIn(second.value.clientUserId, A)).toBe("collaborator");
  });

  it("normalizes the email, returns a copyable client invite link and reports no mail without SMTP", async () => {
    const res = await invitePortalUser(owner, A.id, { name: " Bia ", email: " Bia@X.com ", role: "admin" }, { db });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({ outcome: "invited", emailed: false });
    expect(res.value.link!.startsWith("https://painel.acme.com/set-password/")).toBe(true);
    const [person] = await db.select().from(clientUsers).where(eq(clientUsers.id, res.value.clientUserId));
    expect(person).toMatchObject({ name: "Bia", email: "bia@x.com", passwordHash: null, locale: null });
    const info = await peekPasswordToken(res.value.link!.split("/").pop()!, db);
    expect(info).toMatchObject({ userType: "client", purpose: "invite" });
  });

  it("e-mails the invite in the agency language when the person has none", async () => {
    await db.update(agency).set({ locale: "pt" });
    const mail = vi.fn(async (msg: { to: string; subject: string }) => ({ sent: msg.to !== "" }));
    const res = await invitePortalUser(owner, A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db, send: mail });
    expect(res.ok && res.value.emailed).toBe(true);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0][0]).toMatchObject({ to: "bia@x.com", subject: "Seu acesso ao painel de Studio Acme" });
  });

  it("refuses the same email in the same company, whatever its case", async () => {
    await invitePortalUser(owner, A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db });
    const again = await invitePortalUser(owner, A.id, { name: "Bia 2", email: "BIA@x.com", role: "collaborator" }, { db });
    expect(again).toEqual({ ok: false, error: "alreadyMember" });
    expect(await db.select().from(clientUsers)).toHaveLength(1);
  });

  it("links an existing login to another company with no new link or mail", async () => {
    await invitePortalUser(owner, A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db });
    const mail = send(true);
    const res = await linkWithConfirm(owner, B, { name: "Bia", email: "bia@x.com", role: "collaborator" }, { db, send: mail });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({ outcome: "linked", link: null, emailed: false, wasPending: true });
    expect(mail).not.toHaveBeenCalled();
    expect(await db.select().from(clientUsers)).toHaveLength(1);
    expect(await db.select().from(clientMemberships)).toHaveLength(2);
    // B had no admin, so the first link there is an admin too.
    expect(await roleIn(res.value.clientUserId, B)).toBe("admin");
  });

  it("is not blocked by a team member with the same email", async () => {
    await db.insert(users).values({ name: "Bia (team)", email: "bia@x.com", role: "collaborator" });
    const res = await invitePortalUser(owner, A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db });
    expect(res.ok && res.value.outcome).toBe("invited");
    expect(await db.select().from(clientUsers)).toHaveLength(1);
  });

  it("lets a manager invite and refuses a team collaborator", async () => {
    expect(await invitePortalUser(collab, A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await db.select().from(clientUsers)).toHaveLength(0);
    expect((await invitePortalUser(manager, A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db })).ok).toBe(true);
  });

  it("answers notFound for a client that does not exist", async () => {
    const input = { name: "Bia", email: "bia@x.com", role: "admin" as const };
    expect(await invitePortalUser(owner, crypto.randomUUID(), input, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await invitePortalUser(owner, "not-a-uuid", input, { db })).toEqual({ ok: false, error: "notFound" });
  });

  it.each([
    ["blank name", { name: "  " }],
    ["long name", { name: "x".repeat(121) }],
    ["bad email", { email: "nope" }],
    ["bad role", { role: "owner" as never }],
  ])("rejects %s", async (_label, patch) => {
    const res = await invitePortalUser(owner, A.id, { name: "Bia", email: "bia@x.com", role: "admin", ...patch }, { db });
    expect(res).toEqual({ ok: false, error: "invalid" });
    expect(await db.select().from(clientUsers)).toHaveLength(0);
  });

  it("lets a portal admin invite into their own company", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, A, "admin");
    const res = await invitePortalUser(asPortal(adm, A, "admin"), A.id, { name: "Bia", email: "bia@x.com", role: "collaborator" }, { db });
    expect(res.ok && res.value.outcome).toBe("invited");
  });

  it("two simultaneous invites of one new email into two companies make one login; the loser is asked to confirm, never linked silently", async () => {
    const input = { name: "Bia", email: "bia@x.com", role: "admin" as const };
    const [r1, r2] = await Promise.all([
      invitePortalUser(owner, A.id, input, { db }),
      invitePortalUser(owner, B.id, input, { db }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const outcomes = [r1, r2].map((r) => (r.ok ? r.value.outcome : null)).sort();
    expect(outcomes).toEqual(["confirm", "invited"]);
    expect(await db.select().from(clientUsers)).toHaveLength(1);
    expect(await db.select().from(clientMemberships)).toHaveLength(1);
  });
});

describe("who may manage", () => {
  it("portal admin of A cannot manage B, even as a collaborator of B", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, A, "admin");
    await join(adm, B, "collaborator");
    const victim = await makePerson("Vic", "vic@x.com");
    await join(victim, B, "admin");
    const onlyB = await makePerson("Bo", "bo@x.com");
    await join(onlyB, B, "collaborator");
    const actor = asPortal(adm, A, "admin");
    const forbidden = { ok: false, error: "forbidden" };

    expect(await invitePortalUser(actor, B.id, { name: "Eve", email: "eve@x.com", role: "admin" }, { db })).toEqual(forbidden);
    expect(await setPortalRole(actor, B.id, victim.id, "collaborator", { db })).toEqual(forbidden);
    expect(await removePortalUser(actor, B.id, victim.id, { db })).toEqual(forbidden);
    expect(await listCompanyUsers(actor, B.id, { db })).toEqual(forbidden);
    expect(await resendPortalInvite(actor, B.id, victim.id, { db })).toEqual(forbidden);
    // A person that only belongs to B is not part of A.
    expect(await removePortalUser(actor, A.id, onlyB.id, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await setPortalRole(actor, A.id, onlyB.id, "admin", { db })).toEqual({ ok: false, error: "notFound" });

    expect(await roleIn(victim.id, B)).toBe("admin");
    expect(await roleIn(onlyB.id, B)).toBe("collaborator");
    expect(await roleIn(adm.id, B)).toBe("collaborator");
    expect(await db.select().from(clientUsers)).toHaveLength(3);
  });

  it("refuses a portal collaborator everything in their own company", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const col = await makePerson("Col", "col@x.com");
    await join(adm, A, "admin");
    await join(col, A, "collaborator");
    const actor = asPortal(col, A, "collaborator");
    const forbidden = { ok: false, error: "forbidden" };
    expect(await listCompanyUsers(actor, A.id, { db })).toEqual(forbidden);
    expect(await invitePortalUser(actor, A.id, { name: "Eve", email: "eve@x.com", role: "admin" }, { db })).toEqual(forbidden);
    expect(await setPortalRole(actor, A.id, col.id, "admin", { db })).toEqual(forbidden);
    expect(await removePortalUser(actor, A.id, adm.id, { db })).toEqual(forbidden);
    expect(await resendPortalInvite(actor, A.id, adm.id, { db })).toEqual(forbidden);
    expect(await roleIn(col.id, A)).toBe("collaborator");
  });

  it("re-checks the portal admin's role in the database, not only in the session object", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const other = await makePerson("Otto", "otto@x.com");
    await join(adm, A, "collaborator"); // demoted since the session was read
    await join(other, A, "admin");
    const stale = asPortal(adm, A, "admin");
    expect(await removePortalUser(stale, A.id, other.id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await roleIn(other.id, A)).toBe("admin");
  });
});

describe("listCompanyUsers", () => {
  it("lists the people of one company with their role and whether the invite is pending", async () => {
    const real = await makePerson("Ada", "ada@x.com");
    const pending = await makePerson("Pen", "pen@x.com", { password: false });
    const elsewhere = await makePerson("Eli", "eli@x.com");
    await join(real, A, "admin");
    await join(pending, A, "collaborator");
    await join(elsewhere, B, "admin");
    const res = await listCompanyUsers(manager, A.id, { db });
    expect(res.ok && res.value).toEqual([
      { id: real.id, name: "Ada", email: "ada@x.com", role: "admin", pending: false },
      { id: pending.id, name: "Pen", email: "pen@x.com", role: "collaborator", pending: true },
    ]);
    expect(await listCompanyUsers(collab, A.id, { db })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("last admin", () => {
  it("does not let the only password-set admin remove or demote themselves", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, A, "admin");
    const actor = asPortal(adm, A, "admin");
    expect(await removePortalUser(actor, A.id, adm.id, { db })).toEqual({ ok: false, error: "lastAdmin" });
    expect(await setPortalRole(actor, A.id, adm.id, "collaborator", { db })).toEqual({ ok: false, error: "lastAdmin" });
    expect(await roleIn(adm.id, A)).toBe("admin");
    // The team is held to the same rule.
    expect(await removePortalUser(owner, A.id, adm.id, { db })).toEqual({ ok: false, error: "lastAdmin" });
  });

  it("does not count a pending admin, and lets a pending admin go even when they are the only one", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const pending = await makePerson("Pen", "pen@x.com", { password: false });
    await join(adm, A, "admin");
    await join(pending, A, "admin");
    // Ada is the only admin who can sign in.
    expect(await setPortalRole(manager, A.id, adm.id, "collaborator", { db })).toEqual({ ok: false, error: "lastAdmin" });
    // The pending admin is free to be removed or demoted.
    expect((await setPortalRole(manager, A.id, pending.id, "collaborator", { db })).ok).toBe(true);
    await db.update(clientMemberships).set({ role: "admin" }).where(eq(clientMemberships.clientUserId, pending.id));
    expect((await removePortalUser(manager, A.id, pending.id, { db })).ok).toBe(true);
  });

  it("lets a pending admin be removed even as the only admin", async () => {
    const pending = await makePerson("Pen", "pen@x.com", { password: false });
    await join(pending, A, "admin");
    expect(await removePortalUser(owner, A.id, pending.id, { db })).toEqual({ ok: true, value: { loginDeleted: true } });
  });

  it("lets an admin step down when another admin can sign in", async () => {
    const one = await makePerson("One", "one@x.com");
    const two = await makePerson("Two", "two@x.com");
    await join(one, A, "admin");
    await join(two, A, "admin");
    expect((await setPortalRole(asPortal(one, A, "admin"), A.id, one.id, "collaborator", { db })).ok).toBe(true);
    expect(await roleIn(one.id, A)).toBe("collaborator");
  });

  it("when two admins demote each other at once, exactly one succeeds and an admin is left", async () => {
    const one = await makePerson("One", "one@x.com");
    const two = await makePerson("Two", "two@x.com");
    await join(one, A, "admin");
    await join(two, A, "admin");
    const results = await Promise.all([
      setPortalRole(asPortal(one, A, "admin"), A.id, two.id, "collaborator", { db }),
      setPortalRole(asPortal(two, A, "admin"), A.id, one.id, "collaborator", { db }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const admins = await db
      .select()
      .from(clientMemberships)
      .where(and(eq(clientMemberships.clientId, A.id), eq(clientMemberships.role, "admin")));
    expect(admins).toHaveLength(1);
  });

  it("when two admins step down at once, exactly one succeeds and an admin is left", async () => {
    const one = await makePerson("One", "one@x.com");
    const two = await makePerson("Two", "two@x.com");
    await join(one, A, "admin");
    await join(two, A, "admin");
    const results = await Promise.all([
      setPortalRole(asPortal(one, A, "admin"), A.id, one.id, "collaborator", { db }),
      setPortalRole(asPortal(two, A, "admin"), A.id, two.id, "collaborator", { db }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "lastAdmin" });
    const admins = await db
      .select()
      .from(clientMemberships)
      .where(and(eq(clientMemberships.clientId, A.id), eq(clientMemberships.role, "admin")));
    expect(admins).toHaveLength(1);
  });
});

describe("company lock", () => {
  it("makes every edit of a company wait for the one holding its lock, and not those of another company", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(adm, A, "admin");
    await join(bia, A, "collaborator");
    const eli = await makePerson("Eli", "eli@x.com");
    await join(eli, B, "admin");
    const bo = await makePerson("Bo", "bo@x.com");
    await join(bo, B, "collaborator");

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"velk:portal:" + A.id}))`);
      locked();
      await hold;
    });
    await isLocked;

    let done = false;
    const waiting = setPortalRole(manager, A.id, bia.id, "admin", { db }).then((r) => ((done = true), r));
    // Another company is not held up by it.
    expect((await setPortalRole(manager, B.id, bo.id, "admin", { db })).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    expect(await roleIn(bia.id, A)).toBe("collaborator");

    release();
    await holder;
    expect((await waiting).ok).toBe(true);
    expect(await roleIn(bia.id, A)).toBe("admin");
  });
});

describe("cross-company takeover", () => {
  it("a portal admin cannot add a login that exists elsewhere, pending or not", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, A, "admin");
    const pendingInB = await makePerson("Pen", "pen@x.com", { password: false });
    const activeInB = await makePerson("Act", "act@x.com");
    await join(pendingInB, B, "admin");
    await join(activeInB, B, "admin");
    const actor = asPortal(adm, A, "admin");
    for (const email of ["pen@x.com", "ACT@x.com"]) {
      const res = await invitePortalUser(actor, A.id, { name: "X", email, role: "admin" }, { db });
      expect(res).toEqual({ ok: false, error: "existsElsewhere" });
    }
    expect(await roleIn(pendingInB.id, A)).toBeUndefined();
    expect(await db.select().from(clientMemberships)).toHaveLength(3);
    // In its own company the answer stays alreadyMember.
    expect(await invitePortalUser(actor, A.id, { name: "Ada", email: "ada@x.com", role: "admin" }, { db })).toEqual({ ok: false, error: "alreadyMember" });
  });

  it("a portal admin cannot get an invite link for a pending person who also belongs to another company", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, A, "admin");
    const pen = await makePerson("Pen", "pen@x.com", { password: false });
    await join(pen, A, "collaborator");
    await join(pen, B, "admin");
    const before = await db.select().from(authTokens);
    expect(await resendPortalInvite(asPortal(adm, A, "admin"), A.id, pen.id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await db.select().from(authTokens)).toEqual(before);
    // The team can still do it.
    expect((await resendPortalInvite(manager, A.id, pen.id, { db })).ok).toBe(true);
  });

  it("linking a pending login revokes its earlier invite link", async () => {
    const first = await invitePortalUser(owner, A.id, { name: "Pen", email: "pen@x.com", role: "admin" }, { db });
    if (!first.ok || !first.value.link) throw new Error("invite failed");
    const linked = await linkWithConfirm(manager, B, { name: "Pen", email: "pen@x.com", role: "admin" }, { db });
    expect(linked.ok && linked.value.outcome).toBe("linked");
    expect(linked.ok && linked.value.wasPending).toBe(true);
    expect(await peekPasswordToken(first.value.link.split("/").pop()!, db)).toBeNull();
    expect(
      await db.select().from(authTokens).where(and(eq(authTokens.userId, first.value.clientUserId), isNull(authTokens.usedAt))),
    ).toHaveLength(0);
    const fresh = await resendPortalInvite(manager, B.id, first.value.clientUserId, { db });
    expect(fresh.ok).toBe(true);
  });

  it("keeps the invite and its link when the mail throws", async () => {
    const boom = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const res = await invitePortalUser(owner, A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db, send: boom });
    expect(res.ok && res.value.emailed).toBe(false);
    expect(res.ok && res.value.link).toBeTruthy();
    const again = await resendPortalInvite(owner, A.id, res.ok ? res.value.clientUserId : "", { db, send: boom });
    expect(again.ok && again.value.emailed).toBe(false);
  });

  it("resend and remove wait for the company lock", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const pen = await makePerson("Pen", "pen@x.com", { password: false });
    const col = await makePerson("Col", "col@x.com");
    await join(adm, A, "admin");
    await join(pen, A, "collaborator");
    await join(col, A, "collaborator");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"velk:portal:" + A.id}))`);
      locked();
      await hold;
    });
    await isLocked;
    const done: string[] = [];
    const p1 = resendPortalInvite(manager, A.id, pen.id, { db }).then((r) => (done.push("resend"), r));
    const p2 = removePortalUser(manager, A.id, col.id, { db }).then((r) => (done.push("remove"), r));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toEqual([]);
    release();
    await holder;
    expect((await p1).ok && (await p2).ok).toBe(true);
  });
});

describe("linking an existing login needs a confirmation", () => {
  const rowCounts = async () => ({
    memberships: (await db.select().from(clientMemberships)).length,
    tokens: (await db.select().from(authTokens)).length,
  });

  it("an unconfirmed link writes nothing and lists only that login's own companies", async () => {
    const bia = await makePerson("Bia", "bia@x.com");
    await join(bia, A, "collaborator");
    // Another person's company must never leak into the answer.
    const other = await makePerson("Zed", "zed@x.com");
    const [C] = await db.insert(clients).values({ name: "Secret Co" }).returning();
    await join(other, C, "admin");
    const before = await rowCounts();
    const mail = send(true);
    const res = await invitePortalUser(owner, B.id, { name: "Bia", email: "bia@x.com", role: "collaborator" }, { db, send: mail });
    expect(res).toEqual({
      ok: true,
      value: {
        clientUserId: bia.id,
        outcome: "confirm",
        link: null,
        emailed: false,
        existing: { name: "Bia", active: true, companies: [{ name: "Alpha", role: "collaborator" }], willBeAdmin: true },
      },
    });
    expect(await rowCounts()).toEqual(before);
    expect(mail).not.toHaveBeenCalled();
  });

  it("reports pending status and that the login will not be admin when the company already has one", async () => {
    const pen = await makePerson("Pen", "pen@x.com", { password: false });
    await join(pen, A, "admin");
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, B, "admin");
    const res = await invitePortalUser(owner, B.id, { name: "Pen", email: "pen@x.com", role: "collaborator" }, { db });
    expect(res.ok && res.value.existing).toEqual({
      name: "Pen",
      active: false,
      companies: [{ name: "Alpha", role: "admin" }],
      willBeAdmin: false,
    });
  });

  it("links when the confirmation names that login and its current active flag", async () => {
    const bia = await makePerson("Bia", "bia@x.com");
    await join(bia, A, "admin");
    const res = await invitePortalUser(
      manager,
      B.id,
      { name: "Bia", email: "bia@x.com", role: "collaborator", confirm: { clientUserId: bia.id, active: true, willBeAdmin: true } },
      { db },
    );
    expect(res.ok && res.value).toMatchObject({ outcome: "linked", wasPending: false, link: null });
    expect(await roleIn(bia.id, B)).toBe("admin");
  });

  it("confirm is asked again when willBeAdmin changed", async () => {
    // Company A has no admin yet; the login already lives in B.
    const bia = await makePerson("Bia", "bia@x.com");
    await join(bia, B, "admin");
    const input = { name: "Bia", email: "bia@x.com", role: "collaborator" as const };
    const asked = await invitePortalUser(owner, A.id, input, { db });
    if (!asked.ok || asked.value.outcome !== "confirm") throw new Error("expected confirm");
    expect(asked.value.existing?.willBeAdmin).toBe(true);
    // Meanwhile someone else becomes the admin of A.
    const first = await invitePortalUser(owner, A.id, { name: "Zed", email: "zed@x.com", role: "collaborator" }, { db });
    expect(first.ok && first.value.outcome).toBe("invited");
    const stale = await invitePortalUser(
      owner,
      A.id,
      { ...input, confirm: { clientUserId: bia.id, active: true, willBeAdmin: true } },
      { db },
    );
    expect(stale.ok && stale.value.outcome).toBe("confirm");
    expect(stale.ok && stale.value.existing?.willBeAdmin).toBe(false);
    expect(await roleIn(bia.id, A)).toBeUndefined();
    const fresh = await invitePortalUser(
      owner,
      A.id,
      { ...input, confirm: { clientUserId: bia.id, active: true, willBeAdmin: false } },
      { db },
    );
    expect(fresh.ok && fresh.value.outcome).toBe("linked");
    expect(await roleIn(bia.id, A)).toBe("collaborator");
  });

  it("asks again for a confirmation of another login", async () => {
    const bia = await makePerson("Bia", "bia@x.com");
    await join(bia, A, "admin");
    const cy = await makePerson("Cy", "cy2@x.com");
    await join(cy, A, "collaborator");
    const res = await invitePortalUser(
      owner,
      B.id,
      { name: "Bia", email: "bia@x.com", role: "collaborator", confirm: { clientUserId: cy.id, active: true, willBeAdmin: true } },
      { db },
    );
    expect(res.ok && res.value.outcome).toBe("confirm");
    expect(await roleIn(bia.id, B)).toBeUndefined();
  });

  it("asks again when the login changed between pending and active", async () => {
    const pen = await makePerson("Pen", "pen@x.com", { password: false });
    await join(pen, A, "admin");
    const asked = await invitePortalUser(owner, B.id, { name: "Pen", email: "pen@x.com", role: "admin" }, { db });
    if (!asked.ok || asked.value.outcome !== "confirm") throw new Error("expected confirm");
    // Seen as pending; before the team confirms, the person sets a password.
    await db.update(clientUsers).set({ passwordHash: await hashPassword("some-password") }).where(eq(clientUsers.id, pen.id));
    const res = await invitePortalUser(
      owner,
      B.id,
      { name: "Pen", email: "pen@x.com", role: "admin", confirm: { clientUserId: pen.id, active: asked.value.existing!.active, willBeAdmin: true } },
      { db },
    );
    expect(res.ok && res.value.outcome).toBe("confirm");
    expect(res.ok && res.value.existing?.active).toBe(true);
    expect(await roleIn(pen.id, B)).toBeUndefined();
    // And the other way around.
    await db.update(clientUsers).set({ passwordHash: null }).where(eq(clientUsers.id, pen.id));
    const back = await invitePortalUser(
      owner,
      B.id,
      { name: "Pen", email: "pen@x.com", role: "admin", confirm: { clientUserId: pen.id, active: true, willBeAdmin: true } },
      { db },
    );
    expect(back.ok && back.value.outcome).toBe("confirm");
    expect(await roleIn(pen.id, B)).toBeUndefined();
  });

  it("a portal admin still gets existsElsewhere and nothing is written", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, A, "admin");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(bia, B, "admin");
    const before = await rowCounts();
    const res = await invitePortalUser(
      asPortal(adm, A, "admin"),
      A.id,
      { name: "Bia", email: "bia@x.com", role: "admin", confirm: { clientUserId: bia.id, active: true, willBeAdmin: true } },
      { db },
    );
    expect(res).toEqual({ ok: false, error: "existsElsewhere" });
    expect(await rowCounts()).toEqual(before);
  });

  it("a portal admin checking an email does not wait for a lock held on a login of another company", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, A, "admin");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(bia, B, "admin");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (tx) => {
      await tx.select().from(clientUsers).where(eq(clientUsers.id, bia.id)).for("update");
      locked();
      await held;
    });
    await hasLock;
    try {
      const res = await Promise.race([
        invitePortalUser(asPortal(adm, A, "admin"), A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db }),
        new Promise<"waited">((r) => setTimeout(() => r("waited"), 1500)),
      ]);
      expect(res).toEqual({ ok: false, error: "existsElsewhere" });
    } finally {
      release();
      await holder;
    }
  });

  it("linking an active login mails it a notice in its language, and a failing mail does not undo the link", async () => {
    const bia = await makePerson("Bia", "bia@x.com");
    await db.update(clientUsers).set({ locale: "pt" }).where(eq(clientUsers.id, bia.id));
    await join(bia, A, "admin");
    const sent: { to: string; subject: string; html: string; text: string }[] = [];
    const mail = vi.fn(async (msg: (typeof sent)[number]) => {
      sent.push(msg);
      return { sent: true };
    });
    const res = await linkWithConfirm(owner, B, { name: "Bia", email: "bia@x.com", role: "collaborator" }, { db, send: mail as never });
    expect(res.ok && res.value.outcome).toBe("linked");
    expect(mail).toHaveBeenCalledTimes(1);
    const msg = sent[0];
    expect(msg.to).toBe("bia@x.com");
    expect(msg.subject).toContain("Beta");
    expect(msg.subject).toContain("Studio Acme");
    expect(msg.subject).toContain("Você");
    expect(msg.text).toContain("https://painel.acme.com/forgot?side=portal");

    const dan = await makePerson("Dan", "dan@x.com");
    await join(dan, A, "admin");
    const boom = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const again = await linkWithConfirm(owner, B, { name: "Dan", email: "dan@x.com", role: "collaborator" }, { db, send: boom as never });
    expect(again.ok && again.value.outcome).toBe("linked");
    expect(await roleIn(dan.id, B)).toBe("collaborator");
  });

  it("linking a pending login sends no notice (it has no password to protect)", async () => {
    const pen = await makePerson("Pen", "pen@x.com", { password: false });
    await join(pen, A, "admin");
    const mail = send(true);
    await linkWithConfirm(owner, B, { name: "Pen", email: "pen@x.com", role: "admin" }, { db, send: mail });
    expect(mail).not.toHaveBeenCalled();
  });
});

describe("linkForPortalAdmin", () => {
  it("hides the link when it was e-mailed and shows it otherwise", () => {
    expect(linkForPortalAdmin("https://x/set-password/t", true)).toBeNull();
    expect(linkForPortalAdmin("https://x/set-password/t", false)).toBe("https://x/set-password/t");
  });
});

describe("removePortalUser", () => {
  it("keeps the login and the other company when the person is in two", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(adm, A, "admin");
    await join(bia, A, "collaborator");
    await join(bia, B, "collaborator");
    const res = await removePortalUser(manager, A.id, bia.id, { db });
    expect(res).toEqual({ ok: true, value: { loginDeleted: false } });
    expect(await roleIn(bia.id, A)).toBeUndefined();
    expect(await roleIn(bia.id, B)).toBe("collaborator");
    expect(await db.select().from(clientUsers).where(eq(clientUsers.id, bia.id))).toHaveLength(1);
  });

  it("deletes the login, its sessions and its tokens when the last company goes", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(adm, A, "admin");
    await join(bia, A, "collaborator");
    const { store } = fakeStore();
    await createSession("client", bia.id, { store, db, secure: false });
    await createSession("client", adm.id, { store: fakeStore().store, db, secure: false });
    await issueAuthToken("reset", "client", bia.id, db);
    await issueAuthToken("reset", "client", adm.id, db);

    const res = await removePortalUser(manager, A.id, bia.id, { db });
    expect(res).toEqual({ ok: true, value: { loginDeleted: true } });
    expect(await db.select().from(clientUsers).where(eq(clientUsers.id, bia.id))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, bia.id))).toHaveLength(0);
    expect(await db.select().from(authTokens).where(eq(authTokens.userId, bia.id))).toHaveLength(0);
    // Other people keep theirs.
    expect(await db.select().from(sessions).where(eq(sessions.userId, adm.id))).toHaveLength(1);
    expect(await db.select().from(authTokens).where(eq(authTokens.userId, adm.id))).toHaveLength(1);
  });

  it("leaves a team user with the same id alone (sessions and tokens are per side)", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(adm, A, "admin");
    await join(bia, A, "collaborator");
    await db.insert(sessions).values({ tokenHash: "t".repeat(64), userType: "agency", userId: bia.id, expiresAt: new Date(Date.now() + 1e6) });
    await removePortalUser(manager, A.id, bia.id, { db });
    expect(await db.select().from(sessions).where(eq(sessions.userId, bia.id))).toHaveLength(1);
  });

  it("answers notFound for an unknown or malformed person", async () => {
    expect(await removePortalUser(owner, A.id, crypto.randomUUID(), { db })).toEqual({ ok: false, error: "notFound" });
    expect(await removePortalUser(owner, A.id, "nope", { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("a person removed from the active company lands on another membership, then is signed out", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(adm, A, "admin");
    await join(adm, B, "admin");
    await join(bia, A, "collaborator");
    await join(bia, B, "collaborator");
    const { jar, store } = fakeStore();
    await createSession("client", bia.id, { store, db, secure: false });
    const token = jar.get(PORTAL_COOKIE)!.value;
    expect((await switchActiveCompany(A.id, { store, db })).ok).toBe(true);
    expect((await resolvePortalSession(token, db))?.client.id).toBe(A.id);

    await removePortalUser(manager, A.id, bia.id, { db });
    const next = await resolvePortalSession(token, db);
    expect(next?.client.id).toBe(B.id);

    await removePortalUser(manager, B.id, bia.id, { db });
    expect(await resolvePortalSession(token, db)).toBeNull();
  });
});

describe("setPortalRole", () => {
  it("changes a role, rejects a bad one and answers notFound for a stranger", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(adm, A, "admin");
    await join(bia, A, "collaborator");
    expect((await setPortalRole(manager, A.id, bia.id, "admin", { db })).ok).toBe(true);
    expect(await roleIn(bia.id, A)).toBe("admin");
    expect(await setPortalRole(manager, A.id, bia.id, "owner" as never, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await setPortalRole(manager, A.id, crypto.randomUUID(), "admin", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await setPortalRole(collab, A.id, bia.id, "admin", { db })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("resendPortalInvite and createPortalResetLink", () => {
  it("replaces the old invite link for a pending person", async () => {
    const invited = await invitePortalUser(owner, A.id, { name: "Bia", email: "bia@x.com", role: "admin" }, { db });
    if (!invited.ok) throw new Error("invite failed");
    const mail = send(true);
    const res = await resendPortalInvite(manager, A.id, invited.value.clientUserId, { db, send: mail });
    expect(res.ok && res.value.emailed).toBe(true);
    if (!res.ok) return;
    expect(await peekPasswordToken(invited.value.link!.split("/").pop()!, db)).toBeNull();
    expect(await peekPasswordToken(res.value.link.split("/").pop()!, db)).toMatchObject({ userType: "client", purpose: "invite" });
  });

  it("answers alreadyActive for someone who already has a password", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    await join(adm, A, "admin");
    expect(await resendPortalInvite(owner, A.id, adm.id, { db })).toEqual({ ok: false, error: "alreadyActive" });
  });

  it("is notFound for someone outside the company", async () => {
    const eli = await makePerson("Eli", "eli@x.com", { password: false });
    await join(eli, B, "admin");
    expect(await resendPortalInvite(owner, A.id, eli.id, { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("lets the team (not a team collaborator) issue a reset link, for people with a password only", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const pending = await makePerson("Pen", "pen@x.com", { password: false });
    await join(adm, A, "admin");
    await join(pending, A, "collaborator");
    expect(await createPortalResetLink(collab, A.id, adm.id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await createPortalResetLink(manager, A.id, pending.id, { db })).toEqual({ ok: false, error: "invalid" });
    const res = await createPortalResetLink(manager, A.id, adm.id, { db });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.link.startsWith("https://painel.acme.com/set-password/")).toBe(true);
    expect(await peekPasswordToken(res.value.link.split("/").pop()!, db)).toMatchObject({ userType: "client", purpose: "reset" });
  });

  it("is never available to a portal actor, not even an admin", async () => {
    const adm = await makePerson("Ada", "ada@x.com");
    const bia = await makePerson("Bia", "bia@x.com");
    await join(adm, A, "admin");
    await join(bia, A, "collaborator");
    const actor = asPortal(adm, A, "admin") as unknown as TeamSession;
    expect(await createPortalResetLink(actor, A.id, bia.id, { db })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("ensurePortalLogin", () => {
  const login = (clientId: string, email: string, name = "Zed") =>
    db.transaction((tx) => ensurePortalLogin(tx as unknown as Db, clientId, { name, email, locale: "pt" }));

  it("ensurePortalLogin makes the company's first login an admin and links a known login without an invite", async () => {
    const first = await login(A.id, "Zed@Acme.com");
    expect(first.invite).not.toBeNull();
    const [row] = await db.select().from(clientUsers).where(eq(clientUsers.id, first.clientUserId));
    expect(row).toMatchObject({ email: "zed@acme.com", name: "Zed", passwordHash: null, locale: "pt" });
    expect(await roleIn(first.clientUserId, A)).toBe("admin");
    expect(await db.select().from(authTokens).where(eq(authTokens.userId, first.clientUserId))).toHaveLength(1);

    // The company already has an admin: the next new login is a collaborator.
    const second = await login(A.id, "second@acme.com", "Second");
    expect(await roleIn(second.clientUserId, A)).toBe("collaborator");

    // A known pending login of another company is linked; its old invite is revoked and none is issued.
    const linked = await login(B.id, "zed@acme.com");
    expect(linked).toEqual({ clientUserId: first.clientUserId, invite: null, linkedActive: null });
    expect(await roleIn(first.clientUserId, B)).toBe("admin");
    expect(await db.select().from(authTokens).where(eq(authTokens.userId, first.clientUserId))).toHaveLength(0);

    // Already a member: nothing changes.
    expect(await login(B.id, "zed@acme.com")).toEqual({ clientUserId: first.clientUserId, invite: null, linkedActive: null });
  });

  it("keeps an active login's token set untouched when linking it", async () => {
    const active = await makePerson("Ada", "ada@x.com");
    const res = await login(A.id, "ada@x.com");
    expect(res).toEqual({
      clientUserId: active.id,
      invite: null,
      linkedActive: { name: "Ada", email: "ada@x.com", locale: active.locale },
    });
    expect(await roleIn(active.id, A)).toBe("admin");
  });

  it("ensurePortalLogin and invitePortalUser never deadlock on the same company", async () => {
    for (let round = 0; round < 20; round++) {
      const results = await Promise.allSettled([
        db.transaction(async (tx) => {
          const t = tx as unknown as Db;
          await lockPortalCompany(t, A.id);
          await t.select({ id: clients.id }).from(clients).where(eq(clients.id, A.id)).for("update");
          return ensurePortalLogin(t, A.id, { name: "Exec", email: `exec${round}@x.com`, locale: "en" });
        }),
        invitePortalUser(owner, A.id, { name: "Inv", email: `inv${round}@x.com`, role: "collaborator" }, { db, send: send(false) }),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          const e = r.reason as { code?: string; cause?: { code?: string } };
          expect(e.code ?? e.cause?.code).not.toBe("40P01");
        }
      }
    }
  });
});
