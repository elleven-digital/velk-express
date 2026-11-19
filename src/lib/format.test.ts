import { describe, expect, it } from "vitest";
import { formatBytes, formatCycle, formatDay, formatMinutes, formatMoment, formatMoney, formatNextCycleStart, parseMoney } from "./format";

describe("parseMoney", () => {
  it("reads whole amounts", () => {
    expect(parseMoney("1500")).toBe(150000);
  });

  it("reads both decimal conventions", () => {
    expect(parseMoney("1500,50")).toBe(150050);
    expect(parseMoney("1.500,50")).toBe(150050);
    expect(parseMoney("1,500.50")).toBe(150050);
    expect(parseMoney("1500.50")).toBe(150050);
  });

  it("treats a lone separator before three digits as grouping", () => {
    expect(parseMoney("1.200")).toBe(120000);
    expect(parseMoney("1,200")).toBe(120000);
  });

  it("is null for empty, negative or not a number", () => {
    expect(parseMoney("-1")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("   ")).toBeNull();
  });

  it("rejects garbage around the digits", () => {
    expect(parseMoney("12abc")).toBeNull();
    expect(parseMoney("1e3")).toBeNull();
    expect(parseMoney("1.500,50.20")).toBeNull();
    expect(parseMoney("1,500.50,20")).toBeNull();
    expect(parseMoney("R$ abc")).toBeNull();
  });

  it("accepts a currency prefix and spaces", () => {
    expect(parseMoney("R$ 1.500,50")).toBe(150050);
    expect(parseMoney("US$1,500.50")).toBe(150050);
    expect(parseMoney("$ 12")).toBe(1200);
    expect(parseMoney("€ 1 500,50")).toBe(150050);
  });

  it("parseMoney accepts a currency symbol after the number", () => {
    expect(parseMoney("1.500,50 €")).toBe(150050);
    expect(parseMoney("1,500.50 US$")).toBe(150050);
    expect(parseMoney("1.500,50 R$")).toBe(150050);
    expect(parseMoney("12$")).toBe(1200);
    expect(parseMoney("12 abc")).toBeNull();
    expect(parseMoney("R$ 12 R$")).toBeNull();
    expect(parseMoney("€")).toBeNull();
  });

  it("reads a leading zero before one separator as a decimal", () => {
    expect(parseMoney("0,005")).toBe(0);
    expect(parseMoney("0.001")).toBe(0);
    expect(parseMoney("0,5")).toBe(50);
    expect(parseMoney("0.50")).toBe(50);
  });

  it("is null for amounts too large to store", () => {
    expect(parseMoney("99999999999")).toBeNull();
  });
});

describe("formatMoney", () => {
  it("formats in the agency currency and the viewer's locale", () => {
    expect(formatMoney(150050, "BRL", "pt")).toContain("1.500,50");
    expect(formatMoney(150050, "USD", "en")).toBe("$1,500.50");
  });
});

describe("formatBytes", () => {
  it("uses the viewer's decimal mark", () => {
    const pt = formatBytes(2_500_000, "pt");
    expect(pt).toContain("2,4");
    expect(pt).toContain("MB");
    expect(formatBytes(2_500_000, "en")).toBe("2.4 MB");
  });
  it("small sizes are bytes", () => {
    expect(formatBytes(900, "en")).toBe("900 B");
  });
});

describe("formatMoment", () => {
  it("shows the year only when it is not the current one", () => {
    const now = new Date(2026, 10, 18, 12);
    expect(formatMoment(new Date(2026, 9, 3, 9, 5), "en", now)).not.toContain("2026");
    expect(formatMoment(new Date(2025, 9, 3, 9, 5), "en", now)).toContain("2025");
  });
});

describe("formatMinutes", () => {
  it("writes hours and minutes the same in every language", () => {
    expect(formatMinutes(0)).toBe("0min");
    expect(formatMinutes(5)).toBe("5min");
    expect(formatMinutes(45)).toBe("45min");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(90)).toBe("1h30");
    expect(formatMinutes(125)).toBe("2h05");
    expect(formatMinutes(600)).toBe("10h");
    expect(formatMinutes(1500)).toBe("25h");
    expect(formatMinutes(-5)).toBe("-5min");
    expect(formatMinutes(-90)).toBe("-1h30");
    expect(formatMinutes(-150)).toBe("-2h30");
  });
});

describe("formatCycle and formatNextCycleStart", () => {
  it("names the month and the next cycle's first day", () => {
    expect(formatCycle("2026-11", "pt")).toBe("novembro de 2026");
    expect(formatCycle("2026-11", "en")).toBe("November 2026");
    expect(formatNextCycleStart("2026-11", "pt")).toBe("1 de dezembro");
    expect(formatNextCycleStart("2026-12", "pt")).toBe("1 de janeiro");
  });
});

describe("formatDay", () => {
  it("does not shift the day", () => {
    expect(formatDay("2026-11-30", "en")).toContain("30");
    expect(formatDay("2026-12-01", "en")).toContain("01");
  });
});
