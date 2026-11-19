import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { buildResetMail } from "./reset";

describe("buildResetMail", () => {
  it("builds subject, html and text with the link and the agency brand", () => {
    const m = buildResetMail(en.auth.resetMail, {
      to: "ana@x.com",
      userName: "Ana",
      agencyName: "Studio <Acme>",
      logoUrl: "https://painel.acme.com/api/files/abc",
      link: "https://painel.acme.com/set-password/tok",
    });
    expect(m.to).toBe("ana@x.com");
    expect(m.subject).toContain("Studio <Acme>");
    expect(m.html).toContain("https://painel.acme.com/set-password/tok");
    expect(m.html).toContain("https://painel.acme.com/api/files/abc");
    expect(m.html).toContain("Studio &lt;Acme&gt;");
    expect(m.text).toContain("https://painel.acme.com/set-password/tok");
    expect(m.text).toContain("Ana");
  });
});
