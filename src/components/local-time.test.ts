import { createElement, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgencyTimeZoneProvider } from "./agency-time-zone";
import { LocalTime } from "./local-time";

// 23:30 UTC on 31 January: 08:30 on 1 February in Tokyo, 20:30 on 31 January in São Paulo.
const iso = "2026-01-31T23:30:00.000Z";

const serverHtml = (timeZone?: string) => {
  const time = createElement(LocalTime, { iso, locale: "en" });
  return renderToString(timeZone ? createElement(AgencyTimeZoneProvider, { timeZone } as ComponentProps<typeof AgencyTimeZoneProvider>, time) : time);
};

describe("LocalTime before hydration", () => {
  it("renders in the agency's time zone", () => {
    const html = serverHtml("Asia/Tokyo");
    expect(html).toContain("Feb 1");
    expect(html).toContain("8:30");
  });

  it("renders in São Paulo outside a provider", () => {
    const html = serverHtml();
    expect(html).toContain("Jan 31");
    expect(html).toContain("8:30");
  });
});
