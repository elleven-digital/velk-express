import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Storage } from "@/lib/storage/types";
import { backupDatabase, type Runner } from "./backup";
import { BootError } from "./instance";

const url = "postgres://velk:s3cret@db.example:5432/velk";

const okRunner: Runner = async (_cmd, args) => {
  const file = args.find((a) => a.startsWith("--file="))!.slice("--file=".length);
  await writeFile(file, "dump");
  return { code: 0, stderr: "" };
};

describe("backupDatabase", () => {
  it("passes the password through PGPASSWORD, never on the command line", async () => {
    let seen: { args: string[]; env?: Record<string, string> } | undefined;
    const run: Runner = async (cmd, args, env) => {
      seen = { args, env };
      return okRunner(cmd, args, env);
    };
    await backupDatabase(url, { dir: await mkdtemp(path.join(os.tmpdir(), "velk-bk-")) }, run);
    expect(seen!.args.join(" ")).not.toContain("s3cret");
    expect(seen!.args).toContain("--dbname=postgres://velk@db.example:5432/velk");
    expect(seen!.env?.PGPASSWORD).toBe("s3cret");
  });

  it("creates the dump file with mode 0600", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "velk-bk-"));
    const file = await backupDatabase(url, { dir }, okRunner);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("removes the partial file when pg_dump fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "velk-bk-"));
    const run: Runner = async (_cmd, args) => {
      await writeFile(args.find((a) => a.startsWith("--file="))!.slice("--file=".length), "partial");
      return { code: 1, stderr: "boom" };
    };
    await expect(backupDatabase(url, { dir }, run)).rejects.toBeInstanceOf(BootError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("writes a .dump file into a directory target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "velk-bk-"));
    const file = await backupDatabase(url, { dir: path.join(dir, "backups") }, okRunner);
    expect(file).toMatch(/pre-migration-.*\.dump$/);
    expect(await readdir(path.join(dir, "backups"))).toHaveLength(1);
  });

  it("uploads to a storage target under backups/", async () => {
    const puts: { key: string; body: string; maxBytes: number }[] = [];
    const storage = {
      // The dump is streamed, never loaded as a whole: putStream is the only write the backup may use.
      putStream: async (key: string, body: Readable, _type: string, opts: { maxBytes: number }) => {
        const chunks: Buffer[] = [];
        for await (const c of body) chunks.push(Buffer.from(c));
        puts.push({ key, body: Buffer.concat(chunks).toString(), maxBytes: opts.maxBytes });
        return { size: 4 };
      },
    } as unknown as Storage;
    const key = await backupDatabase(url, { storage }, okRunner);
    expect(key).toMatch(/^backups\/pre-migration-.*\.dump$/);
    expect(puts).toEqual([{ key, body: "dump", maxBytes: Number.MAX_SAFE_INTEGER }]);
  });

  it("throws a BootError without the password when pg_dump fails", async () => {
    const run: Runner = async () => ({ code: 1, stderr: `connection to ${url} failed` });
    const err = await backupDatabase(url, { dir: os.tmpdir() }, run).catch((e) => e);
    expect(err).toBeInstanceOf(BootError);
    expect(err.message).not.toContain("s3cret");
  });

  it("throws a BootError when pg_dump cannot be spawned", async () => {
    const run: Runner = async () => {
      throw new Error("spawn pg_dump ENOENT");
    };
    const err = await backupDatabase(url, { dir: os.tmpdir() }, run).catch((e) => e);
    expect(err).toBeInstanceOf(BootError);
    expect(err.message).toContain("pg_dump");
  });
});
