import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../config";
import { diskStorage } from "./disk";
import { s3BucketReachable, s3Storage } from "./s3";
import type { Storage } from "./types";

export { TooLargeError, type Storage } from "./types";
export { assertSafeKey, newFileKey } from "./keys";
export { diskStorage } from "./disk";
export { s3Storage } from "./s3";

let cached: Storage | null = null;

function diskRoot(dataDir: string): string {
  return path.join(dataDir, "files");
}

/** The disk root when files live on disk (not S3), else null. */
export function storageDiskRoot(): string | null {
  const { s3, dataDir } = getConfig();
  return s3 ? null : diskRoot(dataDir);
}

export function getStorage(): Storage {
  if (!cached) {
    const { s3, dataDir } = getConfig();
    cached = s3 ? s3Storage(s3) : diskStorage(diskRoot(dataDir));
  }
  return cached;
}

export async function storageStatus(): Promise<{ mode: "disk" | "s3"; writable: boolean }> {
  try {
    const { s3, dataDir } = getConfig();
    if (s3) return { mode: "s3", writable: await s3BucketReachable(s3) };
    const root = diskRoot(dataDir);
    try {
      await mkdir(root, { recursive: true });
      await access(root, constants.W_OK);
      return { mode: "disk", writable: true };
    } catch {
      return { mode: "disk", writable: false };
    }
  } catch {
    return { mode: "disk", writable: false };
  }
}
