import { getConfig } from "@/lib/config";
import { getInstance } from "@/lib/instance";

/** Returns the origin of an http(s) URL (no path, query or trailing slash), or null. */
export function normalizeAppUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // not a URL
  }
  return null;
}

function first(value: string | null): string | null {
  const v = value?.split(",")[0]?.trim();
  return v ? v : null;
}

/**
 * Guesses the public address from a request: the reverse proxy's forwarded
 * protocol and host when present, else the Host header over http. No other
 * header is trusted.
 */
export function detectAppUrl(headers: Headers): string | null {
  const host = first(headers.get("x-forwarded-host")) ?? first(headers.get("host"));
  if (!host) return null;
  const proto = first(headers.get("x-forwarded-proto"));
  const scheme = proto === "https" || proto === "http" ? proto : "http";
  return normalizeAppUrl(`${scheme}://${host}`);
}

/** The public address: APP_URL, else the one saved at install. Throws before install. */
export async function getAppUrl(): Promise<string> {
  const fromEnv = getConfig().appUrl;
  if (fromEnv) return fromEnv;
  const { appUrl } = await getInstance();
  if (appUrl) return appUrl;
  throw new Error("The public URL is not set: set APP_URL or finish the install.");
}
