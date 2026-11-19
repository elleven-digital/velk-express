import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db as appDb, authTokens, type Db } from "@/lib/db";
import { getAppUrl } from "@/lib/app-url";

export const TOKEN_TTL = { invite: 7 * 24 * 3600_000, reset: 2 * 3600_000 };

type Purpose = "invite" | "reset";
type UserType = "agency" | "client";
export type TokenOwner = { userType: UserType; userId: string };

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Creates a single-use token and returns the raw value (only its hash is
 * stored). Older unused tokens of the same purpose and user stop working.
 */
export async function issueAuthToken(
  purpose: Purpose,
  userType: UserType,
  userId: string,
  db: Db = appDb,
): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  await db.transaction(async (tx) => {
    await tx
      .delete(authTokens)
      .where(
        and(
          eq(authTokens.purpose, purpose),
          eq(authTokens.userType, userType),
          eq(authTokens.userId, userId),
          isNull(authTokens.usedAt),
        ),
      );
    await tx.insert(authTokens).values({
      tokenHash: hashToken(raw),
      purpose,
      userType,
      userId,
      expiresAt: new Date(Date.now() + TOKEN_TTL[purpose]),
    });
  });
  return raw;
}

function valid(raw: string, purpose: Purpose) {
  return and(
    eq(authTokens.tokenHash, hashToken(raw)),
    eq(authTokens.purpose, purpose),
    isNull(authTokens.usedAt),
    gt(authTokens.expiresAt, new Date()),
  );
}

/** Marks the token used, atomically, so two requests cannot both win. */
export async function consumeAuthToken(raw: string, purpose: Purpose, db: Db = appDb): Promise<TokenOwner | null> {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(valid(raw, purpose))
    .returning({ userType: authTokens.userType, userId: authTokens.userId });
  return row ?? null;
}

/** Same checks as consume, without using the token (to render the form). */
export async function peekAuthToken(raw: string, purpose: Purpose, db: Db = appDb): Promise<TokenOwner | null> {
  const [row] = await db
    .select({ userType: authTokens.userType, userId: authTokens.userId })
    .from(authTokens)
    .where(valid(raw, purpose));
  return row ?? null;
}

/**
 * The side a token was issued for, whatever its validity (used, expired or live), or null for an
 * unknown token. Reads only the user type, which the link holder already knows.
 */
export async function tokenUserType(raw: string, db: Db = appDb): Promise<UserType | null> {
  const [row] = await db
    .select({ userType: authTokens.userType })
    .from(authTokens)
    .where(eq(authTokens.tokenHash, hashToken(raw)));
  return row?.userType ?? null;
}

/** The path (no origin) of the page where a token is redeemed. */
export function authLinkPath(raw: string): string {
  return `/set-password/${raw}`;
}

export async function authLink(raw: string): Promise<string> {
  return `${await getAppUrl()}${authLinkPath(raw)}`;
}
