import "server-only";
import sanitizeHtml from "sanitize-html";

/** Raw editor HTML a message may carry, before sanitizing. */
export const MESSAGE_MAX_CHARS = 100_000;

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const INLINE_SRC = new RegExp(`^/api/files/(${UUID})$`);

/**
 * Allow-list sanitizer for message bodies (server-side, always). Only the editor's formatting
 * survives: no scripts, handlers, styles, iframes or forms. An <img> survives only when it
 * points at one of the app's own files (`/api/files/<uuid>`); external images are dropped.
 * Links keep http, https and mailto, and always open safely.
 */
export function sanitizeMessageHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "strike", "code", "pre",
      "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "a", "img",
    ],
    allowedAttributes: { a: ["href", "target", "rel"], img: ["src", "alt"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        // Only absolute http(s) and mailto targets: no relative links into the app's own routes.
        const href = (attribs.href ?? "").trim();
        const next: Record<string, string> = { ...attribs, target: "_blank", rel: "noopener noreferrer" };
        if (/^(https?:|mailto:)/i.test(href)) next.href = href;
        else delete next.href;
        return { tagName, attribs: next };
      },
      img: (tagName, attribs) => {
        const match = INLINE_SRC.exec(attribs.src ?? "");
        // An empty src is dropped by the filter below; the attribute filter would drop a relative one otherwise.
        return { tagName, attribs: { ...attribs, src: match ? `/api/files/${match[1].toLowerCase()}` : "" } };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}

const BLOCK_END = /<\/(p|div|li|h[1-6]|blockquote|pre|ul|ol)>|<br\s*\/?>|<hr\s*\/?>/gi;

/** Plain text of (already sanitized) html: blocks on their own lines, entities decoded. */
export function htmlToText(html: string): string {
  const stripped = sanitizeHtml(html.replace(BLOCK_END, "$&\n"), { allowedTags: [], allowedAttributes: {} });
  return stripped
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(39|x27);/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Uuids of the app's own images in a sanitized body, in order, without repeats. */
export function inlineImageIds(bodyHtml: string): string[] {
  const ids: string[] = [];
  for (const m of bodyHtml.matchAll(new RegExp(`<img\\b[^>]*?\\ssrc="/api/files/(${UUID})"`, "gi"))) {
    const id = m[1].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Sanitizes the editor's html and derives its text; null when nothing is left (no text and no image). */
export function messageBody(rawHtml: string): { bodyHtml: string; bodyText: string } | null {
  const bodyHtml = sanitizeMessageHtml(rawHtml);
  const bodyText = htmlToText(bodyHtml);
  if (!bodyText && inlineImageIds(bodyHtml).length === 0) return null;
  return { bodyHtml, bodyText };
}
