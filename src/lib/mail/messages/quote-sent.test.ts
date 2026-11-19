import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { buildQuoteSentMail } from "./quote-sent";

const input = {
  to: "ana@x.com",
  name: "Ana <b>",
  agencyName: "Acme & Co",
  logoUrl: null,
  title: "Site <new>",
  link: "https://painel.acme.com/q/tok",
};

describe("buildQuoteSentMail", () => {
  it("keeps the subject raw and escapes user text in the HTML", () => {
    const m = buildQuoteSentMail(en.quotes.sentMail, input);
    expect(m.subject).toBe("Proposal: Site <new> — Acme & Co");
    expect(m.html).not.toContain("Ana <b>");
    expect(m.html).toContain("Ana &lt;b&gt;");
    expect(m.html).toContain("Acme &amp; Co sent you a proposal");
  });

  it("links the public page in the HTML and the text", () => {
    const m = buildQuoteSentMail(en.quotes.sentMail, input);
    expect(m.html).toContain("https://painel.acme.com/q/tok");
    expect(m.text).toContain("https://painel.acme.com/q/tok");
    expect(m.to).toBe("ana@x.com");
  });
});
