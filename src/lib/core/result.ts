export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

export function ok(): Result<void>;
export function ok<T>(value: T): Result<T>;
export function ok<T>(value?: T): Result<T | undefined> {
  return { ok: true, value };
}

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
