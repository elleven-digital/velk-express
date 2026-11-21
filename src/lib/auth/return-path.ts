/**
 * Where to go after logging in (`next`), only when it stays on this site: a
 * path that starts with `/` but not `//` nor `/\` (both mean another host to a
 * browser). Control characters are refused too, because browsers drop them
 * from URLs (`/\t/evil.test` would become `//evil.test`). Anything else is `null`.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}
