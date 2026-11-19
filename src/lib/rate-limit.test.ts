import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveQuoteRules, clientIp, forgotRules, loginRules, passesAll, payLinkRules, rateLimit, setPasswordRules } from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the limit, refuses the next call, allows again after the window", () => {
    const opts = { limit: 10, windowMs: 15 * 60_000 };
    for (let i = 0; i < 10; i++) expect(rateLimit("login:1.1.1.1:a@x.com", opts)).toBe(true);
    expect(rateLimit("login:1.1.1.1:a@x.com", opts)).toBe(false);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(rateLimit("login:1.1.1.1:a@x.com", opts)).toBe(true);
  });

  it("counts each key on its own", () => {
    const opts = { limit: 1, windowMs: 1000 };
    expect(rateLimit("k1", opts)).toBe(true);
    expect(rateLimit("k1", opts)).toBe(false);
    expect(rateLimit("k2", opts)).toBe(true);
  });
});

describe("clientIp", () => {
  it("takes the last x-forwarded-for value, the one the nearest proxy added", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("2.2.2.2");
    expect(clientIp(new Headers({ "x-forwarded-for": " 203.0.113.9 " }))).toBe("203.0.113.9");
  });

  it("falls back to unknown", () => {
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": " , " }))).toBe("unknown");
  });
});

describe("key policy", () => {
  it("login uses the ip key only when the ip is known, and always the account key", () => {
    expect(loginRules("team", "9.9.9.9", "a@x.com")).toEqual([
      { key: "login:team:9.9.9.9:a@x.com", limit: 10, windowMs: 15 * 60_000 },
      { key: "login-account:team:a@x.com", limit: 30, windowMs: 15 * 60_000 },
      { key: "login-ip:team:9.9.9.9", limit: 100, windowMs: 15 * 60_000 },
    ]);
    expect(loginRules("team", "unknown", "a@x.com")).toEqual([
      { key: "login-account:team:a@x.com", limit: 30, windowMs: 15 * 60_000 },
    ]);
  });

  it("forgot uses the ip key only when the ip is known, and always the account key", () => {
    expect(forgotRules("team", "9.9.9.9", "a@x.com")).toEqual({
      ip: [{ key: "forgot:team:9.9.9.9", limit: 5, windowMs: 3600_000 }],
      account: { key: "forgot-account:team:a@x.com", limit: 3, windowMs: 3600_000 },
    });
    expect(forgotRules("team", "unknown", "a@x.com").ip).toEqual([]);
  });

  it("set-password uses the ip key only when the ip is known", () => {
    expect(setPasswordRules("9.9.9.9")).toEqual([{ key: "set-password:9.9.9.9", limit: 20, windowMs: 15 * 60_000 }]);
    expect(setPasswordRules("unknown")).toEqual([]);
  });

  it("quote approval uses the ip key only when the ip is known", () => {
    expect(approveQuoteRules("9.9.9.9")).toEqual([{ key: "approve-quote:9.9.9.9", limit: 20, windowMs: 15 * 60_000 }]);
    expect(approveQuoteRules("unknown")).toEqual([]);
    expect(payLinkRules("9.9.9.9")).toEqual([{ key: "pay-link:9.9.9.9", limit: 30, windowMs: 15 * 60_000 }]);
    expect(payLinkRules("unknown")).toEqual([]);
  });

  it("keys carry the side, with the same limits", () => {
    const strip = (rules: { limit: number; windowMs: number }[]) => rules.map(({ limit, windowMs }) => ({ limit, windowMs }));
    const team = loginRules("team", "9.9.9.9", "a@x.com");
    const portal = loginRules("portal", "9.9.9.9", "a@x.com");
    expect(portal.map((r) => r.key)).toEqual([
      "login:portal:9.9.9.9:a@x.com",
      "login-account:portal:a@x.com",
      "login-ip:portal:9.9.9.9",
    ]);
    expect(strip(portal)).toEqual(strip(team));
    const ft = forgotRules("team", "9.9.9.9", "a@x.com");
    const fp = forgotRules("portal", "9.9.9.9", "a@x.com");
    expect(fp.ip[0].key).toBe("forgot:portal:9.9.9.9");
    expect(fp.account.key).toBe("forgot-account:portal:a@x.com");
    expect(strip(fp.ip)).toEqual(strip(ft.ip));
    expect(fp.account.limit).toBe(ft.account.limit);
    expect(fp.account.windowMs).toBe(ft.account.windowMs);
  });

  it("exhausting the team login does not block the portal login for the same ip and email", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) expect(passesAll(loginRules("team", "7.7.7.7", "b@x.com"))).toBe(true);
    expect(passesAll(loginRules("team", "7.7.7.7", "b@x.com"))).toBe(false);
    expect(passesAll(loginRules("portal", "7.7.7.7", "b@x.com"))).toBe(true);
    vi.useRealTimers();
  });

  it("passesAll needs every rule to allow", () => {
    vi.useFakeTimers();
    const rules = [
      { key: "p1", limit: 1, windowMs: 1000 },
      { key: "p2", limit: 5, windowMs: 1000 },
    ];
    expect(passesAll(rules)).toBe(true);
    expect(passesAll(rules)).toBe(false);
    vi.useRealTimers();
  });
});
