import { describe, expect, it } from "vitest";
import { readConfig } from "@/lib/config";
import { getProviders, providerFor } from "./index";

const base = { DATABASE_URL: "postgres://localhost/x" };
const keys = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  MERCADOPAGO_ACCESS_TOKEN: "TEST-x",
  MERCADOPAGO_WEBHOOK_SECRET: "mp-x",
};

describe("payment providers", () => {
  it("no keys, no providers", () => {
    const none = readConfig(base);
    expect(getProviders(none)).toEqual([]);
    expect(providerFor("stripe", none)).toBeNull();
    expect(providerFor("mercadopago", none)).toBeNull();

    // Half a pair of keys disables that provider.
    const half = readConfig({ ...base, STRIPE_SECRET_KEY: "sk_test_x", MERCADOPAGO_ACCESS_TOKEN: "TEST-x" });
    expect(getProviders(half)).toEqual([]);

    const both = readConfig({ ...base, ...keys });
    expect(getProviders(both).map((p) => p.name)).toEqual(["stripe", "mercadopago"]);
    expect(providerFor("mercadopago", both)?.name).toBe("mercadopago");

    const stripeOnly = readConfig({ ...base, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" });
    expect(getProviders(stripeOnly).map((p) => p.name)).toEqual(["stripe"]);
    expect(providerFor("mercadopago", stripeOnly)).toBeNull();
  });
});
