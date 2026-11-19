import { fmt } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n";
import { escapeHtml, renderMailLayout } from "../layout";
import type { MailMessage } from "../send";

/** The team invite e-mail. `t` is the `team.inviteMail` slice of the recipient's dictionary. */
export function buildInviteMail(
  t: Dict["team"]["inviteMail"],
  input: { to: string; userName: string; agencyName: string; logoUrl: string | null; link: string },
): MailMessage {
  const { html, text } = renderMailLayout({
    agencyName: input.agencyName,
    logoUrl: input.logoUrl,
    heading: fmt(t.heading, { name: input.userName }),
    // The body is trusted template HTML, so the agency name is escaped before it goes in.
    bodyHtml: fmt(t.body, { agency: escapeHtml(input.agencyName) }),
    button: { label: t.button, url: input.link },
    footer: fmt(t.footer, { agency: input.agencyName }),
  });
  return { to: input.to, subject: fmt(t.subject, { agency: input.agencyName }), html, text };
}
