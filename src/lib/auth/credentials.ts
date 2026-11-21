import { and, eq, isNull } from "drizzle-orm";
import {
  db as appDb,
  authTokens,
  clientMemberships,
  clientUsers,
  sessions,
  users,
  type ClientUser,
  type Db,
  type User,
} from "@/lib/db";
import { hashPassword, verifyPassword } from "./password";
import { consumeAuthToken, peekAuthToken, type TokenOwner } from "./tokens";
import { revokeAllConnections } from "@/lib/oauth/store";

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Which login a request belongs to: the agency team or the client portal. */
export type Side = "team" | "portal";

/** "portal" only for exactly "portal"; anything else is the team side. */
export function parseSide(value: unknown): Side {
  return value === "portal" ? "portal" : "team";
}

export function userTypeFor(side: Side): "agency" | "client" {
  return side === "portal" ? "client" : "agency";
}

let dummyHash: Promise<string> | null = null;

async function checkPassword(password: string, passwordHash: string | null | undefined): Promise<boolean> {
  if (!passwordHash) {
    // Unknown email or no password yet: spend the same hash time.
    dummyHash ??= hashPassword("velk-timing-equalizer");
    await verifyPassword(password, await dummyHash);
    return false;
  }
  return verifyPassword(password, passwordHash);
}

/** The team user with that email and password, or null. Unknown emails cost a hash too. */
export async function authenticate(email: string, password: string, db: Db = appDb): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  return (await checkPassword(password, user?.passwordHash)) ? user : null;
}

/** The portal person with that email and password who belongs to at least one company, or null. Same timing guard as `authenticate`. */
export async function authenticateClient(email: string, password: string, db: Db = appDb): Promise<ClientUser | null> {
  const [person] = await db.select().from(clientUsers).where(eq(clientUsers.email, normalizeEmail(email)));
  if (!(await checkPassword(password, person?.passwordHash))) return null;
  // A login with no company has nowhere to go: same answer as wrong credentials.
  const [membership] = await db
    .select({ id: clientMemberships.clientId })
    .from(clientMemberships)
    .where(eq(clientMemberships.clientUserId, person.id))
    .limit(1);
  return membership ? person : null;
}

export type ResetTarget = {
  userType: "agency" | "client";
  id: string;
  name: string;
  email: string;
  locale: string | null;
};

/** Who asked for a reset on that side's table only, or null. */
export async function findUserForReset(side: Side, email: string, db: Db = appDb): Promise<ResetTarget | null> {
  const table = side === "portal" ? clientUsers : users;
  const [row] = await db
    .select({ id: table.id, name: table.name, email: table.email, locale: table.locale })
    .from(table)
    .where(eq(table.email, normalizeEmail(email)));
  return row ? { userType: userTypeFor(side), ...row } : null;
}

export type PasswordTokenInfo = TokenOwner & { purpose: "invite" | "reset"; name: string };

/**
 * What a /set-password link is for, or null when the token is invalid, expired or used, or its
 * user is missing from the table of ITS side (a token never reaches the other side's users).
 */
export async function peekPasswordToken(raw: string, db: Db = appDb): Promise<PasswordTokenInfo | null> {
  for (const purpose of ["invite", "reset"] as const) {
    const owner = await peekAuthToken(raw, purpose, db);
    if (!owner) continue;
    const table = owner.userType === "client" ? clientUsers : users;
    const [row] = await db.select({ name: table.name }).from(table).where(eq(table.id, owner.userId));
    return row ? { ...owner, purpose, name: row.name } : null;
  }
  return null;
}

/** Thrown after the token was consumed but its user is gone; the transaction rolls back. */
export class TokenUserMissingError extends Error {
  constructor() {
    super("The user of this password token no longer exists.");
    this.name = "TokenUserMissingError";
  }
}

/**
 * Spends an invite or reset token and sets the password, in one transaction, on the table of
 * the token's side. An invite may also set the name; a reset signs that user out everywhere
 * and, on the team side, revokes their AI-app connections.
 * Every other unused token of that user (same type) is cancelled too.
 * Returns null (changing nothing, and without hashing) when the token cannot be used.
 * Throws TokenUserMissingError when the user vanished after the check: nothing is changed and
 * the token is not spent.
 */
export async function completePasswordToken(
  input: { token: string; password: string; name?: string },
  db: Db = appDb,
  hash: (password: string) => Promise<string> = hashPassword,
): Promise<TokenOwner | null> {
  // Cheap check first: an unknown, expired or used token must never cost a bcrypt hash.
  if (!(await peekPasswordToken(input.token, db))) return null;
  const passwordHash = await hash(input.password);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Lock the user's row BEFORE spending the token. Linking and resending lock the person's row and
    // then touch the tokens; taking the locks in the same order here rules out a deadlock.
    const peeked =
      (await peekAuthToken(input.token, "invite", txDb)) ?? (await peekAuthToken(input.token, "reset", txDb));
    if (!peeked) return null;
    const table = peeked.userType === "client" ? clientUsers : users;
    const [locked] = await tx.select({ id: table.id }).from(table).where(eq(table.id, peeked.userId)).for("update");
    if (!locked) throw new TokenUserMissingError();

    let purpose: "invite" | "reset" = "invite";
    let owner = await consumeAuthToken(input.token, "invite", txDb);
    if (!owner) {
      purpose = "reset";
      owner = await consumeAuthToken(input.token, "reset", txDb);
    }
    if (!owner) return null;

    const name = input.name?.trim();
    const set = { passwordHash, ...(purpose === "invite" && name ? { name } : {}) };
    const updated =
      owner.userType === "client"
        ? await tx.update(clientUsers).set(set).where(eq(clientUsers.id, owner.userId)).returning({ id: clientUsers.id })
        : await tx.update(users).set(set).where(eq(users.id, owner.userId)).returning({ id: users.id });
    if (updated.length === 0) throw new TokenUserMissingError();
    // Any other link still waiting for this user could set the password again.
    await tx
      .delete(authTokens)
      .where(
        and(eq(authTokens.userType, owner.userType), eq(authTokens.userId, owner.userId), isNull(authTokens.usedAt)),
      );
    if (purpose === "reset") {
      await tx
        .delete(sessions)
        .where(and(eq(sessions.userType, owner.userType), eq(sessions.userId, owner.userId)));
      // AI-app connections act as the team member: a new password cuts them off too.
      if (owner.userType === "agency") await revokeAllConnections(owner.userId, undefined, txDb);
    }
    return owner;
  });
}
