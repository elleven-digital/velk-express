import { fmt } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n";
import { escapeHtml, renderMailLayout } from "../layout";
import type { MailMessage } from "../send";

/**
 * The "quote sent" e-mail for the client or prospect. `t` is the `quotes.sentMail` slice of the
 * recipient's dictionary; `link` is the quote's public page.
 */
export function buildQuoteSentMail(
  t: Dict["quotes"]["sentMail"],
  input: { to: string; name: string; agencyName: string; logoUrl: string | null; title: string; link: string },
): MailMessage {
  const { html, text } = renderMailLayout({
    agencyName: input.agencyName,
    logoUrl: input.logoUrl,
    heading: fmt(t.heading, { name: input.name }),
    // The body is trusted template HTML, so everything user-provided goes in escaped.
    bodyHtml: fmt(t.body, { agency: escapeHtml(input.agencyName) }),
    button: { label: t.button, url: input.link },
    footer: fmt(t.footer, { agency: input.agencyName }),
  });
  return { to: input.to, subject: fmt(t.subject, { title: input.title, agency: input.agencyName }), html, text };
}
