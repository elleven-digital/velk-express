import { BootError } from "./instance";

export type WaitOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock in ms; injectable for tests. */
  now?: () => number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retries `probe` until it resolves, or throws a BootError once `timeoutMs` of wall-clock time
 * has passed since the first attempt (slow probes count, not just the sleeps between them).
 */
export async function waitForDb(probe: () => Promise<void>, opts: WaitOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      await probe();
      return;
    } catch {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new BootError(`Could not reach the database after ${Math.round(timeoutMs / 1000)}s. Check DATABASE_URL and that the database is running.`);
      }
      await sleep(Math.min(intervalMs, remaining));
    }
  }
}
