import { describe, expect, it } from "vitest";
import { canDeliverResetMail } from "./reset-policy";

describe("canDeliverResetMail", () => {
  it("is false without SMTP, so /forgot never cancels a link the owner copied", () => {
    expect(canDeliverResetMail(null)).toBe(false);
  });
  it("is true when SMTP is configured", () => {
    expect(canDeliverResetMail({ host: "smtp.x.com", port: 587, user: null, pass: null, from: "a@x.com" })).toBe(true);
  });
});
