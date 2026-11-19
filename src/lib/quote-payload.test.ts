import { describe, expect, it } from "vitest";
import { parseQuotePayload } from "./quote-payload";

const ID = "11111111-1111-4111-8111-111111111111";
const SITE = "22222222-2222-4222-8222-222222222222";

const base = {
  mode: "client",
  clientId: ID,
  prospectName: "",
  prospectEmail: "",
  title: "Proposal",
  notes: "  keep my spaces  ",
  items: [] as unknown[],
};
const support = {
  kind: "support",
  title: "Care plan",
  description: "",
  amount: "350,00",
  siteId: "",
  newSiteName: "",
  newSiteUrl: "",
  siteIds: [SITE],
  newSites: [{ name: "shop.example.com", url: "" }, { name: "", url: "" }],
  hoursMode: "package",
  includedHours: "7,5",
  extraHourPrice: "80,00",
};

describe("the builder payload parser", () => {
  it("refuses garbage and keeps typed values", () => {
    for (const raw of ["", "not json", "[]", "null", "42", '"x"', '{"items":"x"}', JSON.stringify({ ...base, items: [{ ...support, kind: "nope" }] }), JSON.stringify({ ...base, mode: "other" })]) {
      expect(parseQuotePayload(raw)).toEqual({ ok: false, error: "invalidPayload" });
    }
    expect(parseQuotePayload("x".repeat(600_000))).toEqual({ ok: false, error: "invalidPayload" });

    // A typed value that is not a number names the item, so the screen keeps everything as typed.
    expect(parseQuotePayload(JSON.stringify({ ...base, items: [support, { ...support, amount: "12abc" }] }))).toEqual({
      ok: false,
      error: "invalidMoney",
      item: 1,
    });
    expect(parseQuotePayload(JSON.stringify({ ...base, items: [{ ...support, includedHours: "lots" }] }))).toEqual({
      ok: false,
      error: "invalidHours",
      item: 0,
    });
    expect(parseQuotePayload(JSON.stringify({ ...base, items: [{ ...support, extraHourPrice: "-5" }] }))).toEqual({
      ok: false,
      error: "invalidExtraHour",
      item: 0,
    });

    // Typed values come through: money in either convention, decimal hours, free text untouched.
    const parsed = parseQuotePayload(JSON.stringify({ ...base, items: [support] }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        clientId: ID,
        prospectName: undefined,
        prospectEmail: undefined,
        title: "Proposal",
        notes: "  keep my spaces  ",
        items: [
          {
            kind: "support",
            title: "Care plan",
            description: undefined,
            amountCents: 35000,
            config: {
              siteIds: [SITE],
              newSites: [{ name: "shop.example.com" }],
              hoursMode: "package",
              includedMinutes: 450,
              extraHourCents: 8000,
            },
          },
        ],
      },
    });
  });

  it("builds the shortcuts per kind and per who the quote is for", () => {
    const site = { ...support, kind: "site_creation", newSiteName: "novo.com", newSiteUrl: "https://novo.com", amount: "" };
    const maint = { ...support, kind: "maintenance", siteId: SITE, newSiteName: "ignored", amount: "1.200,50" };
    const maintNew = { ...maint, siteId: "", newSiteName: "blog.com", newSiteUrl: "" };
    const off = { ...support, hoursMode: "off", includedHours: "junk", extraHourPrice: "junk" };
    const res = parseQuotePayload(JSON.stringify({ ...base, items: [site, maint, maintNew, off] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items.map((i) => i.config)).toEqual([
      { newSite: { name: "novo.com", url: "https://novo.com" } },
      { siteId: SITE },
      { newSite: { name: "blog.com" } },
      { siteIds: [SITE], newSites: [{ name: "shop.example.com" }], hoursMode: "off", includedMinutes: 0, extraHourCents: null },
    ]);
    expect(res.value.items.map((i) => i.amountCents)).toEqual([0, 120050, 120050, 35000]);

    // A prospect has no sites: only the "new site" shortcuts survive, and the client is null.
    const prospect = parseQuotePayload(
      JSON.stringify({ ...base, mode: "prospect", clientId: ID, prospectName: "Acme", prospectEmail: "a@b.co", items: [maint, off] }),
    );
    expect(prospect).toMatchObject({ ok: true, value: { clientId: null, prospectName: "Acme", prospectEmail: "a@b.co" } });
    if (prospect.ok) expect(prospect.value.items.map((i) => i.config)).toEqual([
      { newSite: { name: "ignored" } },
      { newSites: [{ name: "shop.example.com" }], hoursMode: "off", includedMinutes: 0, extraHourCents: null },
    ]);
  });

  it("needs a client in client mode, and a name for a new site that has an address", () => {
    expect(parseQuotePayload(JSON.stringify({ ...base, clientId: "", items: [] }))).toEqual({ ok: false, error: "quoteNeedsClient" });
    expect(
      parseQuotePayload(JSON.stringify({ ...base, items: [{ ...support, newSites: [{ name: "", url: "https://x.com" }] }] })),
    ).toEqual({ ok: false, error: "required", item: 0 });
  });
});
