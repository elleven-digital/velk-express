import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Storage } from "@/lib/storage/types";
import { BootError } from "./instance";

export type RunResult = { code: number | null; stderr: string };
/** `env` holds extra variables for the child process, on top of the inherited environment. */
export type Runner = (command: string, args: string[], env?: Record<string, string>) => Promise<RunResult>;

/** Runs a process and collects stderr. Rejects when it cannot be spawned (e.g. ENOENT). */
export const spawnRunner: Runner = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });

/** Removes the connection URL and its password from text that may be shown to the operator. */
export function scrub(text: string, databaseUrl: string): string {
  let out = text.split(databaseUrl).join("<database url>");
  try {
    const password = decodeURIComponent(new URL(databaseUrl).password);
    if (password) out = out.split(password).join("***");
  } catch {
    // an unparsable URL has nothing more to scrub
  }
  return out.trim();
}

/** Splits the URL into one without the password (safe for the command line) and the password itself. */
function splitPassword(databaseUrl: string): { url: string; password: string | null } {
  try {
    const u = new URL(databaseUrl);
    const password = decodeURIComponent(u.password);
    u.password = "";
    return { url: u.toString(), password: password || null };
  } catch {
    return { url: databaseUrl, password: null };
  }
}

async function dumpTo(file: string, databaseUrl: string, run: Runner): Promise<void> {
  // The dump holds the whole database: create the file private before pg_dump writes into it.
  try {
    await (await open(file, "wx", 0o600)).close();
  } catch (err) {
    throw new BootError(`Cannot create the backup file ${file}: ${(err as Error).message}`);
  }
  try {
    const { url, password } = splitPassword(databaseUrl);
    let result: RunResult;
    try {
      result = await run(
        "pg_dump",
        ["--format=custom", "--no-owner", `--dbname=${url}`, `--file=${file}`],
        password ? { PGPASSWORD: password } : undefined,
      );
    } catch (err) {
      const reason = scrub(err instanceof Error ? err.message : String(err), databaseUrl);
      throw new BootError(`Could not run pg_dump for the pre-migration backup (${reason}). Install the PostgreSQL client tools or set SKIP_PRE_MIGRATION_BACKUP=true.`);
    }
    if (result.code !== 0) {
      throw new BootError(`pg_dump failed with exit code ${result.code}: ${scrub(result.stderr, databaseUrl)}`);
    }
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
}

/**
 * Dumps the database with pg_dump (custom format). Returns the file path for a
 * directory target, or the storage key for a storage target.
 */
export async function backupDatabase(
  databaseUrl: string,
  target: { dir: string } | { storage: Storage },
  run: Runner = spawnRunner,
): Promise<string> {
  const name = `pre-migration-${new Date().toISOString().replace(/:/g, "-")}.dump`;

  if ("dir" in target) {
    try {
      await mkdir(target.dir, { recursive: true });
    } catch (err) {
      throw new BootError(`Cannot create the backup directory ${target.dir}: ${(err as Error).message}`);
    }
    const file = path.join(target.dir, name);
    await dumpTo(file, databaseUrl, run);
    return file;
  }

  const tmp = path.join(os.tmpdir(), `velk-${process.pid}-${name}`);
  const key = `backups/${name}`;
  try {
    await dumpTo(tmp, databaseUrl, run);
    await target.storage.putStream(key, createReadStream(tmp), "application/octet-stream", {
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
  } catch (err) {
    if (err instanceof BootError) throw err;
    throw new BootError(`Could not upload the backup to storage: ${(err as Error).message}`);
  } finally {
    await rm(tmp, { force: true });
  }
  return key;
}
