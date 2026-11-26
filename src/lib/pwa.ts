/**
 * The installable apps (PWA): the client portal and the team panel, each with its own manifest so
 * each opens on its own home. Names and icons come from the agency of this install, so nothing
 * about a particular agency is built in.
 */

export type PwaArea = "portal" | "team";

/** The files `/pwa/<file>` serves. */
export const PWA_FILES = {
  "portal.webmanifest": { kind: "manifest", area: "portal" },
  "team.webmanifest": { kind: "manifest", area: "team" },
  "icon-192.png": { kind: "icon", size: 192, maskable: false },
  "icon-512.png": { kind: "icon", size: 512, maskable: false },
  "icon-maskable-512.png": { kind: "icon", size: 512, maskable: true },
  "apple-icon.png": { kind: "icon", size: 180, maskable: false },
} as const;

export type PwaFile = keyof typeof PWA_FILES;

export function isPwaFile(name: string): name is PwaFile {
  return Object.hasOwn(PWA_FILES, name);
}

export const PWA_BACKGROUND = "#ffffff";

/** Bumped when the icons' drawing changes, so phones that cached the old ones fetch them again. */
const ICON_DRAWING = 2;

/**
 * The query that versions the icon addresses: the drawing and the logo. A new logo (or a new
 * drawing) is a new address, so neither the browser's cache nor a phone's keeps the old icon.
 */
export function iconVersion(logoFileId: string | null): string {
  return `v=${ICON_DRAWING}-${(logoFileId ?? "none").slice(0, 8)}`;
}

/** Where each app starts and what it may open inside itself. */
const START: Record<PwaArea, string> = { portal: "/", team: "/admin" };

/**
 * The web app manifest of one area. The portal is named after the agency; the team's app adds the
 * area ("Studio Acme (Team)"), so someone with both on a phone tells them apart.
 */
export function pwaManifest(
  area: PwaArea,
  agency: { name: string; locale: string; logoFileId: string | null },
  teamLabel: string,
) {
  const v = iconVersion(agency.logoFileId);
  const name = area === "portal" ? agency.name : `${agency.name} (${teamLabel})`;
  return {
    id: START[area],
    name,
    short_name: name,
    lang: agency.locale,
    start_url: START[area],
    scope: area === "team" ? "/admin" : "/",
    display: "standalone",
    background_color: PWA_BACKGROUND,
    theme_color: PWA_BACKGROUND,
    icons: [
      { src: `/pwa/icon-192.png?${v}`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/pwa/icon-512.png?${v}`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/pwa/icon-maskable-512.png?${v}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** The manifest an area's pages link to: the team's under /admin, the portal's everywhere else. */
export function manifestPathFor(area: "team" | "portal" | "public"): string {
  return area === "team" ? "/pwa/team.webmanifest" : "/pwa/portal.webmanifest";
}
