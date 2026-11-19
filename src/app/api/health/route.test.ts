import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ db: { execute: (...args: unknown[]) => execute(...args) } }));

import { GET } from "./route";

beforeEach(() => {
  execute.mockReset();
});

describe("GET /api/health", () => {
  it("answers 200 { ok: true } when the database responds", async () => {
    execute.mockImplementation(async () => [{ "?column?": 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers 503 { ok: false } when the database throws", async () => {
    execute.mockImplementation(async () => {
      throw new Error("connection refused");
    });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("answers 503 when the database does not answer in time", async () => {
    vi.useFakeTimers();
    execute.mockReturnValue(new Promise(() => {}));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(503);
  });
});
