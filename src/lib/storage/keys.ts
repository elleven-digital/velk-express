import { nanoid } from "nanoid";

export function newFileKey(prefix: "logos" | "attachments" | "documents" | "backups"): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${prefix}/${yyyy}/${mm}/${nanoid(21)}`;
}

/** Rejects empty keys, leading "/", backslashes, empty segments and "." / ".." segments. */
export function assertSafeKey(key: string): void {
  if (key === "" || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
  for (const segment of key.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
    }
  }
}
