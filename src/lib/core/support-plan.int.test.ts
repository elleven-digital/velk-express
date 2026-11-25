import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { clients } from "@/lib/db";
import { applySupportPlan } from "./support-plan";
import type { HoursPlan } from "@/lib/hours-plan";

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

const full: HoursPlan = {
  tracked: true,
  visible: true,
  limited: true,
  includedMinutes: 600,
  extraHourCents: 15000,
  purchasable: true,
};

describe("applySupportPlan", () => {
  it("applySupportPlan normalizes like the support form", async () => {
    await db.transaction((tx) =>
      applySupportPlan(tx as unknown as Db, clientId, {
        supportActive: true,
        monthlyCents: 50000,
        generalTickets: true,
        hours: full,
      }),
    );
    let c = await read();
    expect(c).toMatchObject({
      supportActive: true,
      supportMonthlyCents: 50000,
      generalTicketsEnabled: true,
      hoursTracked: true,
      hoursVisible: true,
      hoursLimited: true,
      hoursPurchasable: true,
      hoursMode: "package",
      includedMinutes: 600,
      extraHourCents: 15000,
    });

    // Without included hours nothing is included, charged or bought.
    await db.transaction((tx) =>
      applySupportPlan(tx as unknown as Db, clientId, {
        supportActive: true,
        monthlyCents: 50000,
        hours: { ...full, limited: false },
      }),
    );
    c = await read();
    expect(c).toMatchObject({
      hoursTracked: true,
      hoursVisible: true,
      hoursLimited: false,
      hoursPurchasable: false,
      hoursMode: "internal",
      includedMinutes: 0,
      extraHourCents: null,
      generalTicketsEnabled: true,
    });

    // A limit the client does not see: no buying in the portal, and the legacy mode stays internal.
    await db.transaction((tx) =>
      applySupportPlan(tx as unknown as Db, clientId, {
        supportActive: true,
        monthlyCents: 50000,
        hours: { ...full, visible: false },
      }),
    );
    c = await read();
    expect(c).toMatchObject({ hoursLimited: true, hoursVisible: false, hoursPurchasable: false, hoursMode: "internal", includedMinutes: 600 });

    // Without support there is no monthly value, no general tickets and no hours.
    await db.transaction((tx) =>
      applySupportPlan(tx as unknown as Db, clientId, {
        supportActive: false,
        monthlyCents: 50000,
        generalTickets: true,
        hours: full,
      }),
    );
    c = await read();
    expect(c).toMatchObject({
      supportActive: false,
      supportMonthlyCents: null,
      generalTicketsEnabled: false,
      hoursTracked: false,
      hoursVisible: false,
      hoursLimited: false,
      hoursPurchasable: false,
      hoursMode: "off",
      includedMinutes: 0,
      extraHourCents: null,
    });
  });
});
