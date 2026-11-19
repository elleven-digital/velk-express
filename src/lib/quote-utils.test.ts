import { describe, expect, it } from "vitest";
import { decidedTotals, missingSiteId, newQuoteToken, quoteStatusMeta, quoteTotals } from "./quote-utils";

describe("quoteTotals", () => {
  it("quoteTotals splits one-time and monthly", () => {
    expect(
      quoteTotals([
        { monthly: false, amountCents: 100_00 },
        { monthly: true, amountCents: 30_00 },
        { monthly: false, amountCents: 5_50 },
        { monthly: true, amountCents: 1 },
      ]),
    ).toEqual({ oneTimeCents: 105_50, monthlyCents: 30_01 });
    expect(quoteTotals([])).toEqual({ oneTimeCents: 0, monthlyCents: 0 });
  });
});

describe("quoteStatusMeta", () => {
  it("keys every status", () => {
    for (const s of ["draft", "sent", "accepted", "executed", "archived"] as const) {
      expect(quoteStatusMeta(s).key).toBe(s);
    }
  });
});

describe("newQuoteToken", () => {
  it("is url-safe, 32 characters and unique", () => {
    const a = newQuoteToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newQuoteToken()).not.toBe(a);
  });
});

describe("decidedTotals", () => {
  const items = [
    { monthly: false, amountCents: 100_00, clientApproved: true, executed: false },
    { monthly: true, amountCents: 30_00, clientApproved: false, executed: false },
    { monthly: false, amountCents: 5_00, clientApproved: false, executed: true },
  ];

  it("counts every item while the quote is sent or earlier", () => {
    expect(decidedTotals("sent", items)).toEqual({ oneTimeCents: 105_00, monthlyCents: 30_00 });
    expect(decidedTotals("draft", items)).toEqual({ oneTimeCents: 105_00, monthlyCents: 30_00 });
  });

  it("counts only approved or executed items once accepted or executed", () => {
    expect(decidedTotals("accepted", items)).toEqual({ oneTimeCents: 105_00, monthlyCents: 0 });
    expect(decidedTotals("executed", items)).toEqual({ oneTimeCents: 105_00, monthlyCents: 0 });
    expect(decidedTotals("accepted", [])).toEqual({ oneTimeCents: 0, monthlyCents: 0 });
  });
});

describe("missingSiteId", () => {
  it("is true only for a saved site that is not among the existing ones", () => {
    const existing = [{ id: "a" }, { id: "b" }];
    expect(missingSiteId("a", existing)).toBe(false);
    expect(missingSiteId("gone", existing)).toBe(true);
    expect(missingSiteId("", existing)).toBe(false);
    expect(missingSiteId("a", [])).toBe(true);
  });
});
