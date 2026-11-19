import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { escapeHtml } from "../layout";
import { buildInviteMail } from "./invite";
import { buildLinkedMail } from "./linked";
import { buildQuoteApprovedMail } from "./quote-approved";
import { buildQuoteSentMail } from "./quote-sent";
import { buildResetMail } from "./reset";
import { buildTicketOpenedMail } from "./ticket-opened";

const evil = "<script>alert(1)</script>";
const base = { to: "a@x.com", agencyName: "Acme", logoUrl: null, link: "https://x.com/l" };

describe("shared mail escape", () => {
  it("escapeHtml escapes the five HTML characters", () => {
    expect(escapeHtml(`<a href="x" t='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; t=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("every mail message escapes with the shared helper", () => {
    const mails = [
      buildInviteMail(en.team.inviteMail, { ...base, userName: evil, agencyName: evil }),
      buildLinkedMail(en.portal.linkedMail, { ...base, userName: evil, agencyName: evil, clientName: evil, resetLink: base.link }),
      buildQuoteApprovedMail(en.quotes.approvedMail, { ...base, name: evil, title: evil }),
      buildQuoteSentMail(en.quotes.sentMail, { ...base, name: evil, title: evil, agencyName: evil }),
      buildResetMail(en.auth.resetMail, { ...base, userName: evil, agencyName: evil }),
      buildTicketOpenedMail(en.tickets.openedMail, {
        to: "a@x.com",
        agencyName: evil,
        logoUrl: null,
        openerName: evil,
        siteName: evil,
        number: 1,
        title: evil,
        link: base.link,
      } as never),
    ];
    for (const m of mails) {
      expect(m.html).not.toContain("<script>");
      expect(m.html).toContain("&lt;script&gt;");
    }
  });

  it("no message keeps its own copy of the escape", () => {
    for (const file of readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).not.toMatch(/function esc\b/);
    }
  });
});
