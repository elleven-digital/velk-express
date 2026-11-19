import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { buildTicketOpenedMail } from "./ticket-opened";

const input = {
  to: "ana@x.com",
  userName: "Ana",
  agencyName: "Studio Acme",
  logoUrl: null,
  number: 12,
  title: "<b>x</b>",
  openerName: "Bia <script>",
  siteName: "Loja & Cia",
  link: "https://painel.acme.com/admin/tickets/abc",
};

describe("buildTicketOpenedMail", () => {
  it("escapes the user text in the HTML and keeps the subject raw", () => {
    const m = buildTicketOpenedMail(en.tickets.openedMail, input);
    expect(m.subject).toBe("New ticket: #12 <b>x</b>");
    expect(m.html).not.toContain("<b>x</b>");
    expect(m.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("Loja &amp; Cia");
  });

  it("links the ticket in the HTML and in the text", () => {
    const m = buildTicketOpenedMail(en.tickets.openedMail, input);
    expect(m.html).toContain("https://painel.acme.com/admin/tickets/abc");
    expect(m.text).toContain("https://painel.acme.com/admin/tickets/abc");
    expect(m.to).toBe("ana@x.com");
  });

  it("uses the general label it is given when there is no site", () => {
    const m = buildTicketOpenedMail(en.tickets.openedMail, { ...input, siteName: en.tickets.generalLabel });
    expect(m.text).toContain("opened a ticket on General.");
  });
});
