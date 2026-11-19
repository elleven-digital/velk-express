import { describe, expect, it } from "vitest";
import { migrationFailureMessage } from "./migrations";

const url = "postgres://velk:s3cret@db.example:5432/velk";

describe("migrationFailureMessage", () => {
  it("includes the backup location", () => {
    const msg = migrationFailureMessage(new Error("syntax error"), url, { location: "/data/backups/x.dump" });
    expect(msg).toBe("Migration failed: syntax error. A backup taken before the migration is at /data/backups/x.dump.");
  });
  it("says explicitly when no backup was taken", () => {
    expect(migrationFailureMessage(new Error("boom"), url, { none: "empty database" })).toContain("No backup was taken (empty database).");
    expect(migrationFailureMessage("boom", url, { none: "SKIP_PRE_MIGRATION_BACKUP=true" })).toContain("(SKIP_PRE_MIGRATION_BACKUP=true)");
  });
  it("never leaks the password", () => {
    const msg = migrationFailureMessage(new Error(`could not connect to ${url} (password s3cret)`), url, { none: "empty database" });
    expect(msg).not.toContain("s3cret");
  });
});
