import "server-only";
import type { Side } from "@/lib/auth/credentials";

/**
 * In-memory fixed-window rate limiting, per process. With several instances
 * each one keeps its own window, which is enough to blunt password guessing.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

/** True when the call is allowed; false once `limit` calls happened inside the window. */
export function rateLimit(key: string, { limit, windowMs }: { limit: number; windowMs: number }): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/**
 * The client address: the LAST x-forwarded-for value, which the nearest proxy
 * appended and the client cannot forge (earlier values are client-controlled).
 * "unknown" when there is none.
 */
export function clientIp(headers: Pick<Headers, "get">): string {
  const parts = headers.get("x-forwarded-for")?.split(",") ?? [];
  const last = parts[parts.length - 1]?.trim();
  return last ? last : "unknown";
}

export type RateRule = { key: string; limit: number; windowMs: number };

/** Login keys (the side is part of every key): per ip+email and per ip only when the ip is known, always per email. */
export function loginRules(side: Side, ip: string, email: string): RateRule[] {
  const rules: RateRule[] = [];
  if (ip !== "unknown") rules.push({ key: `login:${side}:${ip}:${email}`, limit: 10, windowMs: 15 * 60_000 });
  rules.push({ key: `login-account:${side}:${email}`, limit: 30, windowMs: 15 * 60_000 });
  if (ip !== "unknown") rules.push({ key: `login-ip:${side}:${ip}`, limit: 100, windowMs: 15 * 60_000 });
  return rules;
}

/** Set-password keys: per ip only when the ip is known. */
export function setPasswordRules(ip: string): RateRule[] {
  return ip !== "unknown" ? [{ key: `set-password:${ip}`, limit: 20, windowMs: 15 * 60_000 }] : [];
}

/** Public quote approval keys: per ip only when the ip is known. */
export function approveQuoteRules(ip: string): RateRule[] {
  return ip !== "unknown" ? [{ key: `approve-quote:${ip}`, limit: 20, windowMs: 15 * 60_000 }] : [];
}

/** Payment link keys: per ip only when the ip is known. Each visit opens a checkout at the provider. */
export function payLinkRules(ip: string): RateRule[] {
  return ip !== "unknown" ? [{ key: `pay-link:${ip}`, limit: 30, windowMs: 15 * 60_000 }] : [];
}

/** Forgot-password keys: per ip only when known, always per email. */
export function forgotRules(side: Side, ip: string, email: string): { ip: RateRule[]; account: RateRule } {
  return {
    ip: ip !== "unknown" ? [{ key: `forgot:${side}:${ip}`, limit: 5, windowMs: 3600_000 }] : [],
    account: { key: `forgot-account:${side}:${email}`, limit: 3, windowMs: 3600_000 },
  };
}

/** Counts every rule (no short circuit); true only when all of them allow. */
export function passesAll(rules: RateRule[]): boolean {
  return rules.map((r) => rateLimit(r.key, r)).every(Boolean);
}

// Keeps the map from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 60_000).unref?.();
