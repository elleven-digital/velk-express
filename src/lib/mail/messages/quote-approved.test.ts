import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { buildQuoteApprovedMail } from "./quote-approved";

const input = {
  to: "ana@x.com",
  name: "Bia <b>",
  agencyName: "Acme & Co",
  logoUrl: null,
  title: 'Site "new"',
  link: "https://painel.acme.com/admin/quotes/1",
};

describe("buildQuoteApprovedMail", () => {
  it("keeps the subject raw and escapes the name and title in the HTML", () => {
    const m = buildQuoteApprovedMail(en.quotes.approvedMail, input);
    expect(m.subject).toBe('Proposal approved: Site "new"');
    expect(m.html).toContain("Bia &lt;b&gt; approved items on the proposal &quot;Site &quot;new&quot;&quot;");
    expect(m.html).not.toContain("Bia <b>");
    expect(m.to).toBe("ana@x.com");
  });

  it("links the quote in the panel in the HTML and the text", () => {
    const m = buildQuoteApprovedMail(en.quotes.approvedMail, input);
    expect(m.html).toContain("https://painel.acme.com/admin/quotes/1");
    expect(m.text).toContain("https://painel.acme.com/admin/quotes/1");
  });
});
