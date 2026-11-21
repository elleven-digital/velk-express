import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path";

describe("safeReturnPath", () => {
  it("keeps an internal path with its query", () => {
    expect(safeReturnPath("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
    expect(safeReturnPath("/admin")).toBe("/admin");
  });

  it("refuses anything that could leave the site", () => {
    for (const raw of ["//evil.test", "https://evil.test", "/\\evil", "\\\\evil", "evil.test", "", null, undefined]) {
      expect(safeReturnPath(raw)).toBeNull();
    }
  });

  it("refuses control characters, which browsers strip (/\\t/evil.test becomes //evil.test)", () => {
    expect(safeReturnPath("/\t/evil.test")).toBeNull();
    expect(safeReturnPath("/\n/evil.test")).toBeNull();
    expect(safeReturnPath("/ok\u0000")).toBeNull();
  });
});
