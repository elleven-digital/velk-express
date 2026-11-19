import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { clients } from "@/lib/db";
import { applySupportPlan } from "./support-plan";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let clientId: string;

const read = async () => (await db.select().from(clients).where(eq(clients.id, clientId)))[0];

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  const [c] = await db.insert(clients).values({ name: "Acme" }).returning({ id: clients.id });
  clientId = c.id;
});

afterAll(async () => {
  await db?.$client.end();
});

describe("applySupportPlan", () => {
  it("applySupportPlan normalizes like the support form", async () => {
    await db.transaction((tx) =>
      applySupportPlan(tx as unknown as Db, clientId, {
        supportActive: true,
        monthlyCents: 50000,
        generalTickets: true,
        hoursMode: "package",
        includedMinutes: 600,
        extraHourCents: 15000,
      }),
    );
    let c = await read();
    expect(c).toMatchObject({
      supportActive: true,
      supportMonthlyCents: 50000,
      generalTicketsEnabled: true,
      hoursMode: "package",
      includedMinutes: 600,
      extraHourCents: 15000,
    });

    // Outside the package nothing is included or charged.
    await db.transaction((tx) =>
      applySupportPlan(tx as unknown as Db, clientId, {
        supportActive: true,
        monthlyCents: 50000,
        hoursMode: "internal",
        includedMinutes: 600,
        extraHourCents: 15000,
      }),
    );
    c = await read();
    expect(c).toMatchObject({ hoursMode: "internal", includedMinutes: 0, extraHourCents: null, generalTicketsEnabled: true });

    // Without support there is no monthly value, no general tickets and no hours.
    await db.transaction((tx) =>
      applySupportPlan(tx as unknown as Db, clientId, {
        supportActive: false,
        monthlyCents: 50000,
        generalTickets: true,
        hoursMode: "package",
        includedMinutes: 600,
        extraHourCents: 15000,
      }),
    );
    c = await read();
    expect(c).toMatchObject({
      supportActive: false,
      supportMonthlyCents: null,
      generalTicketsEnabled: false,
      hoursMode: "off",
      includedMinutes: 0,
      extraHourCents: null,
    });
  });
});
