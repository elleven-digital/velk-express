import { fmt } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n";
import { escapeHtml, renderMailLayout } from "../layout";
import type { MailMessage } from "../send";

/**
 * The "quote approved" e-mail for an owner. `t` is the `quotes.approvedMail` slice of the
 * recipient's dictionary; `name` is the client or prospect; `link` is the quote in the panel.
 */
export function buildQuoteApprovedMail(
  t: Dict["quotes"]["approvedMail"],
  input: { to: string; name: string; agencyName: string; logoUrl: string | null; title: string; link: string },
): MailMessage {
  const { html, text } = renderMailLayout({
    agencyName: input.agencyName,
    logoUrl: input.logoUrl,
    heading: fmt(t.heading, { title: input.title }),
    // The body is trusted template HTML, so everything user-provided goes in escaped.
    bodyHtml: fmt(t.body, { name: escapeHtml(input.name), title: escapeHtml(input.title) }),
    button: { label: t.button, url: input.link },
    footer: fmt(t.footer, { agency: input.agencyName }),
  });
  return { to: input.to, subject: fmt(t.subject, { title: input.title }), html, text };
}
