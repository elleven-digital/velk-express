import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import { agency, clientUsers, clients, users, type Db } from "@/lib/db";
import type { PortalSession, TeamSession } from "@/lib/auth/session";
import { setOwnLocale } from "./profile";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "pt" });
});

afterAll(async () => {
  await db?.$client.end();
});

async function localeOfUser(id: string) {
  const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, id));
  return row.locale;
}
async function localeOfClientUser(id: string) {
  const [row] = await db.select({ locale: clientUsers.locale }).from(clientUsers).where(eq(clientUsers.id, id));
  return row.locale;
}

describe("setOwnLocale", () => {
  it("saves a team member's language, only theirs, and null goes back to the agency's", async () => {
    const [ana, bia] = await db
      .insert(users)
      .values([
        { name: "Ana", email: "ana@x.com", role: "owner" },
        { name: "Bia", email: "bia@x.com", role: "collaborator" },
      ])
      .returning();
    const session: TeamSession = { userType: "agency", user: ana };

    expect(await setOwnLocale(session, "es", { db })).toEqual({ ok: true, value: "es" });
    expect(await localeOfUser(ana.id)).toBe("es");
    expect(await localeOfUser(bia.id)).toBeNull();

    expect(await setOwnLocale(session, null, { db })).toEqual({ ok: true, value: null });
    expect(await localeOfUser(ana.id)).toBeNull();
  });

  it("saves a portal person's language in the portal logins, not in the team", async () => {
    const [client] = await db.insert(clients).values({ name: "Acme Corp" }).returning();
    const [person] = await db.insert(clientUsers).values({ name: "Caio", email: "caio@x.com" }).returning();
    const [member] = await db.insert(users).values({ name: "Caio", email: "caio@x.com", role: "owner" }).returning();
    const session: PortalSession = { userType: "client", user: person, client, role: "admin" };

    expect(await setOwnLocale(session, "en", { db })).toEqual({ ok: true, value: "en" });
    expect(await localeOfClientUser(person.id)).toBe("en");
    // the same e-mail on the team is another person
    expect(await localeOfUser(member.id)).toBeNull();
  });

  it("refuses a language it doesn't know and saves nothing", async () => {
    const [ana] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner", locale: "pt" }).returning();
    const session: TeamSession = { userType: "agency", user: ana };

    expect(await setOwnLocale(session, "fr", { db })).toEqual({ ok: false, error: "invalidLocale" });
    expect(await localeOfUser(ana.id)).toBe("pt");
  });
});
