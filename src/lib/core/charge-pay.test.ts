import { describe, expect, it } from "vitest";
import { payDoneState, returnUrls } from "./charge-pay";

describe("returnUrls", () => {
  it("a charge's return URLs end in /done?r=ok and /done?r=cancel", () => {
    const { successUrl, cancelUrl } = returnUrls("https://app.example.com", "tok", null);
    expect(successUrl).toBe("https://app.example.com/pay/tok/done?r=ok");
    expect(cancelUrl).toBe("https://app.example.com/pay/tok/done?r=cancel");
  });

  it("a quote's charge returns to the public quote", () => {
    expect(returnUrls("https://app.example.com", "tok", "q1")).toEqual({
      successUrl: "https://app.example.com/q/q1",
      cancelUrl: "https://app.example.com/q/q1",
    });
  });
});

describe("payDoneState", () => {
  it("r=ok reports the payment as received, whatever the provider appends", () => {
    expect(payDoneState("pending", { r: "ok", status: ["approved", "x"] })).toBe("received");
    expect(payDoneState("pending", { r: ["ok", "cancel"] })).toBe("received");
  });

  it("r=cancel reports the payment as not completed", () => {
    expect(payDoneState("pending", { r: "cancel", status: "approved" })).toBe("notCompleted");
  });

  it("without a known r it shows the neutral state, and the provider's status is ignored", () => {
    expect(payDoneState("pending", {})).toBe("notCompleted");
    expect(payDoneState("pending", { status: "success" })).toBe("notCompleted");
    expect(payDoneState("pending", { r: "yes" })).toBe("notCompleted");
    expect(payDoneState("pending", { r: [] })).toBe("notCompleted");
  });

  it("the charge's own state wins over the return parameter", () => {
    expect(payDoneState("paid", { r: "cancel" })).toBe("confirmed");
    expect(payDoneState("active", {})).toBe("confirmed");
    expect(payDoneState("canceled", { r: "ok" })).toBe("canceled");
  });
});
