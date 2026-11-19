import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { z } from "zod";
import { cookies } from "next/headers";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  clientMemberships,
  clientUsers,
  clients,
  db as appDb,
  sessions,
  users,
  type Client,
  type ClientRole,
  type ClientUser,
  type Db,
  type User,
} from "@/lib/db";
import { fail, ok, type Result } from "@/lib/core/result";
import { getAppUrl } from "@/lib/app-url";

/** Team and portal sessions live in separate cookies, so both can be open in one browser. */
export const TEAM_COOKIE = "vx_team";
export const PORTAL_COOKIE = "vx_portal";
const SESSION_TTL_MS = 30 * 24 * 3600_000;

export type TeamSession = { userType: "agency"; user: User };
export type PortalSession = { userType: "client"; user: ClientUser; client: Client; role: ClientRole };
export type Company = { id: string; name: string; role: ClientRole };

/** The slice of Next's cookie store used here, so tests can pass a fake. */
export type CookieStore = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): unknown;
  delete(name: string): unknown;
};

type Deps = { store?: CookieStore; db?: Db };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Secure cookies when the public address is https; before it is known, in production. */
export async function cookieSecure(): Promise<boolean> {
  try {
    return (await getAppUrl()).startsWith("https");
  } catch {
    return process.env.NODE_ENV === "production";
  }
}

const cookieFor = (userType: "agency" | "client") => (userType === "agency" ? TEAM_COOKIE : PORTAL_COOKIE);

/** Opens a session for the user: stores sha256(token) and sets the cookie of that side. */
export async function createSession(
  userType: "agency" | "client",
  userId: string,
  deps: Deps & { secure?: boolean } = {},
): Promise<void> {
  const db = deps.db ?? appDb;
  const store = deps.store ?? ((await cookies()) as unknown as CookieStore);
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userType, userId, expiresAt });
  store.set(cookieFor(userType), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: deps.secure ?? (await cookieSecure()),
    path: "/",
    expires: expiresAt,
  });
}

/** Ends the session of one side only: its row and its cookie. */
export async function destroySession(userType: "agency" | "client", deps: Deps = {}): Promise<void> {
  const db = deps.db ?? appDb;
  const store = deps.store ?? ((await cookies()) as unknown as CookieStore);
  const name = cookieFor(userType);
  const token = store.get(name)?.value;
  if (token) {
    await db
      .delete(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), eq(sessions.userType, userType)));
  }
  store.delete(name);
}

/** The team session behind a cookie value, or null (unknown, expired, user gone, not a team session). */
export async function resolveTeamSession(token: string | undefined, db: Db = appDb): Promise<TeamSession | null> {
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        eq(sessions.userType, "agency"),
        gt(sessions.expiresAt, new Date()),
      ),
    );
  return row ? { userType: "agency", user: row.user } : null;
}

/** The companies a portal person belongs to, with their role in each, ordered by name. */
export async function listCompanies(clientUserId: string, db: Db = appDb): Promise<Company[]> {
  return db
    .select({ id: clients.id, name: clients.name, role: clientMemberships.role })
    .from(clientMemberships)
    .innerJoin(clients, eq(clients.id, clientMemberships.clientId))
    .where(eq(clientMemberships.clientUserId, clientUserId))
    .orderBy(asc(clients.name));
}

/**
 * The portal session behind a cookie value, or null (unknown, expired, person gone, not a
 * portal session, no company left). The active company is the one stored on the session while
 * the person is still a member of it; otherwise their oldest membership.
 */
export async function resolvePortalSession(token: string | undefined, db: Db = appDb): Promise<PortalSession | null> {
  if (!token) return null;
  const [row] = await db
    .select({ user: clientUsers, activeClientId: sessions.clientId })
    .from(sessions)
    .innerJoin(clientUsers, eq(clientUsers.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        eq(sessions.userType, "client"),
        gt(sessions.expiresAt, new Date()),
      ),
    );
  if (!row) return null;
  const memberships = await db
    .select({ client: clients, role: clientMemberships.role })
    .from(clientMemberships)
    .innerJoin(clients, eq(clients.id, clientMemberships.clientId))
    .where(eq(clientMemberships.clientUserId, row.user.id))
    .orderBy(asc(clientMemberships.createdAt), asc(clients.name));
  const active = memberships.find((m) => m.client.id === row.activeClientId) ?? memberships[0];
  if (!active) return null;
  return { userType: "client", user: row.user, client: active.client, role: active.role };
}

export const getTeamSession = cache(async (): Promise<TeamSession | null> => {
  const token = (await cookies()).get(TEAM_COOKIE)?.value;
  return resolveTeamSession(token);
});

export const getPortalSession = cache(async (): Promise<PortalSession | null> => {
  const token = (await cookies()).get(PORTAL_COOKIE)?.value;
  return resolvePortalSession(token);
});

/** Makes another company the active one for the current portal session; only the person's own. */
export async function switchActiveCompany(clientId: string, deps: Deps = {}): Promise<Result> {
  const db = deps.db ?? appDb;
  const store = deps.store ?? ((await cookies()) as unknown as CookieStore);
  const token = store.get(PORTAL_COOKIE)?.value;
  if (!token) return fail("notSignedIn");
  const tokenHash = hashToken(token);
  const [session] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userType, "client"), gt(sessions.expiresAt, new Date())));
  if (!session) return fail("notSignedIn");
  // A malformed id (a tampered form field) is simply not one of the person's companies.
  if (!z.uuid().safeParse(clientId).success) return fail("notMember");
  const [member] = await db
    .select({ clientId: clientMemberships.clientId })
    .from(clientMemberships)
    .where(and(eq(clientMemberships.clientUserId, session.userId), eq(clientMemberships.clientId, clientId)));
  if (!member) return fail("notMember");
  await db.update(sessions).set({ clientId }).where(eq(sessions.tokenHash, tokenHash));
  return ok();
}
