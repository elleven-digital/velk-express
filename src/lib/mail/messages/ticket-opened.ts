import { fmt } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n";
import { escapeHtml, renderMailLayout } from "../layout";
import type { MailMessage } from "../send";

/**
 * The "a client opened a ticket" e-mail for the team. `t` is the `tickets.openedMail` slice of the
 * recipient's dictionary; `siteName` is already the general label when the ticket has no site. The
 * message body never goes in the mail.
 */
export function buildTicketOpenedMail(
  t: Dict["tickets"]["openedMail"],
  input: {
    to: string;
    userName: string;
    agencyName: string;
    logoUrl: string | null;
    number: number;
    title: string;
    openerName: string;
    siteName: string;
    link: string;
  },
): MailMessage {
  const { html, text } = renderMailLayout({
    agencyName: input.agencyName,
    logoUrl: input.logoUrl,
    heading: fmt(t.heading, { name: input.userName }),
    // The body is trusted template HTML, so everything user-provided goes in escaped.
    bodyHtml: `${fmt(t.body, { name: escapeHtml(input.openerName), site: escapeHtml(input.siteName) })}<p><strong>#${input.number} ${escapeHtml(input.title)}</strong></p>`,
    button: { label: t.button, url: input.link },
    footer: fmt(t.footer, { agency: input.agencyName }),
  });
  return { to: input.to, subject: fmt(t.subject, { number: String(input.number), title: input.title }), html, text };
}
