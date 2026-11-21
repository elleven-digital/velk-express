import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { oauthClients, oauthCodes, oauthConnections, oauthTokens, users } from "@/lib/db";
import { CODE_TTL_MS, LAST_USED_EVERY_MS, REFRESH_IDLE_TTL_MS, hashSecret, pkceChallengeOf } from "./rules";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  isKnownClient,
  listActiveConnections,
  refreshAccessToken,
  registerClient,
  resolveClient,
  revokeAllConnections,
  revokeConnection,
  verifyAccessToken,
  type OAuthClient,
  type TokenSet,
} from "./store";
import type { MetadataDeps } from "./client-metadata";

// getConfig() is lazy: the test database and a fixed public address (refresh reads it by default).
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://a.test";

const RESOURCE = "https://a.test/mcp";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(43);
const T0 = new Date("2026-11-21T12:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

let db: Db;
let userId: string;
let client: OAuthClient;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  const [u] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner" }).returning();
  userId = u.id;
  client = await registerClient({ name: "Claude", redirectUris: [REDIRECT] }, T0, db);
});

afterAll(async () => {
  await db?.$client.end();
});

function issueCode(overrides: { userId?: string; resource?: string; now?: Date } = {}) {
  return createAuthorizationCode({
    userId: overrides.userId ?? userId,
    clientId: client.clientId,
    redirectUri: REDIRECT,
    codeChallenge: pkceChallengeOf(VERIFIER),
    resource: overrides.resource ?? RESOURCE,
    now: overrides.now ?? T0,
    db,
  });
}

function exchange(code: string, overrides: Partial<{ clientId: string; redirectUri: string; codeVerifier: string; resource: string | null; now: Date }> = {}) {
  return exchangeAuthorizationCode({
    code,
    clientId: client.clientId,
    redirectUri: REDIRECT,
    codeVerifier: VERIFIER,
    resource: RESOURCE,
    now: T0,
    db,
    ...overrides,
  });
}

async function connect(resource = RESOURCE): Promise<{ tokens: TokenSet; connectionId: string }> {
  const res = await exchange(await issueCode({ resource }), { resource });
  if (!res.ok) throw new Error(`exchange failed: ${res.error}`);
  return res;
}

function refresh(refreshToken: string, overrides: Partial<{ clientId: string; resource: string | null; canonicalResource: string; now: Date }> = {}) {
  return refreshAccessToken({
    refreshToken,
    clientId: client.clientId,
    resource: RESOURCE,
    canonicalResource: RESOURCE,
    now: later(60_000),
    db,
    ...overrides,
  });
}

describe("apps", () => {
  it("registers an app whose public client_id is its row id", async () => {
    expect(client).toMatchObject({ clientId: client.id, name: "Claude", redirectUris: [REDIRECT], kind: "registered" });
    expect(await resolveClient(client.clientId, { db })).toEqual(client);
    expect(await isKnownClient(client.clientId, db)).toBe(true);
  });

  it("an unknown or malformed client_id resolves to null and is not known", async () => {
    expect(await resolveClient("6f1c1c1e-0000-4000-8000-000000000000", { db })).toBeNull();
    expect(await resolveClient("not-a-client", { db })).toBeNull();
    expect(await isKnownClient("6f1c1c1e-0000-4000-8000-000000000000", db)).toBe(false);
    expect(await isKnownClient("x".repeat(5000), db)).toBe(false);
  });

  it("a metadata document is fetched once, cached while fresh and refetched when stale", async () => {
    const url = "https://app.example/oauth/client.json";
    const fetchMetadata = vi.fn(async () => ({ ok: true as const, name: "Doc App", redirectUris: [REDIRECT], ttlMs: 60_000 }));
    const first = await resolveClient(url, { fetchMetadata, now: T0, db });
    expect(first).toMatchObject({ clientId: url, name: "Doc App", kind: "metadata_document" });
    await resolveClient(url, { fetchMetadata, now: later(30_000), db });
    expect(fetchMetadata).toHaveBeenCalledTimes(1);

    fetchMetadata.mockResolvedValueOnce({ ok: true, name: "Doc App 2", redirectUris: [REDIRECT], ttlMs: 60_000 });
    const again = await resolveClient(url, { fetchMetadata, now: later(120_000), db });
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ id: first?.id, name: "Doc App 2" });
    expect(await isKnownClient(url, db)).toBe(true);
  });

  it("a refused fetch is null even with a stale copy", async () => {
    const url = "https://app.example/oauth/client.json";
    await resolveClient(url, { fetchMetadata: async () => ({ ok: true, name: "Doc", redirectUris: [REDIRECT], ttlMs: 1000 }), now: T0, db });
    expect(await resolveClient(url, { fetchMetadata: async () => ({ ok: false }), now: later(5000), db })).toBeNull();
  });

  it("without a fetcher, a metadata document is fetched and checked by fetchClientMetadata", async () => {
    const url = "https://app.example/oauth/client.json";
    const document = { client_id: url, client_name: "Doc App", redirect_uris: [REDIRECT] };
    const deps: MetadataDeps = {
      lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
      fetch: vi.fn(async () => Response.json(document, { headers: { "Cache-Control": "max-age=600" } })),
    };
    const resolved = await resolveClient(url, { deps, now: T0, db });
    expect(resolved).toMatchObject({ clientId: url, name: "Doc App", redirectUris: [REDIRECT], kind: "metadata_document" });
    expect(deps.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "manual" }));
    const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, url));
    expect(row.cacheExpiresAt).toEqual(later(600_000));

    // A document served from a private address is refused, even with a stale copy.
    const internal: MetadataDeps = {
      lookup: async () => [{ address: "10.0.0.5", family: 4 }],
      fetch: vi.fn(async () => Response.json(document)),
    };
    expect(await resolveClient(url, { deps: internal, now: later(700_000), db })).toBeNull();
    expect(internal.fetch).not.toHaveBeenCalled();
  });
});

describe("authorization code", () => {
  it("exchanges for a token pair, stores only hashes and creates a connection", async () => {
    const code = await issueCode();
    expect(code).toMatch(/^vac_/);
    const res = await exchange(code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tokens).toMatchObject({ expiresIn: 3600, scope: "velk" });
    expect(res.tokens.accessToken).toMatch(/^vat_/);
    expect(res.tokens.refreshToken).toMatch(/^vrt_/);

    const [codeRow] = await db.select().from(oauthCodes);
    expect(codeRow.codeHash).toBe(hashSecret(code));
    const [tokenRow] = await db.select().from(oauthTokens);
    expect(tokenRow.accessHash).toBe(hashSecret(res.tokens.accessToken));
    expect(tokenRow.refreshHash).toBe(hashSecret(res.tokens.refreshToken));
    const dump = JSON.stringify(await db.execute(sql`select * from oauth_codes, oauth_tokens`));
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(res.tokens.accessToken);
    expect(dump).not.toContain(res.tokens.refreshToken);

    const [connection] = await db.select().from(oauthConnections);
    expect(connection).toMatchObject({ id: res.connectionId, userId, appId: client.id, resource: RESOURCE, revokedAt: null });
  });

  it("used twice is invalid_grant, and the replay revokes the connection it created", async () => {
    const code = await issueCode();
    const first = await exchange(code);
    expect(first.ok).toBe(true);
    expect(await exchange(code)).toEqual({ ok: false, error: "invalid_grant" });
    if (!first.ok) return;
    expect(await verifyAccessToken(first.tokens.accessToken, RESOURCE, T0, db)).toBeNull();
  });

  it("expired (11 minutes later) is invalid_grant", async () => {
    const code = await issueCode();
    expect(CODE_TTL_MS).toBe(10 * 60_000);
    expect(await exchange(code, { now: later(11 * 60_000) })).toEqual({ ok: false, error: "invalid_grant" });
  });

  it("only works for its app, redirect URI and verifier", async () => {
    const other = await registerClient({ name: "Other", redirectUris: [REDIRECT] }, T0, db);
    const code = await issueCode();
    expect(await exchange(code, { clientId: other.clientId })).toEqual({ ok: false, error: "invalid_grant" });
    expect(await exchange(code, { redirectUri: `${REDIRECT}/x` })).toEqual({ ok: false, error: "invalid_grant" });
    expect(await exchange(code, { codeVerifier: "w".repeat(43) })).toEqual({ ok: false, error: "invalid_grant" });
    expect(await exchange("not-a-code")).toEqual({ ok: false, error: "invalid_grant" });
    expect((await exchange(code)).ok).toBe(true);
  });

  it("another resource is invalid_target; no resource means the one it was issued for", async () => {
    const code = await issueCode();
    expect(await exchange(code, { resource: "https://b.test/mcp" })).toEqual({ ok: false, error: "invalid_target" });
    expect((await exchange(code, { resource: null })).ok).toBe(true);
  });

  it("creating a code sweeps codes expired more than a day ago", async () => {
    await issueCode();
    await issueCode({ now: later(2 * 24 * 60 * 60_000) });
    expect(await db.select().from(oauthCodes)).toHaveLength(1);
  });

  it("refuses an unknown app", async () => {
    await expect(
      createAuthorizationCode({
        userId,
        clientId: "6f1c1c1e-0000-4000-8000-000000000000",
        redirectUri: REDIRECT,
        codeChallenge: pkceChallengeOf(VERIFIER),
        resource: RESOURCE,
        now: T0,
        db,
      }),
    ).rejects.toThrow();
  });
});

describe("access token", () => {
  it("verifies to the person, connection and app", async () => {
    const { tokens, connectionId } = await connect();
    expect(await verifyAccessToken(tokens.accessToken, RESOURCE, T0, db)).toEqual({
      userId,
      connectionId,
      clientId: client.clientId,
      clientName: "Claude",
      resource: RESOURCE,
      expiresAt: later(60 * 60_000),
    });
  });

  it("is null without the prefix, unknown, or after one hour", async () => {
    const { tokens } = await connect();
    expect(await verifyAccessToken("nope", RESOURCE, T0, db)).toBeNull();
    expect(await verifyAccessToken("vat_unknown", RESOURCE, T0, db)).toBeNull();
    expect(await verifyAccessToken(tokens.accessToken, RESOURCE, later(60 * 60_000), db)).toBeNull();
  });

  it("issued for https://a.test/mcp is null when checked against https://b.test/mcp", async () => {
    const { tokens } = await connect("https://a.test/mcp");
    expect(await verifyAccessToken(tokens.accessToken, "https://b.test/mcp", T0, db)).toBeNull();
    expect(await verifyAccessToken(tokens.accessToken, "https://a.test/mcp", T0, db)).not.toBeNull();
  });

  it("writes the connection's last use at most once a minute", async () => {
    const { tokens, connectionId } = await connect();
    const lastUsed = async () =>
      (await db.select().from(oauthConnections).where(eq(oauthConnections.id, connectionId)))[0].lastUsedAt;
    await verifyAccessToken(tokens.accessToken, RESOURCE, T0, db);
    expect(await lastUsed()).toEqual(T0);
    await verifyAccessToken(tokens.accessToken, RESOURCE, later(LAST_USED_EVERY_MS - 1), db);
    expect(await lastUsed()).toEqual(T0);
    await verifyAccessToken(tokens.accessToken, RESOURCE, later(LAST_USED_EVERY_MS), db);
    expect(await lastUsed()).toEqual(later(LAST_USED_EVERY_MS));
  });
});

describe("refresh", () => {
  it("replaces the whole pair: the old access token stops, the new one works", async () => {
    const { tokens, connectionId } = await connect();
    const res = await refresh(tokens.refreshToken);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.connectionId).toBe(connectionId);
    expect(res.tokens.refreshToken).not.toBe(tokens.refreshToken);
    expect(await verifyAccessToken(tokens.accessToken, RESOURCE, later(60_000), db)).toBeNull();
    expect(await verifyAccessToken(res.tokens.accessToken, RESOURCE, later(60_000), db)).not.toBeNull();
  });

  it("reusing a replaced refresh token revokes the connection, and the new refresh token fails too", async () => {
    const { tokens, connectionId } = await connect();
    const rotated = await refresh(tokens.refreshToken);
    if (!rotated.ok) throw new Error("refresh failed");
    expect(await refresh(tokens.refreshToken)).toEqual({ ok: false, error: "invalid_grant" });
    const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.id, connectionId));
    expect(connection.revokedAt).not.toBeNull();
    expect(await refresh(rotated.tokens.refreshToken)).toEqual({ ok: false, error: "invalid_grant" });
    expect(await verifyAccessToken(rotated.tokens.accessToken, RESOURCE, later(60_000), db)).toBeNull();
  });

  it("two concurrent refreshes with the same token: one wins, the other is reuse and revokes the connection", async () => {
    const { tokens, connectionId } = await connect();
    const results = await Promise.all([refresh(tokens.refreshToken), refresh(tokens.refreshToken)]);
    const won = results.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "invalid_grant" }]);

    const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.id, connectionId));
    expect(connection.revokedAt).not.toBeNull();
    // No live token set is left: the winner's pair belongs to a revoked connection.
    const winner = won[0];
    if (!winner.ok) throw new Error("unreachable");
    expect(await verifyAccessToken(winner.tokens.accessToken, RESOURCE, later(60_000), db)).toBeNull();
    expect(await refresh(winner.tokens.refreshToken)).toEqual({ ok: false, error: "invalid_grant" });
    const live = await db
      .select()
      .from(oauthTokens)
      .innerJoin(oauthConnections, eq(oauthConnections.id, oauthTokens.connectionId))
      .where(sql`${oauthTokens.replacedAt} is null and ${oauthConnections.revokedAt} is null`);
    expect(live).toHaveLength(0);
  });

  it("is invalid_grant for another app, after 60 idle days, or without the prefix", async () => {
    const other = await registerClient({ name: "Other", redirectUris: [REDIRECT] }, T0, db);
    const { tokens } = await connect();
    expect(await refresh(tokens.refreshToken, { clientId: other.clientId })).toEqual({ ok: false, error: "invalid_grant" });
    expect(await refresh(tokens.refreshToken, { now: later(REFRESH_IDLE_TTL_MS) })).toEqual({ ok: false, error: "invalid_grant" });
    expect(await refresh("nope")).toEqual({ ok: false, error: "invalid_grant" });
  });

  it("another requested resource is invalid_target", async () => {
    const { tokens } = await connect();
    expect(await refresh(tokens.refreshToken, { resource: "https://b.test/mcp" })).toEqual({ ok: false, error: "invalid_target" });
    expect((await refresh(tokens.refreshToken, { resource: null })).ok).toBe(true);
  });

  it("a connection granted for an old public address no longer refreshes", async () => {
    const { tokens } = await connect("https://a.test/mcp");
    expect(await refresh(tokens.refreshToken, { resource: null, canonicalResource: "https://b.test/mcp" })).toEqual({
      ok: false,
      error: "invalid_grant",
    });
  });

  it("checks against the install's /mcp URL when no canonical resource is given", async () => {
    const { tokens } = await connect();
    const res = await refreshAccessToken({ refreshToken: tokens.refreshToken, clientId: client.clientId, resource: RESOURCE, now: later(60_000), db });
    expect(res.ok).toBe(true);
  });
});

describe("connections", () => {
  it("lists the person's live connections, newest first, with the app name", async () => {
    const a = await connect();
    const b = await exchange(await issueCode({ now: later(1000) }), { now: later(1000) });
    if (!b.ok) throw new Error("exchange failed");
    const [other] = await db.insert(users).values({ name: "Bia", email: "bia@x.com" }).returning();
    await exchange(await issueCode({ userId: other.id }));

    const list = await listActiveConnections(userId, later(2000), db);
    expect(list.map((c) => c.id)).toEqual([b.connectionId, a.connectionId]);
    expect(list[0]).toEqual({ id: b.connectionId, clientName: "Claude", createdAt: later(1000), lastUsedAt: null });
  });

  it("leaves out revoked connections and those idle for 60 days", async () => {
    const a = await connect();
    await connect();
    await revokeConnection({ userId, connectionId: a.connectionId, now: T0, db });
    expect(await listActiveConnections(userId, T0, db)).toHaveLength(1);
    expect(await listActiveConnections(userId, later(REFRESH_IDLE_TTL_MS), db)).toHaveLength(0);
  });

  it("revokes one connection: its tokens stop on the next request", async () => {
    const { tokens, connectionId } = await connect();
    expect(await revokeConnection({ userId, connectionId, db })).toBe("revoked");
    expect(await revokeConnection({ userId, connectionId, db })).toBe("already_revoked");
    expect(await verifyAccessToken(tokens.accessToken, RESOURCE, T0, db)).toBeNull();
    expect(await refresh(tokens.refreshToken)).toEqual({ ok: false, error: "invalid_grant" });
  });

  it("someone else's connection, or a malformed id, is not_found and stays live", async () => {
    const { tokens, connectionId } = await connect();
    const [other] = await db.insert(users).values({ name: "Bia", email: "bia@x.com" }).returning();
    expect(await revokeConnection({ userId: other.id, connectionId, db })).toBe("not_found");
    expect(await revokeConnection({ userId, connectionId: "not-a-uuid", db })).toBe("not_found");
    expect(await verifyAccessToken(tokens.accessToken, RESOURCE, T0, db)).not.toBeNull();
  });

  it("revokeAllConnections cuts every connection and burns unexchanged codes", async () => {
    const a = await connect();
    const b = await connect();
    const pending = await issueCode();
    expect(await revokeAllConnections(userId, T0, db)).toBe(2);
    expect(await verifyAccessToken(a.tokens.accessToken, RESOURCE, T0, db)).toBeNull();
    expect(await verifyAccessToken(b.tokens.accessToken, RESOURCE, T0, db)).toBeNull();
    expect(await exchange(pending)).toEqual({ ok: false, error: "invalid_grant" });
    expect(await listActiveConnections(userId, T0, db)).toEqual([]);
    expect(await revokeAllConnections(userId, T0, db)).toBe(0);
  });

  it("deleting the user deletes their connections, tokens and codes (cascade)", async () => {
    await connect();
    await issueCode();
    await db.delete(users).where(eq(users.id, userId));
    expect(await db.select().from(oauthConnections)).toEqual([]);
    expect(await db.select().from(oauthTokens)).toEqual([]);
    expect(await db.select().from(oauthCodes)).toEqual([]);
    expect(await db.select().from(oauthClients)).toHaveLength(1);
  });
});
