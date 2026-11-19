import { describe, expect, it } from "vitest";
import { migrationFailureMessage } from "./migrations";

const url = "postgres://velk:s3cret@db.example:5432/velk";

describe("migrationFailureMessage", () => {
  it("says the database was left unchanged", () => {
    expect(migrationFailureMessage(new Error("syntax error"), url)).toBe(
      "Migration failed: syntax error. The database was left unchanged; go back to the previous version and report the error.",
    );
  });
  it("shows the database error that drizzle wraps", () => {
    const wrapped = new Error("Failed query: ALTER TABLE x\nparams:", { cause: new Error('column "y" already exists') });
    expect(migrationFailureMessage(wrapped, url)).toContain('Migration failed: column "y" already exists.');
  });
  it("never leaks the password or the URL", () => {
    const msg = migrationFailureMessage(new Error(`could not connect to ${url} (password s3cret)`), url);
    expect(msg).not.toContain("s3cret");
    expect(msg).toContain("<database url>");
  });
});
