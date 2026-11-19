import { Transform, type Readable } from "node:stream";

/** Thrown by putStream when the body is longer than the allowed maximum. */
export class TooLargeError extends Error {
  constructor(message = "Body exceeds the maximum size") {
    super(message);
    this.name = "TooLargeError";
  }
}

export interface Storage {
  /** Whole-buffer write, for small files (the logo). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * Streams body to key without holding it in memory. Past maxBytes it rejects
   * with TooLargeError and leaves nothing behind (no object, no partial upload).
   */
  putStream(
    key: string,
    body: Readable,
    contentType: string,
    opts: { maxBytes: number },
  ): Promise<{ size: number }>;
  /** Resolves to null when the key does not exist. */
  get(
    key: string,
  ): Promise<{ stream: Readable; contentType: string | null; size: number | null } | null>;
  /** Does not throw when the key does not exist. */
  remove(key: string): Promise<void>;
}

/** A Transform that counts bytes and fails with TooLargeError past the limit. */
export function byteLimiter(maxBytes: number): Transform & { bytes: () => number } {
  let total = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) return cb(new TooLargeError());
      cb(null, chunk);
    },
  });
  return Object.assign(t, { bytes: () => total });
}
