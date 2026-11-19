import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyTestDb, resetTestDb } from "./db";

describe("test database guard", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([resetTestDb, emptyTestDb])("refuses a database whose name does not end in _test", async (fn) => {
    vi.stubEnv("TEST_DATABASE_URL", "postgres://velk@localhost:54330/velk");
    await expect(fn()).rejects.toThrow(/_test/);
  });

  it("refuses an unparsable URL", async () => {
    vi.stubEnv("TEST_DATABASE_URL", "not a url");
    await expect(resetTestDb()).rejects.toThrow(/_test/);
  });
});
