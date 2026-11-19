import type { Db } from "@/lib/db";
import { fail, ok, type Result } from "./result";

/** Thrown inside a transaction to roll it back with a known error. */
export class Abort extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Runs `work` in a transaction; an Abort rolls everything back and becomes a failed Result. */
export async function transact<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await db.transaction((tx) => work(tx as unknown as Db)));
  } catch (err) {
    if (err instanceof Abort) return fail(err.code);
    throw err;
  }
}
