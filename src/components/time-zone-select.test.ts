import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { timeZoneGroups } from "@/lib/time-zone";
import { matchInList, TimeZoneSelect } from "./time-zone-select";

const groups = timeZoneGroups();
const known = new Set(groups.flatMap((g) => g.zones.map((z) => z.value)));
const resolved = (zone: string) => new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
const selected = (html: string) => /<option value="([^"]+)" selected=""/.exec(html)?.[1];

describe("matchInList", () => {
  it("finds the list's spelling of a zone named another way", () => {
    expect(matchInList("Europe/Lisbon", known)).toBe("Europe/Lisbon");
    for (const zone of ["Asia/Kolkata", "Europe/Kyiv", "Asia/Ho_Chi_Minh"]) {
      const match = matchInList(zone, known);
      expect(match && known.has(match)).toBe(true);
      expect(resolved(match!)).toBe(resolved(zone));
    }
    expect(matchInList("Mars/Base", known)).toBeNull();
  });
});

describe("TimeZoneSelect", () => {
  const render = (props: { value?: string; fallback?: string }) =>
    renderToString(createElement(TimeZoneSelect, { id: "tz", name: "timeZone", groups, ...props }));

  it("shows the saved zone, and a forged submitted one falls back to it", () => {
    expect(selected(render({ fallback: "Europe/Lisbon" }))).toBe("Europe/Lisbon");
    expect(selected(render({ value: "Asia/Tokyo", fallback: "Europe/Lisbon" }))).toBe("Asia/Tokyo");
    expect(selected(render({ value: "Mars/Base", fallback: "Europe/Lisbon" }))).toBe("Europe/Lisbon");
  });

  it("keeps a saved zone the list does not have as its own selected option", () => {
    const outside = ["Asia/Kolkata", "Asia/Calcutta"].find((z) => !known.has(z))!;
    expect(selected(render({ fallback: outside }))).toBe(outside);
  });
});
