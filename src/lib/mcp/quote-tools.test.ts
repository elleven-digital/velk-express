import { describe, expect, it } from "vitest";
import { itemConfig, quoteInput } from "@/lib/mcp/quote-tools";

const SITE = "6f1c3f3e-9a55-4c38-9a4f-0d7a1b2c3d4e";
const OTHER_SITE = "0b8f8a52-1c6e-4f5a-8d61-4b0c2f9e7a10";
const CLIENT = "2c5d9e1f-3a4b-4c6d-8e7f-9a0b1c2d3e4f";
const QUOTE = "9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b";

describe("itemConfig", () => {
  it("site_creation keeps only the new site, trimmed", () => {
    expect(
      itemConfig({ kind: "site_creation", title: "Site", amount_cents: 1, new_site: { name: "  Shop ", url: " shop.com " }, site_id: SITE }),
    ).toEqual({ newSite: { name: "Shop", url: "shop.com" } });
    expect(itemConfig({ kind: "site_creation", title: "Site", amount_cents: 1 })).toEqual({});
  });

  it("maintenance takes an existing site before a new one", () => {
    expect(itemConfig({ kind: "maintenance", title: "Fix", amount_cents: 1, site_id: SITE, new_site: { name: "New" } })).toEqual({
      siteId: SITE,
    });
    expect(itemConfig({ kind: "maintenance", title: "Fix", amount_cents: 1, new_site: { name: "New", url: "" } })).toEqual({
      newSite: { name: "New" },
    });
  });

  it("support carries its sites and the hours plan; included minutes mean a limit", () => {
    expect(
      itemConfig({
        kind: "support",
        title: "Plan",
        amount_cents: 1,
        site_ids: [SITE, OTHER_SITE],
        new_sites: [{ name: "Blog", url: "blog.com" }, { name: "  " }],
        track_hours: true,
        show_hours_to_client: true,
        included_minutes_per_month: 600,
        extra_hour_cents: 15000,
        client_can_buy_hours: true,
      }),
    ).toEqual({
      siteIds: [SITE, OTHER_SITE],
      newSites: [{ name: "Blog", url: "blog.com" }],
      hours: { tracked: true, visible: true, limited: true, includedMinutes: 600, extraHourCents: 15000, purchasable: true },
    });
    expect(itemConfig({ kind: "support", title: "Plan", amount_cents: 1, track_hours: true })).toEqual({
      hours: { tracked: true, visible: false, limited: false, includedMinutes: 0, extraHourCents: null, purchasable: false },
    });
    expect(itemConfig({ kind: "support", title: "Plan", amount_cents: 1 })).toEqual({
      hours: { tracked: false, visible: false, limited: false, includedMinutes: 0, extraHourCents: null, purchasable: false },
    });
  });

  it("passes a malformed site id on, for the core to refuse with the panel's sentence", () => {
    expect(itemConfig({ kind: "maintenance", title: "Fix", amount_cents: 1, site_id: "nope" })).toEqual({ siteId: "nope" });
    expect(itemConfig({ kind: "support", title: "Plan", amount_cents: 1, site_ids: ["nope"] }).siteIds).toEqual(["nope"]);
  });
});

describe("quoteInput", () => {
  const items = [{ kind: "site_creation" as const, title: "Site", description: "Five pages", amount_cents: 500000, new_site: { name: "Shop" } }];

  it("for a client: the client, no prospect data, the quote id inside when editing", () => {
    expect(
      quoteInput({
        quote_id: QUOTE,
        title: "New site",
        client_id: ` ${CLIENT} `,
        prospect_name: "Ignored",
        prospect_email: "ignored@x.com",
        notes: "Valid 30 days",
        items,
      }),
    ).toEqual({
      quoteId: QUOTE,
      clientId: CLIENT,
      title: "New site",
      notes: "Valid 30 days",
      items: [{ kind: "site_creation", title: "Site", description: "Five pages", amountCents: 500000, config: { newSite: { name: "Shop" } } }],
    });
  });

  it("for a prospect: no client and the prospect's name and e-mail; no quote id when creating", () => {
    const input = quoteInput({ title: "New site", prospect_name: "Padaria Aurora", prospect_email: "oi@aurora.com", items });
    expect(input).toEqual({
      clientId: null,
      prospectName: "Padaria Aurora",
      prospectEmail: "oi@aurora.com",
      title: "New site",
      items: [{ kind: "site_creation", title: "Site", description: "Five pages", amountCents: 500000, config: { newSite: { name: "Shop" } } }],
    });
    expect("quoteId" in input).toBe(false);
    expect(quoteInput({ title: "T", client_id: "  ", prospect_name: "P", items }).clientId).toBeNull();
  });
});
