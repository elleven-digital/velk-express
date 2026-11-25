import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { agency, clientAssignments, clients, sites, users, type User } from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { hoursColumns, NO_HOURS as noHours, type HoursPlan } from "@/lib/hours-plan";
import {
  addSite,
  createClient,
  deleteSite,
  getClient,
  listClients,
  listSites,
  normalizeSiteUrl,
  updateClient,
  updateSite,
  updateSupport,
} from "./clients";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let userId: Record<string, string>;

const NO_HOURS = { hours: noHours };
const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

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
  userId = { collab: rows[2].id };
});

afterAll(async () => {
  await db?.$client.end();
});

async function newClient(name: string): Promise<string> {
  const res = await createClient(owner, { name }, { db });
  if (!res.ok) throw new Error(res.error);
  return res.value.clientId;
}

describe("createClient", () => {
  it("is forbidden for a collaborator", async () => {
    expect(await createClient(collab, { name: "Acme" }, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await db.select().from(clients)).toHaveLength(0);
  });

  it("trims the name, normalizes the email and turns empty text into null", async () => {
    const res = await createClient(owner, { name: " Acme ", email: " Ops@Acme.com ", phone: "  ", notes: "" }, { db });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [row] = await db.select().from(clients).where(eq(clients.id, res.value.clientId));
    expect(row).toMatchObject({ name: "Acme", email: "ops@acme.com", phone: null, notes: null, supportActive: false });
  });

  it("lets a manager create", async () => {
    expect((await createClient(manager, { name: "Acme" }, { db })).ok).toBe(true);
  });

  it("rejects an empty name, a bad email and overlong text", async () => {
    expect(await createClient(owner, { name: "   " }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await createClient(owner, { name: "A", email: "not-an-email" }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await createClient(owner, { name: "A".repeat(121) }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await createClient(owner, { name: "A", phone: "1".repeat(41) }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await createClient(owner, { name: "A", notes: "n".repeat(5001) }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await db.select().from(clients)).toHaveLength(0);
  });
});

describe("visibility", () => {
  it("getClient is notFound for a collaborator outside the client", async () => {
    const a = await newClient("A client");
    const b = await newClient("B client");
    await db.insert(clientAssignments).values({ clientId: a, userId: userId.collab });

    expect((await getClient(collab, a, { db })).ok).toBe(true);
    expect(await getClient(collab, b, { db })).toEqual({ ok: false, error: "notFound" });
    expect((await listClients(collab, { db })).map((c) => c.name)).toEqual(["A client"]);
  });

  it("is notFound for a missing client and a malformed id", async () => {
    expect(await getClient(owner, "00000000-0000-4000-8000-000000000000", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await getClient(owner, "nope", { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("a collaborator sees nothing of a hidden client through sites either", async () => {
    const b = await newClient("B client");
    expect(await listSites(collab, b, { db })).toEqual({ ok: false, error: "notFound" });
  });

  it("owners and managers see every client", async () => {
    await newClient("B client");
    await newClient("A client");
    expect((await listClients(manager, { db })).map((c) => c.name)).toEqual(["A client", "B client"]);
  });

  it("lists clients by name with their site count", async () => {
    const a = await newClient("A client");
    await newClient("B client");
    await addSite(owner, a, { name: "one" }, { db });
    await addSite(owner, a, { name: "two" }, { db });
    const rows = await listClients(owner, { db });
    expect(rows.map((r) => [r.name, r.siteCount])).toEqual([
      ["A client", 2],
      ["B client", 0],
    ]);
  });
});

describe("collaborator writes", () => {
  it("are forbidden even on a client they take part in", async () => {
    const a = await newClient("A client");
    await db.insert(clientAssignments).values({ clientId: a, userId: userId.collab });
    const s = await addSite(owner, a, { name: "site" }, { db });
    if (!s.ok) throw new Error(s.error);
    const support = { supportActive: true, monthlyCents: 100, generalTickets: true, siteIdsInPlan: [], ...NO_HOURS };

    expect(await updateClient(collab, a, { name: "X" }, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await updateSupport(collab, a, support, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await addSite(collab, a, { name: "y" }, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await updateSite(collab, a, s.value.siteId, { name: "y" }, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteSite(collab, a, s.value.siteId, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await db.select().from(sites)).toHaveLength(1);
  });
});

describe("updateClient", () => {
  it("replaces the company data and validates it", async () => {
    const id = await newClient("Acme");
    expect((await updateClient(owner, id, { name: " Acme Co ", email: "A@B.com", phone: "123", notes: "n" }, { db })).ok).toBe(true);
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    expect(row).toMatchObject({ name: "Acme Co", email: "a@b.com", phone: "123", notes: "n" });
    expect(await updateClient(owner, id, { name: "" }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await updateClient(owner, "00000000-0000-4000-8000-000000000000", { name: "X" }, { db })).toEqual({
      ok: false,
      error: "notFound",
    });
  });
});

describe("updateSupport", () => {
  it("turns on support with a monthly value, general tickets and sites in the plan", async () => {
    const id = await newClient("Acme");
    const s1 = await addSite(owner, id, { name: "one" }, { db });
    const s2 = await addSite(owner, id, { name: "two" }, { db });
    if (!s1.ok || !s2.ok) throw new Error("setup");
    const res = await updateSupport(
      owner,
      id,
      { supportActive: true, monthlyCents: 15000, generalTickets: true, siteIdsInPlan: [s1.value.siteId], ...NO_HOURS },
      { db },
    );
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    expect(row).toMatchObject({ supportActive: true, supportMonthlyCents: 15000, generalTicketsEnabled: true });
    const rows = await db.select().from(sites).where(eq(sites.clientId, id));
    expect(Object.fromEntries(rows.map((r) => [r.name, r.includedInSupport]))).toEqual({ one: true, two: false });
  });

  it("support off clears the monthly value, general tickets and every site in the plan", async () => {
    const id = await newClient("Acme");
    const s1 = await addSite(owner, id, { name: "one" }, { db });
    if (!s1.ok) throw new Error("setup");
    await updateSupport(owner, id, { supportActive: true, monthlyCents: 9000, generalTickets: true, siteIdsInPlan: [s1.value.siteId], ...NO_HOURS }, { db });

    const res = await updateSupport(
      owner,
      id,
      { supportActive: false, monthlyCents: 9000, generalTickets: true, siteIdsInPlan: [s1.value.siteId], ...NO_HOURS },
      { db },
    );
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    expect(row).toMatchObject({ supportActive: false, supportMonthlyCents: null, generalTicketsEnabled: false });
    const [site] = await db.select().from(sites).where(eq(sites.clientId, id));
    expect(site.includedInSupport).toBe(false);
  });

  it("does not touch the sites of another client", async () => {
    const a = await newClient("A client");
    const b = await newClient("B client");
    const sb = await addSite(owner, b, { name: "b-site" }, { db });
    if (!sb.ok) throw new Error("setup");
    await updateSupport(owner, b, { supportActive: true, monthlyCents: null, generalTickets: false, siteIdsInPlan: [sb.value.siteId], ...NO_HOURS }, { db });

    await updateSupport(owner, a, { supportActive: true, monthlyCents: null, generalTickets: false, siteIdsInPlan: [sb.value.siteId], ...NO_HOURS }, { db });
    const [site] = await db.select().from(sites).where(eq(sites.id, sb.value.siteId));
    expect(site.includedInSupport).toBe(true);

    await updateSupport(owner, a, { supportActive: false, monthlyCents: null, generalTickets: false, siteIdsInPlan: [], ...NO_HOURS }, { db });
    const [after] = await db.select().from(sites).where(eq(sites.id, sb.value.siteId));
    expect(after.includedInSupport).toBe(true);
  });

  it("rejects a negative or non-integer monthly value", async () => {
    const id = await newClient("Acme");
    const base = { supportActive: true, generalTickets: false, siteIdsInPlan: [], ...NO_HOURS };
    expect(await updateSupport(owner, id, { ...base, monthlyCents: -1 }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await updateSupport(owner, id, { ...base, monthlyCents: 1.5 }, { db })).toEqual({ ok: false, error: "invalid" });
  });

  it("ignores ids in the plan that are not uuids", async () => {
    const id = await newClient("Acme");
    const res = await updateSupport(owner, id, { supportActive: true, monthlyCents: null, generalTickets: false, siteIdsInPlan: ["x"], ...NO_HOURS }, { db });
    expect(res.ok).toBe(true);
  });
});

describe("sites", () => {
  it("addSite on a client without support stores included_in_support false", async () => {
    const id = await newClient("Acme");
    const res = await addSite(owner, id, { name: " Blog ", url: "blog.acme.com", includedInSupport: true }, { db });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [site] = await db.select().from(sites).where(eq(sites.id, res.value.siteId));
    expect(site).toMatchObject({ name: "Blog", url: "https://blog.acme.com", includedInSupport: false, clientId: id });
  });

  it("addSite on a client with support honors included_in_support", async () => {
    const id = await newClient("Acme");
    await updateSupport(owner, id, { supportActive: true, monthlyCents: null, generalTickets: false, siteIdsInPlan: [], ...NO_HOURS }, { db });
    const res = await addSite(owner, id, { name: "Blog", includedInSupport: true }, { db });
    if (!res.ok) throw new Error(res.error);
    const [site] = await db.select().from(sites).where(eq(sites.id, res.value.siteId));
    expect(site.includedInSupport).toBe(true);
  });

  it("rejects an empty name and a bad url", async () => {
    const id = await newClient("Acme");
    expect(await addSite(owner, id, { name: " " }, { db })).toEqual({ ok: false, error: "invalid" });
    expect(await addSite(owner, id, { name: "x", url: "javascript:alert(1)" }, { db })).toEqual({ ok: false, error: "invalid" });
  });

  it("updateSite changes the site and keeps the plan flag off without support", async () => {
    const id = await newClient("Acme");
    const s = await addSite(owner, id, { name: "Blog" }, { db });
    if (!s.ok) throw new Error(s.error);
    const res = await updateSite(owner, id, s.value.siteId, { name: "Shop", url: "", notes: " hi ", includedInSupport: true }, { db });
    expect(res.ok).toBe(true);
    const [site] = await db.select().from(sites).where(eq(sites.id, s.value.siteId));
    expect(site).toMatchObject({ name: "Shop", url: null, notes: "hi", includedInSupport: false });
  });

  it("updateSite and deleteSite with a site of another client are notFound and change nothing", async () => {
    const a = await newClient("A client");
    const b = await newClient("B client");
    const sb = await addSite(owner, b, { name: "b-site", url: "https://b.com" }, { db });
    if (!sb.ok) throw new Error(sb.error);
    const before = (await db.select().from(sites).where(eq(sites.id, sb.value.siteId)))[0];

    expect(await updateSite(owner, a, sb.value.siteId, { name: "hijacked" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await deleteSite(owner, a, sb.value.siteId, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await updateSite(owner, a, "not-a-uuid", { name: "x" }, { db })).toEqual({ ok: false, error: "notFound" });
    expect((await db.select().from(sites).where(eq(sites.id, sb.value.siteId)))[0]).toEqual(before);
  });

  it("deleteSite removes the site", async () => {
    const id = await newClient("Acme");
    const s = await addSite(owner, id, { name: "Blog" }, { db });
    if (!s.ok) throw new Error(s.error);
    expect((await deleteSite(owner, id, s.value.siteId, { db })).ok).toBe(true);
    expect(await db.select().from(sites)).toHaveLength(0);
  });

  it("listSites returns the client's sites by creation order", async () => {
    const id = await newClient("Acme");
    await addSite(owner, id, { name: "first" }, { db });
    await addSite(owner, id, { name: "second" }, { db });
    const res = await listSites(owner, id, { db });
    expect(res.ok && res.value.map((s) => s.name)).toEqual(["first", "second"]);
  });
});

describe("normalizeSiteUrl", () => {
  const value = (raw: string | null | undefined) => {
    const res = normalizeSiteUrl(raw);
    return res.ok ? res.value : `fail:${res.error}`;
  };

  it("prefixes https:// when there is no scheme", () => {
    expect(value("acme.com")).toBe("https://acme.com");
    expect(value("  acme.com/path?x=1 ")).toBe("https://acme.com/path?x=1");
  });

  it("keeps http and https", () => {
    expect(value("http://acme.com")).toBe("http://acme.com");
    expect(value("https://acme.com")).toBe("https://acme.com");
  });

  it("empty is null", () => {
    expect(value("")).toBeNull();
    expect(value("   ")).toBeNull();
    expect(value(null)).toBeNull();
    expect(value(undefined)).toBeNull();
  });

  it("refuses other schemes, hostless text and overlong addresses", () => {
    expect(normalizeSiteUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeSiteUrl("ftp://x").ok).toBe(false);
    expect(normalizeSiteUrl("data:text/html,hi").ok).toBe(false);
    expect(normalizeSiteUrl("https://").ok).toBe(false);
    expect(normalizeSiteUrl("not a url").ok).toBe(false);
    expect(normalizeSiteUrl(`https://acme.com/${"a".repeat(2048)}`).ok).toBe(false);
  });
});

describe("updateSupport hours plan", () => {
  const base = { supportActive: true, monthlyCents: null, generalTickets: false, siteIdsInPlan: [] };
  const hoursOf = async (id: string) => {
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    return {
      hoursTracked: row.hoursTracked,
      hoursVisible: row.hoursVisible,
      hoursLimited: row.hoursLimited,
      hoursPurchasable: row.hoursPurchasable,
      includedMinutes: row.includedMinutes,
      extraHourCents: row.extraHourCents,
    };
  };
  const stored = (plan: HoursPlan) => {
    const columns: Partial<ReturnType<typeof hoursColumns>> = hoursColumns(plan);
    delete columns.hoursMode;
    return columns;
  };
  const full: HoursPlan = { tracked: true, visible: true, limited: true, includedMinutes: 600, extraHourCents: 15000, purchasable: true };
  const none = stored(noHours);

  it("dropping the limit clears included minutes and the extra hour price", async () => {
    const id = await newClient("Acme");
    expect((await updateSupport(owner, id, { ...base, hours: full }, { db })).ok).toBe(true);
    expect(await hoursOf(id)).toEqual(stored(full));

    await updateSupport(owner, id, { ...base, hours: { ...full, limited: false } }, { db });
    expect(await hoursOf(id)).toEqual({ ...none, hoursTracked: true, hoursVisible: true });

    await updateSupport(owner, id, { ...base, hours: full }, { db });
    await updateSupport(owner, id, { ...base, hours: { ...full, tracked: false } }, { db });
    expect(await hoursOf(id)).toEqual(none);

    await updateSupport(owner, id, { ...base, hours: full }, { db });
    await updateSupport(owner, id, { ...base, supportActive: false, hours: full }, { db });
    expect(await hoursOf(id)).toEqual(none);
  });

  it("keeps zero included minutes and stores the legacy mode", async () => {
    const id = await newClient("Acme");
    const plan = { ...full, includedMinutes: 0, extraHourCents: null, purchasable: false };
    expect((await updateSupport(owner, id, { ...base, hours: plan }, { db })).ok).toBe(true);
    expect(await hoursOf(id)).toEqual(stored(plan));
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    expect(row.hoursMode).toBe("package");
  });

  it("buying in the portal needs visible hours, included hours and a price", async () => {
    const id = await newClient("Acme");
    await updateSupport(owner, id, { ...base, hours: { ...full, visible: false } }, { db });
    expect((await hoursOf(id)).hoursPurchasable).toBe(false);
    await updateSupport(owner, id, { ...base, hours: { ...full, extraHourCents: null } }, { db });
    expect((await hoursOf(id)).hoursPurchasable).toBe(false);
    await updateSupport(owner, id, { ...base, hours: full }, { db });
    expect((await hoursOf(id)).hoursPurchasable).toBe(true);
  });

  it("tracked only is stored as internal", async () => {
    const id = await newClient("Acme");
    await updateSupport(owner, id, { ...base, hours: { ...noHours, tracked: true } }, { db });
    expect(await hoursOf(id)).toEqual({ ...none, hoursTracked: true });
    const [row] = await db.select().from(clients).where(eq(clients.id, id));
    expect(row.hoursMode).toBe("internal");
  });

  it("support off forces hours off", async () => {
    const id = await newClient("Acme");
    await updateSupport(owner, id, { ...base, supportActive: false, hours: full }, { db });
    expect(await hoursOf(id)).toEqual(none);
  });

  it("only staff changes the hours plan", async () => {
    const id = await newClient("Acme");
    await db.insert(clientAssignments).values({ clientId: id, userId: userId.collab });
    const res = await updateSupport(collab, id, { ...base, hours: full }, { db });
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(await hoursOf(id)).toEqual(none);
    expect((await updateSupport(manager, id, { ...base, hours: { ...noHours, tracked: true } }, { db })).ok).toBe(true);
  });

  it("refuses out-of-range hours values", async () => {
    const id = await newClient("Acme");
    for (const bad of [{ includedMinutes: -1 }, { includedMinutes: 100_001 }, { includedMinutes: 1.5 }, { extraHourCents: -5 }]) {
      const input = { ...base, hours: { ...full, extraHourCents: null, purchasable: false, ...bad } };
      expect(await updateSupport(owner, id, input, { db })).toEqual({ ok: false, error: "invalid" });
    }
  });
});
