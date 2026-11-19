import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { paymentEvents } from "@/lib/db/schema";
import { sweepPaymentEvents } from "./retention";

let db: Db;

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
});

afterAll(async () => {
  await db?.$client.end();
});

async function addEvent(eventId: string, ageDays: number) {
  await db.insert(paymentEvents).values({ provider: "stripe", eventId });
  await db.execute(sql`update payment_events set received_at = now() - make_interval(days => ${ageDays}) where event_id = ${eventId}`);
}

describe("sweepPaymentEvents", () => {
  it("deletes events older than 90 days and keeps newer ones", async () => {
    await addEvent("evt_old", 91);
    await addEvent("evt_new", 89);
    expect(await sweepPaymentEvents(db)).toBe(1);
    const left = await db.select({ eventId: paymentEvents.eventId }).from(paymentEvents);
    expect(left).toEqual([{ eventId: "evt_new" }]);
    expect(await db.select().from(paymentEvents).where(eq(paymentEvents.eventId, "evt_old"))).toHaveLength(0);
  });
});
