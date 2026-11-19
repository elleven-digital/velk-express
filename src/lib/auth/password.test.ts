import { describe, expect, it } from "vitest";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordProblem } from "./password";

describe("passwordProblem", () => {
  it("accepts a password inside the limits", () => {
    expect(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem("a".repeat(MAX_PASSWORD_BYTES))).toBeNull();
  });

  it("rejects short passwords", () => {
    expect(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe("tooShort");
    expect(passwordProblem("")).toBe("tooShort");
  });

  it("rejects passwords over 72 bytes, counting bytes and not characters", () => {
    expect(passwordProblem("a".repeat(MAX_PASSWORD_BYTES + 1))).toBe("tooLong");
    // 40 characters but 80 bytes
    expect(passwordProblem("é".repeat(40))).toBe("tooLong");
  });
});
