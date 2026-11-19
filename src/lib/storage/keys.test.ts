import { describe, expect, it } from "vitest";
import { assertSafeKey, newFileKey } from "./keys";

describe("newFileKey", () => {
  it("builds prefix/yyyy/mm/nanoid", () => {
    expect(newFileKey("logos")).toMatch(/^logos\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{21}$/);
    expect(newFileKey("backups")).toMatch(/^backups\//);
  });
});

describe("assertSafeKey", () => {
  it.each(["../x", "a/../b", "/x", "a\\b", "a//b", "", "a/", "."])("rejects %j", (k) => {
    expect(() => assertSafeKey(k)).toThrow();
  });

  it("accepts regular keys, including ISO timestamps", () => {
    expect(() => assertSafeKey("logos/2026/11/abc")).not.toThrow();
    expect(() => assertSafeKey("backups/pre-migration-2026-11-18T10:00:00.000Z.dump")).not.toThrow();
  });
});
