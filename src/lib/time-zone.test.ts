import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, isTimeZone, timeZoneGroups, timeZoneOrDefault } from "./time-zone";

describe("isTimeZone", () => {
  it("accepts IANA names the runtime supports, and UTC", () => {
    for (const zone of ["America/Sao_Paulo", "Europe/Lisbon", "Asia/Tokyo", "UTC"]) expect(isTimeZone(zone)).toBe(true);
  });

  it("refuses unknown names, offsets, other spellings and empty text", () => {
    for (const zone of ["Mars/Base", "", "+03:00", "GMT+3", "america/sao_paulo", " America/Sao_Paulo"]) {
      expect(isTimeZone(zone)).toBe(false);
    }
    expect(isTimeZone(undefined as unknown as string)).toBe(false);
  });
});

describe("timeZoneOrDefault", () => {
  it("keeps a valid zone and falls back to São Paulo otherwise", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/Sao_Paulo");
    expect(timeZoneOrDefault("Europe/Lisbon")).toBe("Europe/Lisbon");
    expect(timeZoneOrDefault("Mars/Base")).toBe(DEFAULT_TIME_ZONE);
    expect(timeZoneOrDefault(null)).toBe(DEFAULT_TIME_ZONE);
  });
});

describe("timeZoneGroups", () => {
  it("groups every supported zone by region, UTC on its own first, each one valid", () => {
    const groups = timeZoneGroups();
    expect(groups[0]).toEqual({ region: "UTC", zones: [{ value: "UTC", label: "UTC" }] });
    const america = groups.find((g) => g.region === "America");
    expect(america?.zones).toContainEqual({ value: "America/Sao_Paulo", label: "Sao Paulo" });
    const all = groups.flatMap((g) => g.zones.map((z) => z.value));
    expect(new Set(all).size).toBe(all.length);
    expect(all.every(isTimeZone)).toBe(true);
    expect(all).toContain("Europe/Lisbon");
  });
});
