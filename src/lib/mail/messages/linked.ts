import { fmt } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n";
import { escapeHtml, renderMailLayout } from "../layout";
import type { MailMessage } from "../send";

/** Tells an active portal login it was linked to one more company. `t` is the `portal.linkedMail` slice. */
export function buildLinkedMail(
  t: Dict["portal"]["linkedMail"],
  input: { to: string; userName: string; agencyName: string; clientName: string; logoUrl: string | null; resetLink: string },
): MailMessage {
  const { html, text } = renderMailLayout({
    agencyName: input.agencyName,
    logoUrl: input.logoUrl,
    heading: fmt(t.heading, { name: input.userName }),
    // The body is trusted template HTML, so the names go in escaped.
    bodyHtml: fmt(t.body, { agency: escapeHtml(input.agencyName), client: escapeHtml(input.clientName) }),
    button: { label: t.button, url: input.resetLink },
    footer: fmt(t.footer, { agency: input.agencyName }),
  });
  return {
    to: input.to,
    subject: fmt(t.subject, { agency: input.agencyName, client: input.clientName }),
    html,
    text,
  };
}
