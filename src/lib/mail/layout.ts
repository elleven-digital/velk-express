/**
 * HTML for transactional emails. Pure (no env, no server-only) so it can be
 * rendered in scripts and previews. Table-based layout with inline styles,
 * the only thing email clients agree on. Neutral palette and a black primary
 * button; no platform branding.
 */

export type MailLayoutInput = {
  agencyName: string;
  /** Absolute URL of the agency's logo; null shows the agency name instead. */
  logoUrl: string | null;
  heading: string;
  /** Trusted HTML from our own templates; inserted as-is, never user input. */
  bodyHtml: string;
  button?: { label: string; url: string };
  footer: string;
};

const FONT = "font-family:Arial,Helvetica,sans-serif;";
const PAPER = "#f4f4f5";
const LINE = "#ebebeb";
const INK = "#171717";
const BODY = "#404040";
const MUTED = "#5e5e5e";

/** Escapes text for HTML (element content and quoted attributes). Shared by the layout and every message. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderMailLayout(input: MailLayoutInput): { html: string; text: string } {
  const name = escapeHtml(input.agencyName);
  const brand = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" width="36" height="36" alt="${name}" style="display:block;width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid ${LINE};background:#ffffff;" />`
    : `<span style="${FONT}font-size:15px;font-weight:800;color:${INK};letter-spacing:.02em;">${name}</span>`;

  const button = input.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0;"><tr><td style="border-radius:999px;background:${INK};">
            <a href="${escapeHtml(input.button.url)}" style="display:inline-block;padding:13px 28px;${FONT}font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(input.button.label)}</a>
          </td></tr></table>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body style="margin:0;padding:0;background:${PAPER};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 8px 16px;">${brand}</td></tr>
        <tr><td style="background:#ffffff;border-radius:20px;padding:36px 36px 32px;border:1px solid ${LINE};">
          <h1 style="margin:0 0 14px;${FONT}font-size:22px;line-height:1.3;color:${INK};">${escapeHtml(input.heading)}</h1>
          <div style="${FONT}font-size:15px;line-height:1.65;color:${BODY};">${input.bodyHtml}</div>
          ${button}
        </td></tr>
        <tr><td style="padding:18px 8px 0;${FONT}font-size:12px;line-height:1.5;color:${MUTED};">${escapeHtml(input.footer)}</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  const parts = [input.agencyName, input.heading, htmlToText(input.bodyHtml)];
  if (input.button) parts.push(`${input.button.label}: ${input.button.url}`);
  parts.push(input.footer);
  return { html, text: parts.join("\n\n") };
}
