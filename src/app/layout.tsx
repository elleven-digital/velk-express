import type { Metadata } from "next";
import { connection } from "next/server";
import { getAgency } from "@/lib/agency";
import { fontVariables } from "@/lib/fonts";
import { getRequestLocale } from "@/lib/i18n/server";
import "./globals.css";

/**
 * The tab shows the agency's name on every page, read at request time (never baked into a build).
 * Before the install, or when the database can't be reached, it falls back to the product's name.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const name = await getAgency()
    .then((agency) => agency?.name)
    .catch(() => null);
  return { title: name || "Velk Express", description: "Self-hosted support panel for web agencies." };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={await getRequestLocale()} className={fontVariables}>
      <body className="ui-app">{children}</body>
    </html>
  );
}
