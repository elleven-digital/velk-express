import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { buildLinkedMail } from "./linked";

describe("buildLinkedMail", () => {
  const input = {
    to: "bia@x.com",
    userName: "Bia",
    agencyName: "Studio <Acme>",
    clientName: "Beta & Co",
    logoUrl: null,
    resetLink: "https://painel.acme.com/forgot?side=portal",
  };

  it("names the company and the agency and links the portal password reset", () => {
    const m = buildLinkedMail(en.portal.linkedMail, input);
    expect(m.to).toBe("bia@x.com");
    expect(m.subject).toBe("You now have access to Beta & Co through Studio <Acme>");
    expect(m.html).toContain("https://painel.acme.com/forgot?side=portal");
    expect(m.text).toContain("https://painel.acme.com/forgot?side=portal");
    expect(m.text).toContain("Beta & Co");
  });

  it("escapes the names inside the body HTML", () => {
    const m = buildLinkedMail(en.portal.linkedMail, input);
    expect(m.html).not.toContain("<Acme>");
    expect(m.html).toContain("Beta &amp; Co");
  });
});
