import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { assertSafeKey } from "./keys";
import { byteLimiter, type Storage } from "./types";

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.${nanoid(8)}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export function diskStorage(root: string): Storage {
  const base = path.resolve(root);

  function resolveKey(key: string): string {
    assertSafeKey(key);
    const file = path.resolve(base, key);
    if (!file.startsWith(base + path.sep)) {
      throw new Error(`Storage key escapes the root: ${JSON.stringify(key)}`);
    }
    return file;
  }

  return {
    async put(key, body, contentType) {
      const file = resolveKey(key);
      await mkdir(path.dirname(file), { recursive: true });
      // Metadata first: a crash in between leaves no file without a content type.
      await writeAtomic(`${file}.meta.json`, JSON.stringify({ contentType }));
      await writeAtomic(file, body);
    },

    async putStream(key, body, contentType, { maxBytes }) {
      const file = resolveKey(key);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${nanoid(8)}.tmp`;
      const limiter = byteLimiter(maxBytes);
      try {
        await pipeline(body, limiter, createWriteStream(tmp));
        await writeAtomic(`${file}.meta.json`, JSON.stringify({ contentType }));
        await rename(tmp, file);
      } catch (err) {
        body.destroy();
        await rm(tmp, { force: true });
        await rm(`${file}.meta.json`, { force: true });
        throw err;
      }
      return { size: limiter.bytes() };
    },

    async get(key) {
      const file = resolveKey(key);
      let size: number;
      try {
        const info = await stat(file);
        if (!info.isFile()) return null;
        size = info.size;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      let contentType: string | null = null;
      try {
        const meta = JSON.parse(await readFile(`${file}.meta.json`, "utf8"));
        if (typeof meta?.contentType === "string") contentType = meta.contentType;
      } catch {
        // Missing or unreadable sidecar: serve the file without a content type.
      }
      return { stream: createReadStream(file), contentType, size };
    },

    async remove(key) {
      const file = resolveKey(key);
      await rm(file, { force: true });
      await rm(`${file}.meta.json`, { force: true });
    },
  };
}
