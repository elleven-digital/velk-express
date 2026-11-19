import { describe, expect, it } from "vitest";
import type { ChargeStatus } from "@/lib/db";
import { isBillingSubscription } from "./charge-utils";

describe("isBillingSubscription", () => {
  it("is true for a monthly charge that is active or past due", () => {
    expect(isBillingSubscription({ kind: "subscription", status: "active" })).toBe(true);
    expect(isBillingSubscription({ kind: "subscription", status: "past_due" })).toBe(true);
  });

  it("is false for a monthly charge that is waiting, canceled or not live", () => {
    for (const status of ["pending", "canceled", "paid"] as ChargeStatus[]) {
      expect(isBillingSubscription({ kind: "subscription", status })).toBe(false);
    }
  });

  it("is false for a one-time charge", () => {
    expect(isBillingSubscription({ kind: "one_time", status: "active" })).toBe(false);
  });
});
