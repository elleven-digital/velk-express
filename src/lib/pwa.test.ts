import { describe, expect, it } from "vitest";
import { iconVersion, isPwaFile, manifestPathFor, pwaManifest } from "./pwa";

const agency = { name: "Studio Acme", locale: "pt", logoFileId: "3f2a9c1e-0000-4000-8000-000000000000" };

describe("pwaManifest", () => {
  it("names the portal after the agency and starts it at the portal's home", () => {
    const m = pwaManifest("portal", agency, "Equipe");
    expect(m).toMatchObject({ id: "/", name: "Studio Acme", short_name: "Studio Acme", start_url: "/", scope: "/", display: "standalone", lang: "pt" });
  });

  it("tells the team's app apart and keeps it under /admin", () => {
    const m = pwaManifest("team", agency, "Equipe");
    expect(m).toMatchObject({ id: "/admin", name: "Studio Acme (Equipe)", start_url: "/admin", scope: "/admin" });
  });

  it("lists PNG icons of the sizes the browsers ask for, one maskable", () => {
    const icons = pwaManifest("portal", agency, "Equipe").icons;
    expect(icons.map((i) => [i.sizes, i.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const icon of icons) expect(isPwaFile(icon.src.replace("/pwa/", "").split("?")[0])).toBe(true);
  });
});

describe("iconVersion", () => {
  it("changes with the logo, so a new logo is a new icon address", () => {
    expect(iconVersion("3f2a9c1e-0000-4000-8000-000000000000")).not.toBe(iconVersion("aa11bb22-0000-4000-8000-000000000000"));
    expect(iconVersion(null)).toMatch(/none$/);
    expect(pwaManifest("portal", agency, "Equipe").icons[0].src).toBe(`/pwa/icon-192.png?${iconVersion(agency.logoFileId)}`);
  });
});

describe("manifestPathFor", () => {
  it("links the team's manifest under /admin and the portal's everywhere else", () => {
    expect(manifestPathFor("team")).toBe("/pwa/team.webmanifest");
    expect(manifestPathFor("portal")).toBe("/pwa/portal.webmanifest");
    expect(manifestPathFor("public")).toBe("/pwa/portal.webmanifest");
  });
});

describe("isPwaFile", () => {
  it("knows only the files it serves", () => {
    expect(isPwaFile("icon-192.png")).toBe(true);
    expect(isPwaFile("../secret")).toBe(false);
    expect(isPwaFile("constructor")).toBe(false);
  });
});
