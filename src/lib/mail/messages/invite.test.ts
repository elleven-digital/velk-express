import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { buildInviteMail } from "./invite";

describe("buildInviteMail", () => {
  const input = {
    to: "bia@x.com",
    userName: "Bia",
    agencyName: "Studio <Acme>",
    logoUrl: "https://painel.acme.com/api/files/abc",
    link: "https://painel.acme.com/set-password/tok",
  };

  it("builds subject, html and text with the link and the agency brand", () => {
    const m = buildInviteMail(en.team.inviteMail, input);
    expect(m.to).toBe("bia@x.com");
    expect(m.subject).toContain("Studio <Acme>");
    expect(m.html).toContain("https://painel.acme.com/set-password/tok");
    expect(m.html).toContain("https://painel.acme.com/api/files/abc");
    expect(m.text).toContain("https://painel.acme.com/set-password/tok");
    expect(m.text).toContain("Bia");
  });

  it("escapes the agency name inside the body HTML", () => {
    const m = buildInviteMail(en.team.inviteMail, input);
    expect(m.html).not.toContain("<Acme>");
    expect(m.html).toContain("Studio &lt;Acme&gt;");
  });
});
