import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskStorage } from "./disk";
import { TooLargeError } from "./types";

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "velk-storage-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("diskStorage", () => {
  it("round-trips bytes, content type and size", async () => {
    const s = diskStorage(root);
    const body = Buffer.from([0, 1, 2, 250, 255]);
    await s.put("logos/2026/11/abc", body, "image/png");
    const got = await s.get("logos/2026/11/abc");
    expect(got).not.toBeNull();
    expect(await read(got!.stream)).toEqual(body);
    expect(got!.contentType).toBe("image/png");
    expect(got!.size).toBe(5);
  });

  it("returns null for a missing key", async () => {
    expect(await diskStorage(root).get("logos/none")).toBeNull();
  });

  it("remove is idempotent and deletes the sidecar", async () => {
    const s = diskStorage(root);
    await s.put("a/b", Buffer.from("x"), "text/plain");
    await s.remove("a/b");
    await expect(s.remove("a/b")).resolves.toBeUndefined();
    expect(await s.get("a/b")).toBeNull();
    expect(await readdir(path.join(root, "a"))).toEqual([]);
  });

  it("overwrites an existing key and leaves no temp files", async () => {
    const s = diskStorage(root);
    await s.put("a/b", Buffer.from("one"), "text/plain");
    await s.put("a/b", Buffer.from("two"), "text/html");
    const got = await s.get("a/b");
    expect((await read(got!.stream)).toString()).toBe("two");
    expect(got!.contentType).toBe("text/html");
    expect((await readdir(path.join(root, "a"))).sort()).toEqual(["b", "b.meta.json"]);
  });

  it("accepts ISO timestamps in keys", async () => {
    const s = diskStorage(root);
    const key = "exports/report-2026-11-18T10:00:00.000Z.csv";
    await s.put(key, Buffer.from("d"), "application/octet-stream");
    expect(await s.get(key)).not.toBeNull();
  });

  it("rejects keys that escape the root", async () => {
    const s = diskStorage(root);
    await expect(s.put("../../escape", Buffer.from("x"), "text/plain")).rejects.toThrow();
    await expect(s.get("../x")).rejects.toThrow();
    await expect(s.remove("/etc/passwd")).rejects.toThrow();
  });

  describe("putStream", () => {
    function chunks(total: number, size = 64 * 1024): Readable {
      let sent = 0;
      return Readable.from(
        (async function* () {
          while (sent < total) {
            const n = Math.min(size, total - sent);
            sent += n;
            yield Buffer.alloc(n, 7);
          }
        })(),
      );
    }

    it("stores the bytes and the content type and returns the size", async () => {
      const s = diskStorage(root);
      const res = await s.putStream("attachments/2026/11/x", chunks(200_000), "application/pdf", { maxBytes: 1_000_000 });
      expect(res).toEqual({ size: 200_000 });
      const got = await s.get("attachments/2026/11/x");
      expect(got!.contentType).toBe("application/pdf");
      expect(got!.size).toBe(200_000);
      expect((await read(got!.stream)).equals(Buffer.alloc(200_000, 7))).toBe(true);
      expect((await readdir(path.join(root, "attachments/2026/11"))).sort()).toEqual(["x", "x.meta.json"]);
    });

    it("rejects with TooLargeError past maxBytes and leaves nothing behind", async () => {
      const s = diskStorage(root);
      await expect(
        s.putStream("attachments/2026/11/big", chunks(300_000), "application/pdf", { maxBytes: 100_000 }),
      ).rejects.toBeInstanceOf(TooLargeError);
      expect(await s.get("attachments/2026/11/big")).toBeNull();
      expect(await readdir(path.join(root, "attachments/2026/11"))).toEqual([]);
    });

    it("accepts a body of exactly maxBytes", async () => {
      const s = diskStorage(root);
      await expect(s.putStream("a/b", chunks(100_000), "text/plain", { maxBytes: 100_000 })).resolves.toEqual({ size: 100_000 });
    });

    it("leaves nothing behind when the source stream fails", async () => {
      const s = diskStorage(root);
      const broken = new Readable({
        read() {
          this.push(Buffer.from("abc"));
          this.destroy(new Error("boom"));
        },
      });
      await expect(s.putStream("a/b", broken, "text/plain", { maxBytes: 100 })).rejects.toThrow();
      expect(await readdir(path.join(root, "a"))).toEqual([]);
    });
  });
});
