import "server-only";
import { and, asc, count, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db as appDb,
  agency,
  authTokens,
  autoAssignUsers,
  clientAssignments,
  clients,
  quotes,
  sessions,
  users,
  type Db,
  type User,
  type UserRole,
} from "@/lib/db";
import { isStaff } from "@/lib/access";
import { logoAbsoluteUrl } from "@/lib/agency";
import { authLink, issueAuthToken } from "@/lib/auth/tokens";
import type { TeamSession } from "@/lib/auth/session";
import { getDict, isLocale } from "@/lib/i18n";
import { buildInviteMail } from "@/lib/mail/messages/invite";
import { sendMail } from "@/lib/mail/send";
import { turnOffEmptyRotations } from "./assignments";
import { fail, ok, type Result } from "./result";

/**
 * The agency's team. Only owners manage it (checked here, whatever the page
 * guard says), the agency always keeps at least one owner and nobody removes
 * themselves. Errors are codes ("forbidden", "invalid", ...) the UI translates.
 */

export const ROLES = ["owner", "manager", "collaborator"] as const satisfies readonly UserRole[];

export function isRole(value: unknown): value is UserRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Test seams: the database and the mail sender. */
type Deps = { db?: Db; send?: typeof sendMail };

const inviteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: z.enum(ROLES),
});

const uuid = z.uuid();

function isConflict(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

const isOwner = (actor: TeamSession) => actor.user.role === "owner";

async function findMember(db: Db, userId: string): Promise<User | null> {
  if (!uuid.safeParse(userId).success) return null;
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row ?? null;
}

/** Sends the invite e-mail in the agency's language; false when it was not sent. */
async function mailInvite(db: Db, send: typeof sendMail, member: User, link: string): Promise<boolean> {
  const [brand] = await db.select().from(agency).limit(1);
  const locale = isLocale(member.locale) ? member.locale : isLocale(brand?.locale) ? brand.locale : "en";
  const dict = await getDict(locale);
  const msg = buildInviteMail(dict.team.inviteMail, {
    to: member.email,
    userName: member.name,
    agencyName: brand?.name ?? "Velk Express",
    logoUrl: await logoAbsoluteUrl(brand?.logoFileId ?? null),
    link,
  });
  return (await send(msg)).sent;
}

/** Serializes team edits so two owners cannot demote each other at once. */
async function lockTeam(tx: Db) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('velk:team'))`);
}

/** Owners who can sign in: invited owners without a password yet do not count (and may themselves be demoted or removed). */
async function ownerCount(tx: Db): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, "owner"), isNotNull(users.passwordHash)));
  return row?.n ?? 0;
}

/** A team member as the owner sees them: e-mail, whether the invite is still pending, their clients. */
export type FullMemberRow = { id: string; name: string; email: string; role: UserRole; pending: boolean; clientIds: string[] };

/** A team member as a manager sees them: name and role only. */
export type BasicMemberRow = Pick<FullMemberRow, "id" | "name" | "role">;

export type MemberRow = FullMemberRow | BasicMemberRow;

/**
 * The team, oldest member first. The owner gets everything the Team page shows (a pending invite
 * is a member without a password yet); a manager names and roles; a collaborator nothing.
 */
export async function listMembers(actor: TeamSession, deps: Pick<Deps, "db"> = {}): Promise<Result<MemberRow[]>> {
  if (!isStaff(actor.user)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, passwordHash: users.passwordHash })
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.email));
  if (!isOwner(actor)) return ok(members.map((m) => ({ id: m.id, name: m.name, role: m.role })));
  const links = await db
    .select({ userId: clientAssignments.userId, clientId: clientAssignments.clientId })
    .from(clientAssignments)
    .orderBy(asc(clientAssignments.clientId));
  const clientIds = new Map<string, string[]>();
  for (const l of links) {
    const list = clientIds.get(l.userId) ?? [];
    list.push(l.clientId);
    clientIds.set(l.userId, list);
  }
  return ok(
    members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      pending: !m.passwordHash,
      clientIds: clientIds.get(m.id) ?? [],
    })),
  );
}

/** Creates a pending user (no password), issues an invite link and tries to e-mail it. */
export async function inviteMember(
  actor: TeamSession,
  input: { name: string; email: string; role: UserRole },
  deps: Deps = {},
): Promise<Result<{ userId: string; link: string; emailed: boolean }>> {
  if (!isOwner(actor)) return fail("forbidden");
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const db = deps.db ?? appDb;

  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, parsed.data.email));
  if (taken) return fail("emailTaken");

  let member: User;
  try {
    [member] = await db.insert(users).values({ ...parsed.data, passwordHash: null }).returning();
  } catch (err) {
    if (isConflict(err)) return fail("emailTaken");
    throw err;
  }

  const link = await authLink(await issueAuthToken("invite", "agency", member.id, db));
  const emailed = await mailInvite(db, deps.send ?? sendMail, member, link);
  return ok({ userId: member.id, link, emailed });
}

/** A fresh invite link (the old one stops working) for someone who has not set a password yet. */
export async function resendInvite(
  actor: TeamSession,
  userId: string,
  deps: Deps = {},
): Promise<Result<{ link: string; emailed: boolean }>> {
  if (!isOwner(actor)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const member = await findMember(db, userId);
  if (!member) return fail("notFound");
  if (member.passwordHash) return fail("invalid");

  const link = await authLink(await issueAuthToken("invite", "agency", member.id, db));
  const emailed = await mailInvite(db, deps.send ?? sendMail, member, link);
  return ok({ link, emailed });
}

/** A reset link for a member who has a password; the owner passes it on (no e-mail). */
export async function createResetLink(
  actor: TeamSession,
  userId: string,
  deps: Deps = {},
): Promise<Result<{ link: string }>> {
  if (!isOwner(actor)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const member = await findMember(db, userId);
  if (!member) return fail("notFound");
  if (!member.passwordHash) return fail("invalid");
  return ok({ link: await authLink(await issueAuthToken("reset", "agency", member.id, db)) });
}

/** Changes a role; the agency always keeps at least one owner. Applies from the member's next request. */
export async function changeRole(
  actor: TeamSession,
  userId: string,
  role: UserRole,
  deps: Deps = {},
): Promise<Result> {
  if (!isOwner(actor)) return fail("forbidden");
  if (!isRole(role)) return fail("invalid");
  const db = deps.db ?? appDb;
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockTeam(txDb);
    const member = await findMember(txDb, userId);
    if (!member) return fail("notFound");
    if (member.role === "owner" && member.passwordHash && role !== "owner" && (await ownerCount(txDb)) <= 1) return fail("lastOwner");
    await tx.update(users).set({ role }).where(eq(users.id, member.id));
    return ok();
  });
}

/**
 * Removes a member with their sessions and tokens. Not yourself, and never the last owner. Locks in
 * the global order (agency, every client whose pointer or rotation includes this member, the member's row)
 * before touching sessions and tokens, so it cannot deadlock with a password link being spent or
 * a ticket taking the next assignee. Rotations left empty turn off.
 */
export async function removeMember(actor: TeamSession, userId: string, deps: Deps = {}): Promise<Result> {
  if (!isOwner(actor)) return fail("forbidden");
  if (userId === actor.user.id) return fail("self");
  const db = deps.db ?? appDb;
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockTeam(txDb);
    const member = await findMember(txDb, userId);
    if (!member) return fail("notFound");
    await tx.select({ id: agency.id }).from(agency).where(eq(agency.id, 1)).for("update");
    // Deleting the user nulls `quotes.created_by_id` (ON DELETE SET NULL): lock those quotes now, right
    // after the agency, so the order stays agency, quote, client rows, users.
    await tx.select({ id: quotes.id }).from(quotes).where(eq(quotes.createdById, member.id)).orderBy(asc(quotes.id)).for("update");
    // Every client row turnOffEmptyRotations or the FK can touch: pointer on the member, or the member in its rotation.
    await tx
      .select({ id: clients.id })
      .from(clients)
      .where(
        or(
          eq(clients.autoAssignLastUserId, member.id),
          inArray(
            clients.id,
            tx
              .select({ id: autoAssignUsers.clientId })
              .from(autoAssignUsers)
              .where(and(eq(autoAssignUsers.userId, member.id), isNotNull(autoAssignUsers.clientId))),
          ),
        ),
      )
      .orderBy(asc(clients.id))
      .for("update");
    const [locked] = await tx
      .select({ id: users.id, role: users.role, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, member.id))
      .for("update");
    if (!locked) return fail("notFound");
    if (locked.role === "owner" && locked.passwordHash && (await ownerCount(txDb)) <= 1) return fail("lastOwner");
    await tx.delete(sessions).where(and(eq(sessions.userType, "agency"), eq(sessions.userId, member.id)));
    await tx.delete(authTokens).where(and(eq(authTokens.userType, "agency"), eq(authTokens.userId, member.id)));
    await tx.delete(users).where(eq(users.id, member.id));
    await turnOffEmptyRotations(txDb);
    return ok();
  });
}
