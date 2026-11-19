import { describe, expect, it } from "vitest";
import { BootError } from "./instance";
import { waitForDb } from "./wait-for-db";

describe("waitForDb", () => {
  it("resolves once the probe succeeds", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      if (calls <= 3) throw new Error("not ready");
    };
    await waitForDb(probe, { sleep: async () => {} });
    expect(calls).toBe(4);
  });

  it("rejects with a BootError after the timeout", async () => {
    const probe = async () => {
      throw new Error("down");
    };
    let clock = 0;
    const err = await waitForDb(probe, {
      timeoutMs: 6000,
      intervalMs: 2000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BootError);
    expect(err.message).toContain("database");
  });

  it("stops at the wall-clock deadline even when every probe is slow", async () => {
    let clock = 0;
    let calls = 0;
    const probe = async () => {
      calls += 1;
      clock += 30_000; // a blackholed host: each attempt burns its connect timeout
      throw new Error("timeout");
    };
    const err = await waitForDb(probe, {
      timeoutMs: 60_000,
      intervalMs: 2_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BootError);
    expect(calls).toBe(2);
    expect(clock).toBeLessThanOrEqual(62_000);
  });
});
