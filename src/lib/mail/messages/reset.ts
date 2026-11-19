import { fmt } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n";
import { renderMailLayout } from "../layout";
import type { MailMessage } from "../send";

/** The password reset e-mail. `t` is the `auth.resetMail` slice of the recipient's dictionary. */
export function buildResetMail(
  t: Dict["auth"]["resetMail"],
  input: { to: string; userName: string; agencyName: string; logoUrl: string | null; link: string },
): MailMessage {
  const { html, text } = renderMailLayout({
    agencyName: input.agencyName,
    logoUrl: input.logoUrl,
    heading: fmt(t.heading, { name: input.userName }),
    bodyHtml: t.body,
    button: { label: t.button, url: input.link },
    footer: fmt(t.footer, { agency: input.agencyName }),
  });
  return { to: input.to, subject: fmt(t.subject, { agency: input.agencyName }), html, text };
}
