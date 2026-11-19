import type { Metadata } from "next";
import { fontVariables } from "@/lib/fonts";
import { getRequestLocale } from "@/lib/i18n/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Velk Express",
  description: "Self-hosted support panel for web agencies.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={await getRequestLocale()} className={fontVariables}>
      <body className="ui-app">{children}</body>
    </html>
  );
}
