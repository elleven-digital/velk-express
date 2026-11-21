/**
 * Response headers of the consent page. Another site must never show it in a
 * frame, or it could trick a signed-in person into clicking "Authorize"
 * (clickjacking, RFC 9700 §4.16). `frame-ancestors` is the current way;
 * `X-Frame-Options` covers older browsers. Kept free of server-only imports:
 * next.config.ts reads it.
 */
export const AUTHORIZE_PAGE_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];
