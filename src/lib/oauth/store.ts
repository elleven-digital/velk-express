import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db as appDb,
  oauthClients,
  oauthCodes,
  oauthConnections,
  oauthTokens,
  type Db,
  type OAuthClientRow,
} from "@/lib/db";
import { defaultMetadataDeps, fetchClientMetadata, type MetadataDeps } from "@/lib/oauth/client-metadata";
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  LAST_USED_EVERY_MS,
  OAUTH_SCOPE,
  REFRESH_IDLE_TTL_MS,
  hashSecret,
  mcpResourceUrl,
  newSecret,
  sameResource,
  verifyPkce,
} from "@/lib/oauth/rules";

/**
 * Storage of the AI-app login: apps, codes, tokens and connections. No
 * Next.js here — the authorize page, the token route and /mcp call these
 * functions. Every function takes an optional `db` (a transaction works too).
 *
 * Every code and token is stored hashed; the raw value leaves once, in the
 * return value, and never goes to a log. Every validity check takes `now`.
 *
 * A connection is bound to the resource it was granted for (the install's
 * `/mcp` URL at that moment): after the public address changes, its tokens
 * no longer verify nor refresh, and the person reconnects.
 *
 * Locks: exchanging a code takes the code row (FOR UPDATE); refreshing, the
 * token row; revoking, the connection row. Two concurrent refreshes with the
 * same token queue on its row and the second finds it already replaced —
 * that's reuse, and it revokes the connection.
 */

export type OAuthClient = {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  kind: "registered" | "metadata_document";
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  /** Seconds, as RFC 6749 says. */
  expiresIn: number;
  scope: typeof OAUTH_SCOPE;
};

export type TokenError = "invalid_grant" | "invalid_target";

/** What a client ID metadata document said, or a refusal (the fetcher never throws). */
export type ClientMetadata =
  | { ok: true; name: string; redirectUris: string[]; ttlMs: number }
  | { ok: false };

export type ClientMetadataFetcher = (clientId: string) => Promise<ClientMetadata>;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const uuid = z.uuid();
const isUuid = (value: string) => uuid.safeParse(value).success;

/** Longest client_id looked up: a metadata document URL is capped at 2048 characters. */
const CLIENT_ID_MAX = 2048;

function fromRow(row: OAuthClientRow): OAuthClient {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    redirectUris: row.redirectUris,
    kind: row.kind,
  };
}

// ---------- apps ----------

/** Saves a dynamically registered app: its client_id is the row id. */
export async function registerClient(
  value: { name: string; redirectUris: string[] },
  now: Date = new Date(),
  db: Db = appDb,
): Promise<OAuthClient> {
  const id = randomUUID();
  const [row] = await db
    .insert(oauthClients)
    .values({ id, kind: "registered", clientId: id, name: value.name, redirectUris: value.redirectUris, createdAt: now })
    .returning();
  return fromRow(row);
}

/**
 * Any client_id to its app, or `null`: a registered one by id; a metadata
 * document by the cached copy while it's fresh, else by a new fetch that
 * updates the same row. A refused fetch is `null`, even with a stale copy.
 * The fetch is `fetchClientMetadata` (over `deps`, the real network by
 * default) unless a `fetchMetadata` is given.
 */
export async function resolveClient(
  clientId: string,
  opts: { fetchMetadata?: ClientMetadataFetcher; deps?: MetadataDeps; now?: Date; db?: Db } = {},
): Promise<OAuthClient | null> {
  const now = opts.now ?? new Date();
  const db = opts.db ?? appDb;
  if (!clientId || clientId.length > CLIENT_ID_MAX) return null;
  if (isUuid(clientId)) {
    const [row] = await db
      .select()
      .from(oauthClients)
      .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.kind, "registered")));
    return row ? fromRow(row) : null;
  }

  const [cached] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.kind, "metadata_document")));
  if (cached?.cacheExpiresAt && cached.cacheExpiresAt.getTime() > now.getTime()) {
    return fromRow(cached);
  }
  const fetched = opts.fetchMetadata
    ? await opts.fetchMetadata(clientId)
    : await fetchClientMetadata(clientId, opts.deps ?? defaultMetadataDeps);
  if (!fetched.ok) return null;
  const values = {
    name: fetched.name,
    redirectUris: fetched.redirectUris,
    cacheExpiresAt: new Date(now.getTime() + fetched.ttlMs),
  };
  const [row] = await db
    .insert(oauthClients)
    .values({ kind: "metadata_document", clientId, createdAt: now, ...values })
    .onConflictDoUpdate({ target: oauthClients.clientId, set: values })
    .returning();
  return fromRow(row);
}

/** Has this client_id been seen before? Database only — the token route never fetches. */
export async function isKnownClient(clientId: string, db: Db = appDb): Promise<boolean> {
  if (!clientId || clientId.length > CLIENT_ID_MAX) return false;
  const [row] = await db
    .select({ id: oauthClients.id })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return Boolean(row);
}

// ---------- codes and tokens ----------

async function writePair(tx: Tx, connectionId: string, now: Date): Promise<TokenSet> {
  const accessToken = newSecret("vat_");
  const refreshToken = newSecret("vrt_");
  await tx.insert(oauthTokens).values({
    connectionId,
    accessHash: hashSecret(accessToken),
    refreshHash: hashSecret(refreshToken),
    accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_IDLE_TTL_MS),
    createdAt: now,
  });
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_MS / 1000, scope: OAUTH_SCOPE };
}

async function revokeInTx(tx: Tx, connectionId: string, now: Date) {
  await tx
    .update(oauthConnections)
    .set({ revokedAt: now })
    .where(and(eq(oauthConnections.id, connectionId), isNull(oauthConnections.revokedAt)));
}

/**
 * The authorization code, after "Authorize". `clientId` is the app's public
 * client_id (already resolved by the caller, who also checked the redirect
 * URI, challenge and resource); an unknown one throws. Also sweeps codes
 * expired more than a day ago (there is no scheduler).
 */
export async function createAuthorizationCode(input: {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  now?: Date;
  db?: Db;
}): Promise<string> {
  const now = input.now ?? new Date();
  const db = input.db ?? appDb;
  const [app] = await db
    .select({ id: oauthClients.id })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, input.clientId));
  if (!app) throw new Error("Unknown OAuth client.");

  const code = newSecret("vac_");
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
  await db.insert(oauthCodes).values({
    codeHash: hashSecret(code),
    userId: input.userId,
    appId: app.id,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    createdAt: now,
  });
  return code;
}

type Exchange = { ok: true; tokens: TokenSet; connectionId: string } | { ok: false; error: TokenError };

/**
 * Exchanges the code for the first token pair and creates the connection,
 * bound to the resource the code was issued for. Valid once, in time, and
 * only for the app, redirect URI and PKCE verifier it was issued with.
 * Replayed, it's refused and revokes the connection it created. `resource`
 * absent means the one the code was issued for.
 */
export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string | null;
  now?: Date;
  db?: Db;
}): Promise<Exchange> {
  const now = input.now ?? new Date();
  const db = input.db ?? appDb;
  if (!input.code.startsWith("vac_")) return { ok: false, error: "invalid_grant" };

  return db.transaction(async (tx): Promise<Exchange> => {
    const [found] = await tx
      .select({ code: oauthCodes, publicClientId: oauthClients.clientId })
      .from(oauthCodes)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthCodes.appId))
      .where(eq(oauthCodes.codeHash, hashSecret(input.code)))
      .for("update", { of: oauthCodes });
    if (!found) return { ok: false, error: "invalid_grant" };
    const { code } = found;

    if (code.usedAt) {
      if (code.connectionId) await revokeInTx(tx, code.connectionId, now);
      return { ok: false, error: "invalid_grant" };
    }
    if (
      code.expiresAt.getTime() <= now.getTime() ||
      found.publicClientId !== input.clientId ||
      code.redirectUri !== input.redirectUri ||
      !verifyPkce(input.codeVerifier, code.codeChallenge)
    ) {
      return { ok: false, error: "invalid_grant" };
    }
    if (input.resource !== null && !sameResource(input.resource, code.resource)) {
      return { ok: false, error: "invalid_target" };
    }

    const [connection] = await tx
      .insert(oauthConnections)
      .values({ userId: code.userId, appId: code.appId, resource: code.resource, createdAt: now })
      .returning({ id: oauthConnections.id });
    await tx.update(oauthCodes).set({ usedAt: now, connectionId: connection.id }).where(eq(oauthCodes.id, code.id));
    const tokens = await writePair(tx, connection.id, now);
    return { ok: true, tokens, connectionId: connection.id };
  });
}

/**
 * Refresh: replaces the whole pair and restarts the 60 days. A refresh token
 * that was already replaced revokes the whole connection (sign of a leak).
 * `canonicalResource` is the install's current `/mcp` URL (read from the
 * public address when omitted): a connection granted for another one is
 * `invalid_grant`, a requested `resource` other than it is `invalid_target`.
 * Also sweeps the connection's rows whose refresh token expired.
 */
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
  resource: string | null;
  canonicalResource?: string;
  now?: Date;
  db?: Db;
}): Promise<Exchange> {
  const now = input.now ?? new Date();
  const db = input.db ?? appDb;
  if (!input.refreshToken.startsWith("vrt_")) return { ok: false, error: "invalid_grant" };
  const canonical = input.canonicalResource ?? (await mcpResourceUrl());

  return db.transaction(async (tx): Promise<Exchange> => {
    const [found] = await tx
      .select({ token: oauthTokens, connection: oauthConnections, publicClientId: oauthClients.clientId })
      .from(oauthTokens)
      .innerJoin(oauthConnections, eq(oauthConnections.id, oauthTokens.connectionId))
      .innerJoin(oauthClients, eq(oauthClients.id, oauthConnections.appId))
      .where(eq(oauthTokens.refreshHash, hashSecret(input.refreshToken)))
      .for("update", { of: oauthTokens });
    if (!found) return { ok: false, error: "invalid_grant" };
    const { token, connection } = found;

    if (token.replacedAt) {
      await revokeInTx(tx, token.connectionId, now);
      return { ok: false, error: "invalid_grant" };
    }
    if (
      connection.revokedAt ||
      token.refreshExpiresAt.getTime() <= now.getTime() ||
      found.publicClientId !== input.clientId ||
      !sameResource(connection.resource, canonical)
    ) {
      return { ok: false, error: "invalid_grant" };
    }
    if (input.resource !== null && !sameResource(input.resource, canonical)) {
      return { ok: false, error: "invalid_target" };
    }

    await tx.update(oauthTokens).set({ replacedAt: now }).where(eq(oauthTokens.id, token.id));
    await tx
      .delete(oauthTokens)
      .where(and(eq(oauthTokens.connectionId, token.connectionId), lte(oauthTokens.refreshExpiresAt, now)));
    const tokens = await writePair(tx, token.connectionId, now);
    return { ok: true, tokens, connectionId: token.connectionId };
  });
}

export type VerifiedAccess = {
  userId: string;
  connectionId: string;
  /** The app's public client_id. */
  clientId: string;
  clientName: string;
  /** The resource the connection was granted for (the connector URL). */
  resource: string;
  /** When this access token stops working. */
  expiresAt: Date;
};

/**
 * Is the access token valid for `resource` (the install's current `/mcp`
 * URL)? Returns the person, connection and app, or `null` for a token
 * without the prefix, unknown, expired, replaced, of a revoked connection or
 * of a connection granted for another resource. Marks the connection's last
 * use at most once a minute.
 */
export async function verifyAccessToken(
  token: string,
  resource: string,
  now: Date = new Date(),
  db: Db = appDb,
): Promise<VerifiedAccess | null> {
  if (!token.startsWith("vat_")) return null;
  const [found] = await db
    .select({
      token: oauthTokens,
      connection: oauthConnections,
      app: { clientId: oauthClients.clientId, name: oauthClients.name },
    })
    .from(oauthTokens)
    .innerJoin(oauthConnections, eq(oauthConnections.id, oauthTokens.connectionId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthConnections.appId))
    .where(eq(oauthTokens.accessHash, hashSecret(token)));
  if (
    !found ||
    found.token.replacedAt ||
    found.connection.revokedAt ||
    found.token.accessExpiresAt.getTime() <= now.getTime() ||
    !sameResource(found.connection.resource, resource)
  ) {
    return null;
  }

  const last = found.connection.lastUsedAt;
  if (!last || now.getTime() - last.getTime() >= LAST_USED_EVERY_MS) {
    // The condition again in the UPDATE: two simultaneous requests write once.
    await db
      .update(oauthConnections)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(oauthConnections.id, found.connection.id),
          or(
            isNull(oauthConnections.lastUsedAt),
            lte(oauthConnections.lastUsedAt, new Date(now.getTime() - LAST_USED_EVERY_MS)),
          ),
        ),
      );
  }

  return {
    userId: found.connection.userId,
    connectionId: found.connection.id,
    clientId: found.app.clientId,
    clientName: found.app.name,
    resource: found.connection.resource,
    expiresAt: found.token.accessExpiresAt,
  };
}

// ---------- connections (Settings → AI connections) ----------

export type ConnectionView = {
  id: string;
  clientName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/**
 * The person's active connections, newest first: not revoked and with a
 * refresh token still valid — a connection idle for 60 days is useless and
 * isn't listed.
 */
export async function listActiveConnections(
  userId: string,
  now: Date = new Date(),
  db: Db = appDb,
): Promise<ConnectionView[]> {
  const alive = db
    .select({ one: sql`1` })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.connectionId, oauthConnections.id),
        isNull(oauthTokens.replacedAt),
        gt(oauthTokens.refreshExpiresAt, now),
      ),
    );
  return db
    .select({
      id: oauthConnections.id,
      clientName: oauthClients.name,
      createdAt: oauthConnections.createdAt,
      lastUsedAt: oauthConnections.lastUsedAt,
    })
    .from(oauthConnections)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthConnections.appId))
    .where(and(eq(oauthConnections.userId, userId), isNull(oauthConnections.revokedAt), sql`exists (${alive})`))
    .orderBy(desc(oauthConnections.createdAt), desc(oauthConnections.id));
}

/**
 * Revokes one of the person's connections: its tokens stop working on the
 * next request. Someone else's connection, or a malformed id, is
 * `not_found` — same as one that doesn't exist.
 */
export async function revokeConnection(input: {
  userId: string;
  connectionId: string;
  now?: Date;
  db?: Db;
}): Promise<"revoked" | "already_revoked" | "not_found"> {
  if (!isUuid(input.connectionId)) return "not_found";
  const now = input.now ?? new Date();
  const db = input.db ?? appDb;
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ revokedAt: oauthConnections.revokedAt })
      .from(oauthConnections)
      .where(and(eq(oauthConnections.id, input.connectionId), eq(oauthConnections.userId, input.userId)))
      .for("update");
    if (!connection) return "not_found";
    if (connection.revokedAt) return "already_revoked";
    await tx.update(oauthConnections).set({ revokedAt: now }).where(eq(oauthConnections.id, input.connectionId));
    return "revoked";
  });
}

/**
 * Revokes every live connection of the person, and burns their unexchanged
 * codes: changing or resetting the password, or leaving the team, also cuts
 * the AI apps, which can act for the account as much as a session can.
 * Returns how many connections it revoked.
 */
export async function revokeAllConnections(userId: string, now: Date = new Date(), db: Db = appDb): Promise<number> {
  await db
    .update(oauthCodes)
    .set({ usedAt: now })
    .where(and(eq(oauthCodes.userId, userId), isNull(oauthCodes.usedAt)));
  const revoked = await db
    .update(oauthConnections)
    .set({ revokedAt: now })
    .where(and(eq(oauthConnections.userId, userId), isNull(oauthConnections.revokedAt)))
    .returning({ id: oauthConnections.id });
  return revoked.length;
}
