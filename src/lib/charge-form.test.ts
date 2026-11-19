import { describe, expect, it } from "vitest";
import { parseChargeForm } from "./charge-form";

const CLIENT = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const form = (over: Record<string, string> = {}) => ({
  clientId: CLIENT,
  label: "  Logo design  ",
  amount: "1.250,50",
  kind: "one_time",
  provider: "manual",
  ...over,
});

describe("parseChargeForm", () => {
  it("reads the free charge form: trimmed label, money as cents, manual as no provider", () => {
    expect(parseChargeForm(form())).toEqual({
      ok: true,
      value: { clientId: CLIENT, label: "Logo design", amountCents: 125050, kind: "one_time", provider: null },
    });
    expect(parseChargeForm(form({ kind: "subscription", provider: "stripe", amount: "99" }))).toEqual({
      ok: true,
      value: { clientId: CLIENT, label: "Logo design", amountCents: 9900, kind: "subscription", provider: "stripe" },
    });
    expect(parseChargeForm(form({ provider: "mercadopago" }))).toMatchObject({ ok: true, value: { provider: "mercadopago" } });
  });

  it("asks for a client and a label", () => {
    expect(parseChargeForm(form({ clientId: "" }))).toEqual({ ok: false, error: "required" });
    expect(parseChargeForm(form({ clientId: "nope" }))).toEqual({ ok: false, error: "required" });
    expect(parseChargeForm(form({ label: "   " }))).toEqual({ ok: false, error: "required" });
  });

  it("refuses amounts that are not money or not above zero", () => {
    for (const amount of ["", "abc", "0", "0,00", "-5", "1e3"]) {
      expect(parseChargeForm(form({ amount }))).toEqual({ ok: false, error: "invalidAmount" });
    }
    expect(parseChargeForm(form({ amount: "99999999999" }))).toEqual({ ok: false, error: "invalidAmount" });
  });

  it("refuses an unknown kind or provider", () => {
    expect(parseChargeForm(form({ kind: "weekly" }))).toEqual({ ok: false, error: "required" });
    expect(parseChargeForm(form({ provider: "paypal" }))).toEqual({ ok: false, error: "providerUnavailable" });
    expect(parseChargeForm(form({ provider: "" }))).toEqual({ ok: false, error: "providerUnavailable" });
  });
});
