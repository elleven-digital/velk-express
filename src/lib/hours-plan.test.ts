import { describe, expect, it } from "vitest";
import {
  configHoursPlan,
  hoursConfig,
  hoursPlanFromLegacy,
  legacyHoursMode,
  normalizeHoursPlan,
  NO_HOURS,
  type HoursPlan,
} from "./hours-plan";

const full: HoursPlan = {
  tracked: true,
  visible: true,
  limited: true,
  includedMinutes: 600,
  extraHourCents: 15000,
  purchasable: true,
};

describe("normalizeHoursPlan", () => {
  it("keeps a full plan as it is", () => {
    expect(normalizeHoursPlan(full)).toEqual(full);
  });

  it("drops everything without support or without tracking", () => {
    expect(normalizeHoursPlan(full, false)).toEqual(NO_HOURS);
    expect(normalizeHoursPlan({ ...full, tracked: false })).toEqual(NO_HOURS);
  });

  it("drops the included minutes, the price and buying without included hours", () => {
    expect(normalizeHoursPlan({ ...full, limited: false })).toEqual({
      tracked: true,
      visible: true,
      limited: false,
      includedMinutes: 0,
      extraHourCents: null,
      purchasable: false,
    });
  });

  it("only lets the client buy when they see the hours and an extra hour has a price", () => {
    expect(normalizeHoursPlan({ ...full, visible: false }).purchasable).toBe(false);
    expect(normalizeHoursPlan({ ...full, extraHourCents: null }).purchasable).toBe(false);
    expect(normalizeHoursPlan({ ...full, extraHourCents: 0 }).purchasable).toBe(false);
  });

  it("allows included hours of zero (pay per hour)", () => {
    expect(normalizeHoursPlan({ ...full, includedMinutes: 0 })).toEqual({ ...full, includedMinutes: 0 });
  });

  it("keeps a limit the client does not see", () => {
    expect(normalizeHoursPlan({ ...full, visible: false, purchasable: false })).toEqual({
      ...full,
      visible: false,
      purchasable: false,
    });
  });
});

describe("legacy hours mode", () => {
  it("maps a plan to the old single choice", () => {
    expect(legacyHoursMode(NO_HOURS)).toBe("off");
    expect(legacyHoursMode({ ...NO_HOURS, tracked: true })).toBe("internal");
    expect(legacyHoursMode({ ...NO_HOURS, tracked: true, visible: true })).toBe("internal");
    expect(legacyHoursMode({ ...full, visible: false, purchasable: false })).toBe("internal");
    expect(legacyHoursMode(full)).toBe("package");
  });

  it("maps the old single choice to a plan", () => {
    expect(hoursPlanFromLegacy(undefined, undefined, undefined)).toEqual(NO_HOURS);
    expect(hoursPlanFromLegacy("off", 0, null)).toEqual(NO_HOURS);
    expect(hoursPlanFromLegacy("internal", 0, null)).toEqual({ ...NO_HOURS, tracked: true });
    expect(hoursPlanFromLegacy("package", 600, 15000)).toEqual(full);
    expect(hoursPlanFromLegacy("package", 600, null)).toEqual({ ...full, extraHourCents: null, purchasable: false });
  });
});

describe("quote item config", () => {
  it("reads the plan, or derives it from the legacy keys", () => {
    expect(configHoursPlan(hoursConfig(full))).toEqual(full);
    expect(configHoursPlan({ hoursMode: "package", includedMinutes: 600, extraHourCents: 15000 })).toEqual(full);
    expect(configHoursPlan({})).toEqual(NO_HOURS);
  });

  it("writes the legacy keys alongside the plan", () => {
    expect(hoursConfig(full)).toEqual({ hours: full, hoursMode: "package", includedMinutes: 600, extraHourCents: 15000 });
  });
});
