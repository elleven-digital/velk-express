import { describe, expect, it } from "vitest";
import { pickNext } from "./assignments";

describe("pickNext", () => {
  it("returns null when nobody is in the rotation", () => {
    expect(pickNext([], null)).toBeNull();
    expect(pickNext([], "a")).toBeNull();
  });

  it("starts with the first candidate", () => {
    expect(pickNext(["a", "b", "c"], null)).toBe("a");
  });

  it("moves on to the one after the last", () => {
    expect(pickNext(["a", "b", "c"], "a")).toBe("b");
    expect(pickNext(["a", "b", "c"], "b")).toBe("c");
  });

  it("wraps around after the last candidate", () => {
    expect(pickNext(["a", "b", "c"], "c")).toBe("a");
  });

  it("starts over when the last one is no longer a candidate", () => {
    expect(pickNext(["a", "b", "c"], "zz")).toBe("a");
  });
});
