import { Geist, Geist_Mono } from "next/font/google";

/*
 * Type of the whole app (panel, client portal, logins), in the Vercel-like
 * panel proposal.
 */
const geist = Geist({
  subsets: ["latin", "latin-ext"],
  variable: "--font-geist",
  display: "swap",
});

// Literal code only: URLs, domains, DNS records.
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
  preload: false,
});

/**
 * Font variable classes for the <html> element (next/font puts the CSS
 * variables there). Never put a font size on <html>: rem would rescale.
 */
export const fontVariables = `${geist.variable} ${geistMono.variable}`;
