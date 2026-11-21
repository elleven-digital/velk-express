import { describe, expect, it } from "vitest";
import { areaFor } from "./area";

describe("areaFor", () => {
  it("maps /admin and below to the team area", () => {
    expect(areaFor("/admin")).toBe("team");
    expect(areaFor("/admin/clients/x")).toBe("team");
    expect(areaFor("/admin/login")).toBe("team");
  });
  it("does not treat lookalike prefixes as the team area", () => {
    expect(areaFor("/administrator")).toBe("portal");
  });
  it("maps the logged-out pages to the public area", () => {
    expect(areaFor("/login")).toBe("public");
    expect(areaFor("/forgot")).toBe("public");
    expect(areaFor("/set-password/abc")).toBe("public");
    expect(areaFor("/install")).toBe("public");
  });
  it("/q is a public area", () => {
    expect(areaFor("/q/abc")).toBe("public");
    expect(areaFor("/q")).toBe("public");
    expect(areaFor("/quotes")).toBe("portal");
  });
  it("/pay is a public area", () => {
    expect(areaFor("/pay/abc")).toBe("public");
    expect(areaFor("/pay")).toBe("public");
    expect(areaFor("/payments")).toBe("portal");
  });
  it("maps the AI connector and its login to the team area", () => {
    expect(areaFor("/mcp")).toBe("team");
    expect(areaFor("/oauth/token")).toBe("team");
    expect(areaFor("/oauth/authorize")).toBe("team");
    expect(areaFor("/oauth/register")).toBe("team");
    expect(areaFor("/.well-known/oauth-authorization-server")).toBe("team");
    expect(areaFor("/.well-known/oauth-protected-resource/mcp")).toBe("team");
    expect(areaFor("/mcpx")).toBe("portal");
    expect(areaFor("/oauthx")).toBe("portal");
  });
  it("maps everything else to the portal", () => {
    expect(areaFor("/")).toBe("portal");
    expect(areaFor("/users")).toBe("portal");
  });
});
