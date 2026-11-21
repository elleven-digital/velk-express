import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { teamNavItems } from "./nav-items";

const hrefs = (role: Parameters<typeof teamNavItems>[0]) => teamNavItems(role, en.panel).map((i) => i.href);

describe("teamNavItems", () => {
  it("shows Settings to every role, collaborators included", () => {
    expect(hrefs("collaborator")).toEqual(["/admin", "/admin/tickets", "/admin/clients", "/admin/settings"]);
    expect(hrefs("manager")).toEqual(["/admin", "/admin/tickets", "/admin/clients", "/admin/charges", "/admin/settings"]);
    expect(hrefs("owner")).toEqual([
      "/admin",
      "/admin/tickets",
      "/admin/clients",
      "/admin/quotes",
      "/admin/charges",
      "/admin/team",
      "/admin/settings",
    ]);
  });

  it("keeps Team and Settings in the account group", () => {
    const account = teamNavItems("owner", en.panel).filter((i) => i.account).map((i) => i.href);
    expect(account).toEqual(["/admin/team", "/admin/settings"]);
  });
});
