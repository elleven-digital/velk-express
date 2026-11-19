import "server-only";
import { and, asc, count, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agency,
  authTokens,
  clientMemberships,
  clientUsers,
  clients,
  db as appDb,
  sessions,
  type ClientRole,
  type ClientUser,
  type Db,
} from "@/lib/db";
import { isStaff } from "@/lib/access";
import { logoAbsoluteUrl } from "@/lib/agency";
import { authLink, issueAuthToken } from "@/lib/auth/tokens";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { getDict, isLocale, type Locale } from "@/lib/i18n";
import { buildInviteMail } from "@/lib/mail/messages/invite";
import { buildLinkedMail } from "@/lib/mail/messages/linked";
import { getAppUrl } from "@/lib/app-url";
import { sendMail } from "@/lib/mail/send";
import { fail, ok, type Result } from "./result";

/**
 * The people of a company, managed by the agency team (client Access tab) and by the company's
 * own admins (portal Users page) under the same rules: one login per e-mail, a company's first
 * person is an admin, and a company never loses its last admin who can sign in. The company id
 * always comes from the caller; for a portal actor it must be the session's own company.
 * Errors are codes the UI translates.
 */

export type PortalActor = TeamSession | PortalSession;
export type CompanyUser = { id: string; name: string; email: string; role: ClientRole; pending: boolean };

/** Test seams: the database and the mail sender. */
type Deps = { db?: Db; send?: typeof sendMail };

const ROLES = ["admin", "collaborator"] as const satisfies readonly ClientRole[];

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

/**
 * Who may manage this company: staff of the team (for a client that exists), or an admin of the
 * company itself. For a portal actor the role is read from the database, so a demotion that
 * happened after the session was resolved already applies.
 */
async function authorize(db: Db, actor: PortalActor, clientId: string): Promise<Result> {
  if (actor.userType === "agency") {
    if (!isStaff(actor.user)) return fail("forbidden");
    if (!uuid.safeParse(clientId).success) return fail("notFound");
    const [row] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
    return row ? ok() : fail("notFound");
  }
  if (actor.role !== "admin" || actor.client.id !== clientId) return fail("forbidden");
  const [row] = await db
    .select({ role: clientMemberships.role })
    .from(clientMemberships)
    .where(and(eq(clientMemberships.clientUserId, actor.user.id), eq(clientMemberships.clientId, clientId)));
  return row?.role === "admin" ? ok() : fail("forbidden");
}

/**
 * Serializes the edits of one company so two admins cannot remove each other at once. Lock order:
 * agency, quote, this portal lock, client row, client_users, users, then ticket rows. Whoever needs
 * both this lock and the client row takes this one first.
 */
export async function lockPortalCompany(tx: Db, clientId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"velk:portal:" + clientId}))`);
}

async function findMembership(db: Db, clientId: string, clientUserId: string) {
  if (!uuid.safeParse(clientUserId).success) return null;
  const [row] = await db
    .select({ person: clientUsers, role: clientMemberships.role })
    .from(clientMemberships)
    .innerJoin(clientUsers, eq(clientUsers.id, clientMemberships.clientUserId))
    .where(and(eq(clientMemberships.clientId, clientId), eq(clientMemberships.clientUserId, clientUserId)));
  return row ?? null;
}

/** Admins of the company who can sign in: a pending admin cannot manage anyone yet, so does not count. */
async function realAdminCount(tx: Db, clientId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(clientMemberships)
    .innerJoin(clientUsers, eq(clientUsers.id, clientMemberships.clientUserId))
    .where(
      and(
        eq(clientMemberships.clientId, clientId),
        eq(clientMemberships.role, "admin"),
        isNotNull(clientUsers.passwordHash),
      ),
    );
  return row?.n ?? 0;
}

/** Sends the invite e-mail in the person's language, then the agency's; false when it was not sent. */
async function mailInvite(db: Db, send: typeof sendMail, person: Pick<ClientUser, "name" | "email" | "locale">, link: string): Promise<boolean> {
  const [brand] = await db.select().from(agency).limit(1);
  const locale = isLocale(person.locale) ? person.locale : isLocale(brand?.locale) ? brand.locale : "en";
  const dict = await getDict(locale);
  const msg = buildInviteMail(dict.portal.inviteMail, {
    to: person.email,
    userName: person.name,
    agencyName: brand?.name ?? "Velk Express",
    logoUrl: await logoAbsoluteUrl(brand?.logoFileId ?? null),
    link,
  });
  return (await send(msg)).sent;
}

/** The mail is a courtesy: whatever goes wrong, the invite and its link still stand. Also sends the invite of a login created by quote execution. */
export async function tryMailInvite(...args: Parameters<typeof mailInvite>): Promise<boolean> {
  try {
    return await mailInvite(...args);
  } catch {
    return false;
  }
}

/** Tells an already active login that it now also reaches this company (best effort, never fails the link). Also used after quote execution. */
export async function tryMailLinked(
  db: Db,
  send: typeof sendMail,
  person: Pick<ClientUser, "name" | "email" | "locale">,
  clientId: string,
): Promise<void> {
  try {
    const [[brand], [company]] = await Promise.all([
      db.select().from(agency).limit(1),
      db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)),
    ]);
    const locale = isLocale(person.locale) ? person.locale : isLocale(brand?.locale) ? brand.locale : "en";
    const dict = await getDict(locale);
    const agencyName = brand?.name ?? "Velk Express";
    await send(
      buildLinkedMail(dict.portal.linkedMail, {
        to: person.email,
        userName: person.name,
        agencyName,
        clientName: company?.name ?? "",
        logoUrl: await logoAbsoluteUrl(brand?.logoFileId ?? null),
        resetLink: `${await getAppUrl()}/forgot?side=portal`,
      }),
    );
  } catch {
    // A courtesy notice: the link already stands.
  }
}

/** A company with no admin yet gets one: whoever comes first can manage the others. */
async function roleForNewMember(tx: Db, clientId: string, asked: ClientRole): Promise<ClientRole> {
  const [hasAdmin] = await tx
    .select({ id: clientMemberships.clientUserId })
    .from(clientMemberships)
    .where(and(eq(clientMemberships.clientId, clientId), eq(clientMemberships.role, "admin")))
    .limit(1);
  return hasAdmin ? asked : "admin";
}

/** A pending login still has an invite link out there; that link must not outlive a move to another company. */
async function revokePendingInvites(tx: Db, clientUserId: string): Promise<void> {
  await tx
    .delete(authTokens)
    .where(
      and(
        eq(authTokens.userType, "client"),
        eq(authTokens.userId, clientUserId),
        eq(authTokens.purpose, "invite"),
        isNull(authTokens.usedAt),
      ),
    );
}

/**
 * Gives an e-mail access to the company inside the caller's transaction, with the portal's usual
 * rules and no e-mail: the company's first login is an admin (the others collaborators); a login
 * that already exists, pending or active, is linked and gets no invite (a pending one has its old
 * invite links revoked); a new one is created without a password and gets an invite token. A login
 * that already belongs to the company is left as it is. The invite is returned only for a new login; `linkedActive` is set when an active login was just linked, so the caller can tell it after its commit (`tryMailLinked`).
 *
 * It takes the company's portal lock (`lockPortalCompany`). A caller that holds the client row must
 * call `lockPortalCompany` before locking that row, or it can deadlock with `invitePortalUser`. A
 * unique violation (23505) on a brand-new e-mail created at the same moment in another company must
 * be handled by the caller retrying the whole transaction.
 */
export async function ensurePortalLogin(
  tx: Db,
  clientId: string,
  input: { name: string; email: string; locale: Locale },
): Promise<{ clientUserId: string; invite: { token: string } | null; linkedActive: Pick<ClientUser, "name" | "email" | "locale"> | null }> {
  const email = input.email.trim().toLowerCase();
  await lockPortalCompany(tx, clientId);
  const role = await roleForNewMember(tx, clientId, "collaborator");
  const [existing] = await tx.select().from(clientUsers).where(eq(clientUsers.email, email)).for("update");
  if (existing) {
    const [member] = await tx
      .select({ id: clientMemberships.clientUserId })
      .from(clientMemberships)
      .where(and(eq(clientMemberships.clientUserId, existing.id), eq(clientMemberships.clientId, clientId)));
    if (!member) {
      if (!existing.passwordHash) await revokePendingInvites(tx, existing.id);
      await tx.insert(clientMemberships).values({ clientUserId: existing.id, clientId, role });
    }
    // Only a login that is active and was just linked deserves a notice (sent by the caller, after its commit).
    const linkedActive = !member && existing.passwordHash ? { name: existing.name, email: existing.email, locale: existing.locale } : null;
    return { clientUserId: existing.id, invite: null, linkedActive };
  }
  const [person] = await tx
    .insert(clientUsers)
    .values({ name: input.name, email, passwordHash: null, locale: input.locale })
    .returning();
  await tx.insert(clientMemberships).values({ clientUserId: person.id, clientId, role });
  return { clientUserId: person.id, invite: { token: await issueAuthToken("invite", "client", person.id, tx) }, linkedActive: null };
}

export async function listCompanyUsers(actor: PortalActor, clientId: string, deps: Deps = {}): Promise<Result<CompanyUser[]>> {
  const db = deps.db ?? appDb;
  const allowed = await authorize(db, actor, clientId);
  if (!allowed.ok) return allowed;
  const rows = await db
    .select({
      id: clientUsers.id,
      name: clientUsers.name,
      email: clientUsers.email,
      role: clientMemberships.role,
      passwordHash: clientUsers.passwordHash,
    })
    .from(clientMemberships)
    .innerJoin(clientUsers, eq(clientUsers.id, clientMemberships.clientUserId))
    .where(eq(clientMemberships.clientId, clientId))
    .orderBy(asc(clientMemberships.createdAt), asc(clientUsers.email));
  return ok(rows.map(({ passwordHash, ...r }) => ({ ...r, pending: !passwordHash })));
}

/**
 * The invite link a portal admin may see: only when no e-mail carried it. The agency team always
 * gets the link; a company admin who received the mail on someone else's behalf must not, or they
 * could set that person's password themselves.
 */
export function linkForPortalAdmin(link: string, emailed: boolean): string | null {
  return emailed ? null : link;
}

/** What the team is shown before it links an existing login: only that login's own companies. */
export type ExistingLogin = {
  name: string;
  active: boolean;
  companies: { name: string; role: ClientRole }[];
  willBeAdmin: boolean;
};

type Invited = {
  clientUserId: string;
  /** "confirm" means nothing was written: the team must confirm linking an existing login first. */
  outcome: "invited" | "linked" | "confirm";
  link: string | null;
  emailed: boolean;
  /** Linked outcome only: the login had no password yet (its earlier invite link was revoked). */
  wasPending?: boolean;
  /** Confirm outcome only. */
  existing?: ExistingLogin;
};

/**
 * Gives an e-mail access to the company. A new e-mail gets a login without password and an
 * invite link, which is also e-mailed when e-mail is set up. An e-mail that already has a login
 * (in another company) is never linked silently: the team first gets the outcome "confirm" with
 * the login's own companies, and links only by sending back `confirm` with that login's id and
 * its current active flag and the role it would get (checked under the locks, so a pending login
 * that became active, or a company that gained its first admin, in between asks again). A portal admin can never link an existing login (existsElsewhere).
 */
export async function invitePortalUser(
  actor: PortalActor,
  clientId: string,
  input: { name: string; email: string; role: ClientRole; confirm?: { clientUserId: string; active: boolean; willBeAdmin: boolean } },
  deps: Deps = {},
): Promise<Result<Invited>> {
  const db = deps.db ?? appDb;
  const parsed = inviteSchema.safeParse(input);
  // Authorization first, so a stranger learns nothing about what is valid.
  const allowed = await authorize(db, actor, clientId);
  if (!allowed.ok) return allowed;
  if (!parsed.success) return fail("invalid");
  const { name, email, role: asked } = parsed.data;
  const confirm = input.confirm;

  const attempt = () =>
    db.transaction(async (tx): Promise<Result<Invited & { person: Pick<ClientUser, "name" | "email" | "locale"> }>> => {
      const txDb = tx as unknown as Db;
      await lockPortalCompany(txDb, clientId);
      const again = await authorize(txDb, actor, clientId);
      if (!again.ok) return again;

      const isMember = async (personId: string) => {
        const [row] = await tx
          .select({ id: clientMemberships.clientUserId })
          .from(clientMemberships)
          .where(and(eq(clientMemberships.clientUserId, personId), eq(clientMemberships.clientId, clientId)));
        return Boolean(row);
      };

      if (actor.userType === "client") {
        // A login is global: a company's admin must never reach one that exists elsewhere (it could
        // take it over through a resend). Decided before any row lock, so another company's row is never held.
        const [known] = await tx.select({ id: clientUsers.id }).from(clientUsers).where(eq(clientUsers.email, email));
        if (known) return fail((await isMember(known.id)) ? "alreadyMember" : "existsElsewhere");
      }

      const role = await roleForNewMember(txDb, clientId, asked);

      // Locking the person's row keeps a concurrent removal from deleting the login under the new membership.
      const [existing] = await tx.select().from(clientUsers).where(eq(clientUsers.email, email)).for("update");
      if (existing) {
        if (await isMember(existing.id)) return fail("alreadyMember");
        if (actor.userType === "client") return fail("existsElsewhere");
        const active = Boolean(existing.passwordHash);
        if (!confirm || confirm.clientUserId !== existing.id || confirm.active !== active || confirm.willBeAdmin !== (role === "admin")) {
          const companies = await tx
            .select({ name: clients.name, role: clientMemberships.role })
            .from(clientMemberships)
            .innerJoin(clients, eq(clients.id, clientMemberships.clientId))
            .where(eq(clientMemberships.clientUserId, existing.id))
            .orderBy(asc(clients.name));
          return ok({
            clientUserId: existing.id,
            outcome: "confirm",
            link: null,
            emailed: false,
            existing: { name: existing.name, active, companies, willBeAdmin: role === "admin" },
            person: existing,
          });
        }
        if (!active) await revokePendingInvites(txDb, existing.id);
        await tx.insert(clientMemberships).values({ clientUserId: existing.id, clientId, role });
        return ok({
          clientUserId: existing.id,
          outcome: "linked",
          wasPending: !active,
          link: null,
          emailed: false,
          person: existing,
        });
      }

      const [person] = await tx.insert(clientUsers).values({ name, email, passwordHash: null, locale: null }).returning();
      await tx.insert(clientMemberships).values({ clientUserId: person.id, clientId, role });
      const link = await authLink(await issueAuthToken("invite", "client", person.id, txDb));
      return ok({ clientUserId: person.id, outcome: "invited", link, emailed: false, person });
    });

  let result: Awaited<ReturnType<typeof attempt>>;
  try {
    result = await attempt();
  } catch (err) {
    // The same new e-mail was invited into another company at the same moment: now it exists, so link it.
    if (!isConflict(err)) throw err;
    result = await attempt();
  }
  if (!result.ok) return result;

  const { person, ...value } = result.value;
  // Mailed after the commit: a mail failure must not undo the invite (the link is shown anyway).
  const send = deps.send ?? sendMail;
  if (value.outcome === "linked" && value.wasPending === false) await tryMailLinked(db, send, person, clientId);
  const emailed = value.link ? await tryMailInvite(db, send, person, value.link) : false;
  return ok({ ...value, emailed });
}

/** A fresh invite link (the old one stops working) for someone who has not set a password yet. */
export async function resendPortalInvite(
  actor: PortalActor,
  clientId: string,
  clientUserId: string,
  deps: Deps = {},
): Promise<Result<{ link: string; emailed: boolean }>> {
  const db = deps.db ?? appDb;
  const allowed = await authorize(db, actor, clientId);
  if (!allowed.ok) return allowed;

  const issued = await db.transaction(async (tx): Promise<Result<{ link: string; person: ClientUser }>> => {
    const txDb = tx as unknown as Db;
    await lockPortalCompany(txDb, clientId);
    const again = await authorize(txDb, actor, clientId);
    if (!again.ok) return again;
    if (!uuid.safeParse(clientUserId).success) return fail("notFound");
    // Row lock first: the person cannot finish setting a password, or be removed, between the checks and the token.
    const [person] = await tx.select().from(clientUsers).where(eq(clientUsers.id, clientUserId)).for("update");
    if (!person) return fail("notFound");
    const member = await findMembership(txDb, clientId, clientUserId);
    if (!member) return fail("notFound");
    if (actor.userType === "client") {
      // A login shared with another company is not this company's to re-issue links for.
      const [other] = await tx
        .select({ clientId: clientMemberships.clientId })
        .from(clientMemberships)
        .where(and(eq(clientMemberships.clientUserId, person.id), ne(clientMemberships.clientId, clientId)))
        .limit(1);
      if (other) return fail("forbidden");
    }
    if (person.passwordHash) return fail("alreadyActive");
    return ok({ link: await authLink(await issueAuthToken("invite", "client", person.id, txDb)), person });
  });
  if (!issued.ok) return issued;
  const emailed = await tryMailInvite(db, deps.send ?? sendMail, issued.value.person, issued.value.link);
  return ok({ link: issued.value.link, emailed });
}

/** A reset link for a person who has a password; the team passes it on (no e-mail). Staff only. */
export async function createPortalResetLink(
  actor: TeamSession,
  clientId: string,
  clientUserId: string,
  deps: Deps = {},
): Promise<Result<{ link: string }>> {
  const db = deps.db ?? appDb;
  // Checked at runtime too: a portal admin must never reach this, whatever the types say.
  if ((actor as PortalActor).userType !== "agency") return fail("forbidden");
  const allowed = await authorize(db, actor, clientId);
  if (!allowed.ok) return allowed;
  const member = await findMembership(db, clientId, clientUserId);
  if (!member) return fail("notFound");
  if (!member.person.passwordHash) return fail("invalid");
  return ok({ link: await authLink(await issueAuthToken("reset", "client", member.person.id, db)) });
}

/** Changes a person's role in this company; the company keeps at least one admin who can sign in. */
export async function setPortalRole(
  actor: PortalActor,
  clientId: string,
  clientUserId: string,
  role: ClientRole,
  deps: Deps = {},
): Promise<Result> {
  const db = deps.db ?? appDb;
  const allowed = await authorize(db, actor, clientId);
  if (!allowed.ok) return allowed;
  if (!(ROLES as readonly string[]).includes(role)) return fail("invalid");
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockPortalCompany(txDb, clientId);
    const again = await authorize(txDb, actor, clientId);
    if (!again.ok) return again;
    const member = await findMembership(txDb, clientId, clientUserId);
    if (!member) return fail("notFound");
    if (member.role === "admin" && role !== "admin" && member.person.passwordHash && (await realAdminCount(txDb, clientId)) <= 1) {
      return fail("lastAdmin");
    }
    await tx
      .update(clientMemberships)
      .set({ role })
      .where(and(eq(clientMemberships.clientUserId, member.person.id), eq(clientMemberships.clientId, clientId)));
    return ok();
  });
}

/**
 * Takes a person out of this company. When it was their last one the login goes too, with its
 * sessions and tokens (sessions carry no foreign key, so they are deleted here).
 */
export async function removePortalUser(
  actor: PortalActor,
  clientId: string,
  clientUserId: string,
  deps: Deps = {},
): Promise<Result<{ loginDeleted: boolean }>> {
  const db = deps.db ?? appDb;
  const allowed = await authorize(db, actor, clientId);
  if (!allowed.ok) return allowed;
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockPortalCompany(txDb, clientId);
    const again = await authorize(txDb, actor, clientId);
    if (!again.ok) return again;
    const member = await findMembership(txDb, clientId, clientUserId);
    if (!member) return fail("notFound");
    if (member.role === "admin" && member.person.passwordHash && (await realAdminCount(txDb, clientId)) <= 1) {
      return fail("lastAdmin");
    }
    // Locked so a link to another company cannot slip in between the count and the delete.
    await tx.select({ id: clientUsers.id }).from(clientUsers).where(eq(clientUsers.id, member.person.id)).for("update");
    await tx
      .delete(clientMemberships)
      .where(and(eq(clientMemberships.clientUserId, member.person.id), eq(clientMemberships.clientId, clientId)));
    const [left] = await tx
      .select({ n: count() })
      .from(clientMemberships)
      .where(eq(clientMemberships.clientUserId, member.person.id));
    if ((left?.n ?? 0) > 0) {
      // Their session must not keep acting for this company.
      await tx
        .update(sessions)
        .set({ clientId: null })
        .where(and(eq(sessions.userType, "client"), eq(sessions.userId, member.person.id), eq(sessions.clientId, clientId)));
      return ok({ loginDeleted: false });
    }
    await tx.delete(sessions).where(and(eq(sessions.userType, "client"), eq(sessions.userId, member.person.id)));
    await tx
      .delete(authTokens)
      .where(and(eq(authTokens.userType, "client"), eq(authTokens.userId, member.person.id)));
    await tx.delete(clientUsers).where(eq(clientUsers.id, member.person.id));
    return ok({ loginDeleted: true });
  });
}
