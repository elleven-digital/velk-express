const LATEST_URL = "https://api.github.com/repos/elleven-digital/velk-express/releases/latest";
const TIMEOUT_MS = 5_000;
const TTL_MS = 12 * 60 * 60 * 1000;

export const UPDATE_GUIDE_URL = "https://github.com/elleven-digital/velk-express/blob/main/docs/updating.md";

export type Release = { version: string; url: string };

function parts(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is a higher semver than `current`; a leading "v" is ignored. */
export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest);
  const b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

let cache: { at: number; value: Release | null } | null = null;
let inflight: Promise<Release | null> | null = null;

/** Test seam. */
export function resetUpdateCheckCache(): void {
  cache = null;
  inflight = null;
}

/** False when UPDATE_CHECK=false: the install never asks GitHub for anything. */
export function updateCheckEnabled(): boolean {
  return process.env.UPDATE_CHECK?.trim().toLowerCase() !== "false";
}

/**
 * The latest published release, or null: when UPDATE_CHECK=false (no request
 * at all), when the repository is private or unreachable, or on any error.
 * The answer, a failure included, is kept in memory for 12 hours.
 */
export async function getLatestRelease(fetcher: typeof fetch = fetch): Promise<Release | null> {
  if (!updateCheckEnabled()) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  // Simultaneous callers (the layout and the settings page) share one request.
  inflight ??= fetchLatest(fetcher).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchLatest(fetcher: typeof fetch): Promise<Release | null> {
  let value: Release | null = null;
  try {
    const res = await fetcher(LATEST_URL, {
      headers: { "User-Agent": "velk-express", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
      if (typeof body.tag_name === "string" && typeof body.html_url === "string" && body.html_url.startsWith("https://") && parts(body.tag_name)) {
        value = { version: body.tag_name.replace(/^v/, ""), url: body.html_url };
      }
    }
  } catch {
    value = null;
  }
  cache = { at: Date.now(), value };
  return value;
}
