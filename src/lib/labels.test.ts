import { describe, expect, it } from "vitest";
import { cleanLabelName, DEFAULT_LABEL_COLOR, labelColorOf, LABEL_NAME_MAX, parseLabelColor } from "./labels";

describe("parseLabelColor", () => {
  it("normalizes hex to lowercase #rrggbb", () => {
    expect(parseLabelColor("#0A72EF")).toBe("#0a72ef");
    expect(parseLabelColor("0a72ef")).toBe("#0a72ef");
    expect(parseLabelColor("#abc")).toBe("#aabbcc");
  });
  it("accepts a preset key", () => {
    expect(parseLabelColor("blue")).toBe("#0a72ef");
  });
  it("rejects anything else", () => {
    expect(parseLabelColor("red;")).toBeNull();
    expect(parseLabelColor("#12345")).toBeNull();
    expect(parseLabelColor("")).toBeNull();
  });
});

describe("labelColorOf", () => {
  it("falls back to gray", () => {
    expect(labelColorOf(null)).toBe(DEFAULT_LABEL_COLOR);
    expect(labelColorOf("nope")).toBe(DEFAULT_LABEL_COLOR);
    expect(labelColorOf("#E5484D")).toBe("#e5484d");
  });
});

describe("cleanLabelName", () => {
  it("collapses spaces and trims", () => {
    expect(cleanLabelName("  Aguardando   cliente ")).toBe("Aguardando cliente");
  });
  it("cuts to the maximum", () => {
    expect(cleanLabelName("x".repeat(60))).toHaveLength(LABEL_NAME_MAX);
  });
});
