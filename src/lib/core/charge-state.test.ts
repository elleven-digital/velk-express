import { describe, expect, it } from "vitest";
import { applyEffect } from "./charge-state";

const KINDS = ["one_time", "subscription"] as const;
const STATUSES = ["pending", "paid", "active", "past_due", "canceled"] as const;
const EFFECTS = ["paid", "active", "past_due", "canceled", "ignore"] as const;

type Kind = (typeof KINDS)[number];
type Status = (typeof STATUSES)[number];
type Effect = (typeof EFFECTS)[number];

/**
 * Every transition that changes something; any other (kind, status, effect) changes nothing.
 * `setPaidAt` means "the money came in": the applier records paid_at only when it is still empty.
 */
const CHANGES: Record<string, { status: Status; setPaidAt: boolean }> = {
  // One-time: only a payment counts, and it wins over a cancel (the money came in).
  "one_time/pending/paid": { status: "paid", setPaidAt: true },
  "one_time/canceled/paid": { status: "paid", setPaidAt: true },
  // Subscription: a payment or an activation makes it active; canceled is final.
  "subscription/pending/active": { status: "active", setPaidAt: true },
  "subscription/pending/paid": { status: "active", setPaidAt: true },
  "subscription/past_due/active": { status: "active", setPaidAt: true },
  "subscription/past_due/paid": { status: "active", setPaidAt: true },
  "subscription/pending/past_due": { status: "past_due", setPaidAt: false },
  "subscription/active/past_due": { status: "past_due", setPaidAt: false },
  "subscription/pending/canceled": { status: "canceled", setPaidAt: false },
  "subscription/active/canceled": { status: "canceled", setPaidAt: false },
  "subscription/past_due/canceled": { status: "canceled", setPaidAt: false },
};

describe("applyEffect", () => {
  const cases: [Kind, Status, Effect][] = [];
  for (const kind of KINDS) for (const status of STATUSES) for (const effect of EFFECTS) cases.push([kind, status, effect]);

  it.each(cases)("%s charge in %s receiving %s", (kind, status, effect) => {
    expect(applyEffect({ kind, status }, effect)).toEqual(CHANGES[`${kind}/${status}/${effect}`] ?? null);
  });

  it("covers the whole table", () => {
    expect(cases).toHaveLength(KINDS.length * STATUSES.length * EFFECTS.length);
    // Every listed change is a real combination (no typo hides a missing rule).
    for (const key of Object.keys(CHANGES)) {
      const [kind, status, effect] = key.split("/");
      expect(KINDS).toContain(kind);
      expect(STATUSES).toContain(status);
      expect(EFFECTS).toContain(effect);
    }
  });

  it("a canceled subscription ignores everything", () => {
    for (const effect of EFFECTS) expect(applyEffect({ kind: "subscription", status: "canceled" }, effect)).toBeNull();
  });

  it("a replayed effect changes nothing", () => {
    expect(applyEffect({ kind: "one_time", status: "paid" }, "paid")).toBeNull();
    expect(applyEffect({ kind: "subscription", status: "active" }, "active")).toBeNull();
    expect(applyEffect({ kind: "subscription", status: "past_due" }, "past_due")).toBeNull();
  });
});
