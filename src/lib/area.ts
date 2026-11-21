export type Area = "team" | "portal" | "public";

/** Request header the proxy sets so server code knows which area a request belongs to. */
export const AREA_HEADER = "x-vx-area";

const PUBLIC_PREFIXES = ["/login", "/forgot", "/set-password", "/install", "/q", "/pay"];

const isUnder = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The team panel, plus the AI connector (`/mcp`) and its login (`/oauth`, `/.well-known`). */
const TEAM_PREFIXES = ["/admin", "/mcp", "/oauth", "/.well-known"];

/** Which area a path belongs to: the team panel, the logged-out pages, or (the rest) the portal. */
export function areaFor(pathname: string): Area {
  if (TEAM_PREFIXES.some((p) => isUnder(pathname, p))) return "team";
  if (PUBLIC_PREFIXES.some((p) => isUnder(pathname, p))) return "public";
  return "portal";
}
