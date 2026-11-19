import { describe, expect, it } from "vitest";
import { unsentText } from "./unsent";

describe("unsentText", () => {
  it("returns the refused message as plain text, one block per line", () => {
    expect(unsentText({ body: "<p>First &amp; foremost</p><p>Second</p>" })).toBe("First & foremost\nSecond");
  });

  it("never lets markup through", () => {
    const text = unsentText({ body: '<p>hi</p><script>alert(1)</script><img src="x" onerror="alert(2)">' });
    expect(text).not.toMatch(/<|onerror/);
    expect(text).toContain("hi");
  });

  it("is undefined when there is nothing to show", () => {
    expect(unsentText(undefined)).toBeUndefined();
    expect(unsentText({})).toBeUndefined();
    expect(unsentText({ body: "<p></p>" })).toBeUndefined();
  });
});
