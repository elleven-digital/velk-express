import { describe, expect, it } from "vitest";

describe("db client", () => {
  it("does not read config or connect on import", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(import("./client")).resolves.toBeDefined();
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});

describe("sslModeFor", () => {
  it("maps the URL sslmode without downgrading it", async () => {
    const { sslModeFor } = await import("./client");
    const u = (q: string) => `postgres://u@h:5432/d${q}`;
    expect(sslModeFor(u(""))).toBeNull();
    expect(sslModeFor(u("?sslmode=require"))).toBe("require");
    expect(sslModeFor(u("?sslmode=verify-full"))).toBe("verify-full");
    expect(sslModeFor(u("?sslmode=verify-ca"))).toBe("verify-ca");
    expect(sslModeFor(u("?sslmode=disable"))).toBeNull();
    expect(sslModeFor(u("?sslmode=prefer"))).toBeNull();
  });
});

describe("sslOptionFor", () => {
  it("never downgrades verification", async () => {
    const { sslOptionFor } = await import("./client");
    const u = (q: string) => `postgres://u@h:5432/d${q}`;
    expect(sslOptionFor(u(""))).toBe(false);
    expect(sslOptionFor(u("?sslmode=disable"))).toBe(false);
    expect(sslOptionFor(u("?sslmode=require"))).toBe("require");
    expect(sslOptionFor(u("?sslmode=verify-full"))).toBe("verify-full");
    expect(sslOptionFor(u("?sslmode=verify-ca"))).toEqual({ rejectUnauthorized: true });
  });
});
