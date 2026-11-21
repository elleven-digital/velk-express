import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestDb } from "@/test/db";
import { users, type Db, type User } from "@/lib/db";
import { pkceChallengeOf } from "@/lib/oauth/rules";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  listActiveConnections,
  registerClient,
  verifyAccessToken,
  type OAuthClient,
} from "@/lib/oauth/store";

// The action reads the app database: point it at the test one.
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.APP_URL = "https://agency.test";

const session = vi.hoisted(() => ({ current: null as null | { userType: "agency"; user: { id: string; role: string } } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({
  requireTeam: vi.fn(async () => {
    if (!session.current) throw new Error("no session");
    return session.current;
  }),
}));

import { revokeAiConnectionAction } from "./actions";

const RESOURCE = "https://agency.test/mcp";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(43);

let db: Db;
let ana: User;
let bia: User;
let client: OAuthClient;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  [ana] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "collaborator" }).returning();
  [bia] = await db.insert(users).values({ name: "Bia", email: "bia@x.com", role: "owner" }).returning();
  client = await registerClient({ name: "Claude", redirectUris: [REDIRECT] }, new Date(), db);
});

afterAll(async () => {
  await db?.$client.end();
});

async function connect(user: User) {
  const code = await createAuthorizationCode({
    userId: user.id,
    clientId: client.clientId,
    redirectUri: REDIRECT,
    codeChallenge: pkceChallengeOf(VERIFIER),
    resource: RESOURCE,
    db,
  });
  const res = await exchangeAuthorizationCode({
    code,
    clientId: client.clientId,
    redirectUri: REDIRECT,
    codeVerifier: VERIFIER,
    resource: RESOURCE,
    db,
  });
  if (!res.ok) throw new Error(`exchange failed: ${res.error}`);
  return { accessToken: res.tokens.accessToken, connectionId: res.connectionId };
}

const signIn = (user: User) => {
  session.current = { userType: "agency", user: { id: user.id, role: user.role } };
};

describe("revokeAiConnectionAction", () => {
  it("revokes the person's own connection: its access token stops verifying", async () => {
    const mine = await connect(ana);
    signIn(ana);
    await revokeAiConnectionAction(mine.connectionId);
    expect(await verifyAccessToken(mine.accessToken, RESOURCE, new Date(), db)).toBeNull();
    expect(await listActiveConnections(ana.id, new Date(), db)).toHaveLength(0);
  });

  it("with someone else's connection id revokes nothing", async () => {
    const theirs = await connect(bia);
    signIn(ana);
    await revokeAiConnectionAction(theirs.connectionId);
    expect(await verifyAccessToken(theirs.accessToken, RESOURCE, new Date(), db)).not.toBeNull();
    expect(await listActiveConnections(bia.id, new Date(), db)).toHaveLength(1);
  });

  it("a malformed id is ignored", async () => {
    const mine = await connect(ana);
    signIn(ana);
    await expect(revokeAiConnectionAction("not-a-uuid")).resolves.toBeUndefined();
    expect(await verifyAccessToken(mine.accessToken, RESOURCE, new Date(), db)).not.toBeNull();
  });
});
