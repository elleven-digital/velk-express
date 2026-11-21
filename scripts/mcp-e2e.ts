/**
 * End-to-end check of the AI connector against a running app and its LOCAL,
 * throwaway database (an install finished on the install screen, with at
 * least one collaborator):
 *
 *   DATABASE_URL=postgres://velk@localhost:54330/velk_e2e E2E_BASE_URL=http://localhost:3100 npx tsx scripts/mcp-e2e.ts
 *
 * It registers an app (dynamic registration), stands in for the person's
 * click on "Authorize" by writing the authorization code straight to the
 * database (the authorize page itself is checked in the browser), exchanges
 * the code for tokens over HTTP, refreshes them, and then calls tools over
 * /mcp as the owner and a collaborator, checking in the database what was
 * written and what was refused. The base URL must be the install's public
 * address: tokens are granted for `<address>/mcp`.
 *
 * Refuses to run unless DATABASE_URL points at a local database other than
 * `velk`: it writes data.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped JSON answers */
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");

const target = (() => {
  try {
    const url = new URL(DATABASE_URL);
    return { host: url.hostname, name: url.pathname.replace(/^\//, "") };
  } catch {
    return { host: "", name: "" };
  }
})();
if ((target.host !== "localhost" && target.host !== "127.0.0.1") || target.name === "velk" || !target.name) {
  console.error("Refusing to run: DATABASE_URL must point at a local, throwaway database (not `velk`).");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} });

/** Undo steps run at the end, even after a failure (newest first). */
const restore: (() => Promise<unknown>)[] = [];

// ---------- tiny test harness ----------

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: unknown, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ---------- OAuth ----------

const REDIRECT_URI = "http://127.0.0.1:53682/callback";

async function registerApp(): Promise<string> {
  const response = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "E2E test app", redirect_uris: [REDIRECT_URI] }),
  });
  const body = (await response.json()) as { client_id?: string };
  check("dynamic registration answers 201 with a client_id", response.status === 201 && body.client_id, body);
  if (!body.client_id) throw new Error("dynamic registration failed");
  return body.client_id;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");

type Tokens = { access_token: string; refresh_token: string };

/** Stands in for "Authorize": a code for this user, then the real token exchange over HTTP. */
async function connect(clientId: string, userId: string): Promise<Tokens> {
  const [app] = await sql`select id from oauth_clients where client_id = ${clientId}`;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const code = `vac_${b64url(randomBytes(32))}`;
  await sql`
    insert into oauth_codes (code_hash, user_id, app_id, redirect_uri, code_challenge, resource, expires_at)
    values (${hash(code)}, ${userId}, ${app.id}, ${REDIRECT_URI}, ${challenge}, ${`${BASE}/mcp`},
            now() + interval '10 minutes')`;

  const response = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  const tokens = (await response.json()) as Tokens;
  if (!tokens.access_token) throw new Error(`token exchange failed: HTTP ${response.status}`);
  return tokens;
}

async function tokenRequest(fields: Record<string, string>) {
  const response = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

// ---------- MCP ----------

const PROTOCOL = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "velk-e2e", version: "1.0.0" },
};
let nextId = 0;

async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL,
      "Mcp-Method": method,
      ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params: { ...params, _meta: META } }),
  });
  const text = await response.text();
  let message: Record<string, unknown> | null = null;
  try {
    const line = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? text.split("\n").find((l) => l.startsWith("data: "))?.slice(6)
      : text;
    message = line ? JSON.parse(line) : null;
  } catch {
    message = null;
  }
  return { status: response.status, headers: response.headers, message };
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { status, message } = await rpc(token, "tools/call", { name, arguments: args });
  if (status !== 200 || !message || message.error) {
    throw new Error(`${name}: HTTP ${status} ${JSON.stringify(message)}`);
  }
  return message.result as ToolResult;
}

/** Data of a successful tool answer. */
function data(result: ToolResult): Record<string, any> {
  if (result.isError) throw new Error(`unexpected refusal: ${result.content[0]?.text}`);
  return result.structuredContent ?? {};
}

const sentence = (result: ToolResult) => result.content[0]?.text ?? "";

async function toolNames(token: string): Promise<string[]> {
  const list = await rpc(token, "tools/list");
  return ((list.message?.result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);
}

// ---------- scenario ----------

async function main() {
  console.log(`Velk Express connector — end-to-end against ${BASE}`);

  const people = await sql`
    select distinct on (role) id, name, role from users order by role, created_at`;
  const owner = people.find((p) => p.role === "owner");
  const collaborator = people.find((p) => p.role === "collaborator");
  if (!owner || !collaborator) throw new Error("Finish the install and add a collaborator first.");
  // Tools answer in each person's language; force English for stable sentences, and put it back at the end.
  const ids = [owner.id, collaborator.id];
  const locales = await sql`select id, locale from users where id in ${sql(ids)}`;
  await sql`update users set locale = 'en' where id in ${sql(ids)}`;
  restore.push(async () => {
    for (const row of locales) await sql`update users set locale = ${row.locale} where id = ${row.id}`;
  });

  section("OAuth");
  const metadata = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("authorization server metadata lists PKCE S256", metadata.code_challenge_methods_supported?.includes("S256"));
  const unauth = await rpc(null, "tools/list");
  check(
    "/mcp without a token is 401 pointing at the resource metadata",
    unauth.status === 401 && (unauth.headers.get("www-authenticate") ?? "").includes("oauth-protected-resource"),
    unauth.status,
  );

  const clientId = await registerApp();
  const ownerTokens = await connect(clientId, owner.id);
  check("code exchanged for tokens", ownerTokens.access_token.startsWith("vat_"));

  const refreshed = await tokenRequest({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: ownerTokens.refresh_token,
  });
  check("refresh gives a new pair", refreshed.status === 200 && refreshed.body.access_token?.startsWith("vat_"));
  const oldAccess = await rpc(ownerTokens.access_token, "tools/list");
  check("the replaced access token stops working", oldAccess.status === 401, oldAccess.status);
  const ownerToken = refreshed.body.access_token;

  section("Tools — owner");
  const names = await toolNames(ownerToken);
  check("tools/list answers the tool list", names.includes("get_agency") && names.includes("list_labels"), names);

  const me = data(await call(ownerToken, "get_agency"));
  check("get_agency says who is connected", me.you?.id === owner.id && me.you?.role === "owner", me.you);
  check("get_agency gives the panel URL", me.agency?.panel_url === `${BASE}/admin`, me.agency);
  check("owners see which payment providers are on", typeof me.payment_providers?.stripe === "boolean", me.payment_providers);

  const listen = await rpc(ownerToken, "subscriptions/listen");
  check("subscriptions/listen is method not found", (listen.message?.error as any)?.code === -32601, listen.message);

  section("Labels");
  const created = data(await call(ownerToken, "create_label", { name: "E2E — waiting art", color: "teal" }));
  const labelId = created.label?.id;
  restore.push(() => sql`delete from labels where id = ${labelId}`);
  const [labelRow] = await sql`select name, color from labels where id = ${labelId}`;
  check("create_label writes the label", labelRow?.name === "E2E — waiting art" && labelRow.color === "#12a594", labelRow);
  const listed = data(await call(ownerToken, "list_labels"));
  check("list_labels lists it", listed.labels?.some((l: any) => l.id === labelId));

  section("Tools — collaborator");
  const collabToken = (await connect(clientId, collaborator.id)).access_token;
  const collabMe = data(await call(collabToken, "get_agency"));
  check(
    "get_agency as a collaborator: their role, no payment providers",
    collabMe.you?.role === "collaborator" && !("payment_providers" in collabMe),
    collabMe,
  );
  const collabCreate = await call(collabToken, "create_label", { name: "E2E — collaborator" });
  const [notWritten] = await sql`select count(*)::int as n from labels where name = 'E2E — collaborator'`;
  check(
    "a collaborator can't create labels (owners and managers only)",
    collabCreate.isError === true && sentence(collabCreate).includes("owners and managers") && notWritten.n === 0,
    sentence(collabCreate),
  );

  data(await call(ownerToken, "delete_label", { label_id: labelId }));
  const [gone] = await sql`select count(*)::int as n from labels where id = ${labelId}`;
  check("delete_label deletes", gone.n === 0);

  await runExtraChecks({ restore: (undo) => restore.push(undo), sql, call, data, sentence, check, section, owner, collaborator, ownerToken, connect: (u: string) => connect(clientId, u) });

  section("Revocation");
  const [connection] = await sql`
    select c.id from oauth_connections c
    join oauth_tokens t on t.connection_id = c.id
    where t.access_hash = ${hash(ownerToken)}`;
  await sql`update oauth_connections set revoked_at = now() where id = ${connection.id}`;
  const afterRevoke = await rpc(ownerToken, "tools/list");
  check("a revoked connection's token stops working at once", afterRevoke.status === 401, afterRevoke.status);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exitCode = 1;
  }
}

/** What every area's checks receive. Areas live in scripts/mcp-e2e-<area>.ts. */
export type Ctx = {
  /** Register an undo step (runs at the end, newest first). */
  restore: (undo: () => Promise<unknown>) => void;
  sql: typeof sql;
  call: typeof call;
  data: typeof data;
  sentence: typeof sentence;
  check: typeof check;
  section: typeof section;
  owner: Record<string, any>;
  collaborator: Record<string, any>;
  ownerToken: string;
  connect: (userId: string) => Promise<Tokens>;
};

/** Area modules, each exporting `run(ctx)`. E2E_ONLY=clients runs only that area. */
const AREAS = ["tickets", "clients", "quotes", "charges", "team", "settings"] as const;

async function runExtraChecks(ctx: Ctx) {
  const only = process.env.E2E_ONLY;
  for (const area of AREAS) {
    if (only && only !== area) continue;
    let mod: { run?: (ctx: Ctx) => Promise<void> };
    try {
      mod = await import(`./mcp-e2e-${area}`);
    } catch {
      continue; // area not written yet
    }
    // A fresh owner connection per area: each connection has its own 60/min limit.
    const ownerToken = (await ctx.connect(ctx.owner.id)).access_token;
    await mod.run?.({ ...ctx, ownerToken });
  }
  await rateLimitChecks(ctx);
}

async function rateLimitChecks({ call, check, section, owner, connect }: Ctx) {
  section("Rate limit");
  const token = (await connect(owner.id)).access_token;
  let last: ToolResult | null = null;
  for (let i = 0; i < 61; i++) last = await call(token, "get_agency");
  check(
    "the 61st call in a minute gets the limit sentence",
    last?.isError === true && last.content[0]?.text.startsWith("Too many requests"),
    last?.content[0]?.text,
  );
  const names = await toolNames(token);
  check("tools/list still answers over the limit", names.includes("get_agency"), names.length);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const undo of restore.reverse()) await undo().catch((err) => console.error("cleanup failed:", err));
    await sql.end();
  });
