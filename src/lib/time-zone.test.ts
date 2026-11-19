import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, canonicalTimeZone, isTimeZone, timeZoneGroups, timeZoneOrDefault } from "./time-zone";

const resolved = (zone: string) => new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;

describe("isTimeZone", () => {
  it("accepts IANA names the runtime supports, and UTC", () => {
    for (const zone of ["America/Sao_Paulo", "Europe/Lisbon", "Asia/Tokyo", "UTC"]) expect(isTimeZone(zone)).toBe(true);
  });

  it("accepts aliases the runtime's list may leave out (modern and legacy spellings)", () => {
    for (const zone of ["Asia/Kolkata", "Europe/Kyiv", "Asia/Ho_Chi_Minh", "Asia/Calcutta", "Europe/Kiev"]) {
      expect(isTimeZone(zone)).toBe(true);
    }
  });

  it("refuses unknown names, offsets, empty or overlong text", () => {
    for (const zone of ["Mars/Base", "", "+03:00", "GMT+03:00", " America/Sao_Paulo", "America/Sao_Paulo/", "x".repeat(5000), "../etc"]) {
      expect(isTimeZone(zone)).toBe(false);
    }
    expect(isTimeZone(undefined as unknown as string)).toBe(false);
  });
});

describe("canonicalTimeZone", () => {
  it("is the runtime's own spelling of a zone, null for a bad one", () => {
    expect(canonicalTimeZone("America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(canonicalTimeZone("Asia/Kolkata")).toBe(resolved("Asia/Kolkata"));
    expect(canonicalTimeZone("Europe/Kyiv")).toBe(resolved("Europe/Kyiv"));
    expect(canonicalTimeZone("america/sao_paulo")).toBe("America/Sao_Paulo");
    expect(canonicalTimeZone("Mars/Base")).toBeNull();
    expect(canonicalTimeZone("+03:00")).toBeNull();
  });
});

describe("timeZoneOrDefault", () => {
  it("keeps a valid zone and falls back to São Paulo otherwise", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/Sao_Paulo");
    expect(timeZoneOrDefault("Europe/Lisbon")).toBe("Europe/Lisbon");
    expect(timeZoneOrDefault("Mars/Base")).toBe(DEFAULT_TIME_ZONE);
    expect(timeZoneOrDefault(null)).toBe(DEFAULT_TIME_ZONE);
  });

  it("keeps a stored zone that is not in the runtime's list instead of falling back", () => {
    const listed = new Set(Intl.supportedValuesOf("timeZone"));
    const outside = ["Asia/Kolkata", "Asia/Calcutta"].find((z) => !listed.has(z))!;
    expect(outside).toBeDefined();
    expect(timeZoneOrDefault(outside)).toBe(resolved(outside));
    expect(timeZoneOrDefault(outside)).not.toBe(DEFAULT_TIME_ZONE);
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
