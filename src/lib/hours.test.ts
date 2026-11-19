import { describe, expect, it } from "vitest";
import { cycleKey, cycleRange, isCycle, minutesToHoursInput, parseDuration, shiftCycle, todayInCycleZone } from "./hours";

describe("cycleKey", () => {
  it("uses São Paulo time at the month boundary", () => {
    expect(cycleKey(new Date("2026-12-01T01:00:00Z"))).toBe("2026-11");
    expect(cycleKey(new Date("2026-12-01T03:00:00Z"))).toBe("2026-12");
  });
});

describe("todayInCycleZone", () => {
  it("is the São Paulo day late in the evening", () => {
    expect(todayInCycleZone(new Date("2026-12-01T01:00:00Z"))).toBe("2026-11-30");
    expect(todayInCycleZone(new Date("2026-12-01T03:00:00Z"))).toBe("2026-12-01");
  });
});

describe("cycleRange", () => {
  it("ends on the last day, including February in leap years", () => {
    expect(cycleRange("2026-11")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(cycleRange("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(cycleRange("2026-02").end).toBe("2026-02-28");
    expect(cycleRange("2028-02").end).toBe("2028-02-29");
  });
});

describe("shiftCycle", () => {
  it("crosses years", () => {
    expect(shiftCycle("2026-12", 1)).toBe("2027-01");
    expect(shiftCycle("2026-01", -1)).toBe("2025-12");
    expect(shiftCycle("2026-11", 0)).toBe("2026-11");
    expect(shiftCycle("2026-11", -14)).toBe("2025-09");
  });
});

describe("isCycle", () => {
  it("rejects month 13", () => {
    expect(isCycle("2026-11")).toBe(true);
    expect(isCycle("2026-13")).toBe(false);
    expect(isCycle("2026-00")).toBe(false);
    expect(isCycle("2026-1")).toBe(false);
  });
});

describe("parseDuration", () => {
  it("reads minutes, 1h30, 1h, 45min, 1:30, 1,5h and 1.5h, and rejects 0, 1441, letters and empty", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1h")).toBe(60);
    expect(parseDuration("45min")).toBe(45);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("1,5h")).toBe(90);
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("  1H30  ")).toBe(90);
    expect(parseDuration("1440")).toBe(1440);
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("1441")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("1h75")).toBeNull();
    expect(parseDuration("-5")).toBeNull();
  });

  it("takes a custom maximum", () => {
    expect(parseDuration("1441", { max: 100000 })).toBe(1441);
    expect(parseDuration("100001", { max: 100000 })).toBeNull();
  });
});

describe("minutesToHoursInput", () => {
  it("shows at most two decimals and no trailing zeros", () => {
    expect(minutesToHoursInput(100)).toBe("1.67");
    expect(minutesToHoursInput(90)).toBe("1.5");
    expect(minutesToHoursInput(600)).toBe("10");
    expect(minutesToHoursInput(0)).toBe("");
  });
});
