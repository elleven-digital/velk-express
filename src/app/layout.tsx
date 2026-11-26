import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { getAgency } from "@/lib/agency";
import { AREA_HEADER, type Area } from "@/lib/area";
import { iconVersion, manifestPathFor } from "@/lib/pwa";
import { fontVariables } from "@/lib/fonts";
import { getRequestLocale } from "@/lib/i18n/server";
import "./globals.css";

/**
 * The tab shows the agency's name on every page, read at request time (never baked into a build).
 * Before the install, or when the database can't be reached, it falls back to the product's name.
 *
 * Every page also says how to install it as an app: the team's pages (and the team login) link the
 * team app's manifest, the rest the portal's; the iPhone gets its icon and opens it full screen.
 */
/**
 * The page may draw under the phone's status bar and home indicator (an installed app on iOS does
 * anyway); the frame's top bar, tab bar and sheets pad themselves by the safe-area insets, which
 * are zero in a normal browser tab.
 */
export const viewport: Viewport = { viewportFit: "cover" };

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const agency = await getAgency().catch(() => null);
  const name = agency?.name;
  const area = ((await headers()).get(AREA_HEADER) ?? "public") as Area;
  const title = name || "Velk Express";
  return {
    title,
    description: "Self-hosted support panel for web agencies.",
    ...(name
      ? {
          manifest: manifestPathFor(area),
          icons: { apple: `/pwa/apple-icon.png?${iconVersion(agency?.logoFileId ?? null)}` },
          appleWebApp: { capable: true, title, statusBarStyle: "default" as const },
        }
      : {}),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={await getRequestLocale()} className={fontVariables}>
      <body className="ui-app">{children}</body>
    </html>
  );
}
