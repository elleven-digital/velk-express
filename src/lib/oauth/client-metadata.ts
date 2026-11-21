import { isIP } from "node:net";

/**
 * Client ID metadata documents (the MCP spec's preferred way for an app to
 * identify itself without prior registration): the client_id is an https URL
 * of the app, which publishes its name and redirect URIs there. The install
 * fetches that document when the app asks for authorization.
 *
 * It's a server-side fetch to a URL anyone can choose — hence the refusals:
 * https only; no internal or local-network address (the name is resolved
 * first and every address must be public); no redirects; 5 seconds and 64 KB
 * at most, with the body read as a stream and cut off. The document must
 * state its own URL as client_id, exactly.
 *
 * Known limit: DNS that changes answers between the check and the fetch
 * (rebinding) isn't covered; https, the short timeout, the size cap and not
 * following redirects are what protect.
 *
 * Network and DNS come through `MetadataDeps`: no test touches the network.
 */

export type MetadataFetch = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export type HostLookup = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<{ address: string; family: number }[]>;

export type MetadataDeps = { fetch: MetadataFetch; lookup: HostLookup };

export const DNS_QUERY_TIMEOUT_MS = 2000;

/**
 * Real resolution through Node's c-ares `Resolver` (one try, 2 seconds, A and
 * AAAA). Not `dns.lookup`: that's getaddrinfo on libuv's thread pool, which
 * can't be cancelled and would hold the pool the database also uses.
 */
export const resolveHost: HostLookup = async (hostname, signal) => {
  const { promises } = await import("node:dns");
  const resolver = new promises.Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: 1 });
  const cancel = () => resolver.cancel();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    const found = [
      ...(v4.status === "fulfilled" ? v4.value : []).map((address) => ({ address, family: 4 })),
      ...(v6.status === "fulfilled" ? v6.value : []).map((address) => ({ address, family: 6 })),
    ];
    if (found.length === 0) throw new Error(`No address for ${hostname}`);
    return found;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
};

export const defaultMetadataDeps: MetadataDeps = {
  fetch: (url, init) => fetch(url, init),
  lookup: resolveHost,
};

export const METADATA_TIMEOUT_MS = 5000;
export const METADATA_MAX_BYTES = 64 * 1024;
export const METADATA_MAX_CACHE_MS = 24 * 60 * 60 * 1000;

export const CLIENT_NAME_MAX = 100;
export const REDIRECT_URIS_MAX = 10;
export const URL_MAX = 2048;

export type MetadataRefusal =
  | "not_https"
  | "private_address"
  | "unreachable"
  | "redirected"
  | "timeout"
  | "too_large"
  | "invalid_document"
  | "client_id_mismatch";

export type MetadataResult =
  | { ok: true; name: string; redirectUris: string[]; ttlMs: number }
  | { ok: false; reason: MetadataRefusal };

/** The client_id is a document URL: https, with a path. */
export function isMetadataDocumentClientId(clientId: string): boolean {
  if (clientId.length > URL_MAX) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.pathname !== "/" &&
    url.username === "" &&
    url.password === "" &&
    !clientId.includes("#")
  );
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Accepted redirect URI shape: https, or http on the machine itself
 * (desktop apps). No fragment, no credentials.
 */
export function redirectUriShapeOk(uri: string): boolean {
  if (typeof uri !== "string" || uri.length > URL_MAX || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return url.hostname !== "";
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
}

/** Control characters and bidi marks: they'd rewrite how a name reads. */
function isControlOrBidi(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code < 0xa0) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** Text on a single line: whitespace collapsed, control and bidi characters removed. */
export function singleLineText(raw: string): string {
  return [...raw.replace(/\s+/g, " ")]
    .filter((ch) => !isControlOrBidi(ch.codePointAt(0) ?? 0))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** The app's self-declared name on one line; `null` if not text or too long; "" if nothing is left. */
export function clientNameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = singleLineText(raw);
  return [...name].length > CLIENT_NAME_MAX ? null : name;
}

/** 1 to 10 redirect URIs, all of an accepted shape; otherwise `null`. */
export function redirectUrisOf(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 1 || raw.length > REDIRECT_URIS_MAX) return null;
  return raw.every((uri) => typeof uri === "string" && redirectUriShapeOk(uri))
    ? (raw as string[])
    : null;
}

function octets(ipv4: string): number[] {
  return ipv4.split(".").map(Number);
}

function privateIpv4(ipv4: string): boolean {
  const [a, b] = octets(ipv4);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6, with a trailing IPv4 converted. */
function groups(ipv6: string): number[] | null {
  let text = ipv6.toLowerCase();
  const ipv4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4) {
    const [a, b, c, d] = octets(ipv4[1]);
    text = `${text.slice(0, -ipv4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parts = (s: string | undefined) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const start = parts(head);
  const end = parts(tail);
  if (tail === undefined) return start.length === 8 ? start : null;
  const zeros = 8 - start.length - end.length;
  return zeros < 0 ? null : [...start, ...Array(zeros).fill(0), ...end];
}

/**
 * Internal, local-network or special address? Loopback, private ranges,
 * 100.64/10, link-local, 0/8, multicast and reserved, `::`, `::1`,
 * fc00::/7, fe80::/10, IPv6 multicast, IPv4-compatible, NAT64 and
 * IPv4-mapped forms of those. Anything that doesn't parse as an IP counts as
 * internal: when in doubt, don't fetch.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const version = isIP(bare);
  if (version === 4) return privateIpv4(bare);
  if (version !== 6) return true;
  const g = groups(bare);
  if (!g) return true;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(6)) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return true;
  if (zeroUpTo(5) && g[5] === 0xffff) {
    return privateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join("."));
  }
  return (
    (g[0] & 0xfe00) === 0xfc00 ||
    (g[0] & 0xffc0) === 0xfe80 ||
    (g[0] & 0xff00) === 0xff00
  );
}

/** How long a fetched document is trusted: the app's max-age, up to 24 hours. */
export function cacheTtlMs(cacheControl: string | null): number {
  if (!cacheControl) return METADATA_MAX_CACHE_MS;
  const directives = cacheControl
    .toLowerCase()
    .split(",")
    .map((d) => d.trim());
  if (directives.includes("no-store") || directives.includes("no-cache")) return 0;
  const maxAge = directives.map((d) => d.match(/^max-age\s*=\s*"?(\d+)"?$/)).find(Boolean);
  if (!maxAge) return METADATA_MAX_CACHE_MS;
  return Math.min(Number(maxAge[1]) * 1000, METADATA_MAX_CACHE_MS);
}

/** Waits for the promise but gives up when the signal aborts, even if the promise ignores it. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {});
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The body read as a stream up to the limit; `null` past it. */
async function bodyUpTo(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function readDocument(text: string, url: string): MetadataResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_document" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, reason: "invalid_document" };
  }
  const fields = doc as Record<string, unknown>;
  if (fields.client_id !== url) return { ok: false, reason: "client_id_mismatch" };
  const name = clientNameOf(fields.client_name);
  const redirectUris = redirectUrisOf(fields.redirect_uris);
  if (!name || !redirectUris) return { ok: false, reason: "invalid_document" };
  return { ok: true, name, redirectUris, ttlMs: 0 };
}

/** Fetches and checks an app's metadata document. Never throws: every failure is a refusal. */
export async function fetchClientMetadata(
  url: string,
  deps: MetadataDeps = defaultMetadataDeps,
): Promise<MetadataResult> {
  if (!isMetadataDocumentClientId(url)) return { ok: false, reason: "not_https" };
  const host = new URL(url).hostname;

  // One deadline covers DNS, the fetch and reading the body.
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), METADATA_TIMEOUT_MS);
  try {
    const written = host.replace(/^\[|\]$/g, "");
    if (isIP(written)) {
      if (isPrivateAddress(written)) return { ok: false, reason: "private_address" };
    } else {
      let addresses: { address: string }[];
      try {
        addresses = await untilAborted(deps.lookup(host, control.signal), control.signal);
      } catch {
        return { ok: false, reason: control.signal.aborted ? "timeout" : "unreachable" };
      }
      if (addresses.length === 0) return { ok: false, reason: "unreachable" };
      if (addresses.some((a) => isPrivateAddress(a.address))) {
        return { ok: false, reason: "private_address" };
      }
    }

    const response = await deps.fetch(url, {
      redirect: "manual",
      signal: control.signal,
      headers: { Accept: "application/json" },
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: "redirected" };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: "unreachable" };
    }
    const text = await bodyUpTo(response, METADATA_MAX_BYTES);
    if (text === null) return { ok: false, reason: "too_large" };
    const read = readDocument(text, url);
    if (!read.ok) return read;
    return { ...read, ttlMs: cacheTtlMs(response.headers.get("cache-control")) };
  } catch {
    return { ok: false, reason: control.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
