import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "./config";

const base = { DATABASE_URL: "postgres://u@h/db" };

describe("readConfig", () => {
  it("throws ConfigError without DATABASE_URL", () => {
    expect(() => readConfig({})).toThrow(ConfigError);
  });

  it("applies defaults with only DATABASE_URL", () => {
    const c = readConfig(base);
    expect(c.databaseUrl).toBe(base.DATABASE_URL);
    expect(c.dataDir).toBe("/data");
    expect(c.port).toBe(3000);
    expect(c.appUrl).toBeNull();
    expect(c.secretKey).toBeNull();
    expect(c.s3).toBeNull();
    expect(c.mail).toBeNull();
    expect(c.stripe).toBeNull();
    expect(c.mercadoPago).toBeNull();
    expect(c.updateCheck).toBe(true);
    expect(c.warnings).toEqual([]);
  });

  it("parses PORT and falls back on invalid values", () => {
    expect(readConfig({ ...base, PORT: "8080" }).port).toBe(8080);
    expect(readConfig({ ...base, PORT: "abc" }).port).toBe(3000);
  });

  it("normalizes APP_URL", () => {
    expect(readConfig({ ...base, APP_URL: "https://x.com/" }).appUrl).toBe("https://x.com");
    expect(readConfig({ ...base, APP_URL: "https://x.com/a/b?q=1" }).appUrl).toBe("https://x.com");
    const c = readConfig({ ...base, APP_URL: "ftp://x" });
    expect(c.appUrl).toBeNull();
    expect(c.warnings.some((w) => w.includes("APP_URL"))).toBe(true);
    const d = readConfig({ ...base, APP_URL: "not a url" });
    expect(d.appUrl).toBeNull();
    expect(d.warnings.some((w) => w.includes("APP_URL"))).toBe(true);
  });

  it("handles S3 completeness", () => {
    const s3 = {
      S3_ENDPOINT: "https://s3.x",
      S3_REGION: "auto",
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
    };
    const { S3_BUCKET: _omit, ...partial } = s3;
    void _omit;
    const c = readConfig({ ...base, ...partial });
    expect(c.s3).toBeNull();
    expect(c.warnings.some((w) => w.includes("S3_BUCKET"))).toBe(true);
    expect(readConfig({ ...base, ...s3 }).s3).toEqual({
      endpoint: "https://s3.x",
      region: "auto",
      bucket: "b",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
  });

  it("handles SMTP", () => {
    const c = readConfig({ ...base, SMTP_HOST: "smtp.x" });
    expect(c.mail).toBeNull();
    expect(c.warnings.some((w) => w.includes("MAIL_FROM"))).toBe(true);
    const d = readConfig({ ...base, SMTP_HOST: "smtp.x", MAIL_FROM: "a@x.com" });
    expect(d.mail).toEqual({ provider: "smtp", host: "smtp.x", port: 587, user: null, pass: null, from: "a@x.com" });
    const e = readConfig({
      ...base, SMTP_HOST: "smtp.x", MAIL_FROM: "a@x.com", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p",
    });
    expect(e.mail).toEqual({ provider: "smtp", host: "smtp.x", port: 465, user: "u", pass: "p", from: "a@x.com" });
  });

  it("handles the Resend API", () => {
    const c = readConfig({ ...base, RESEND_API_KEY: "re_x" });
    expect(c.mail).toBeNull();
    expect(c.warnings.some((w) => w.includes("MAIL_FROM"))).toBe(true);
    const d = readConfig({ ...base, RESEND_API_KEY: "re_x", MAIL_FROM: "a@x.com" });
    expect(d.mail).toEqual({ provider: "resend", apiKey: "re_x", from: "a@x.com" });
    expect(d.warnings).toEqual([]);
    const both = readConfig({ ...base, RESEND_API_KEY: "re_x", SMTP_HOST: "smtp.x", MAIL_FROM: "a@x.com" });
    expect(both.mail).toEqual({ provider: "resend", apiKey: "re_x", from: "a@x.com" });
    expect(both.warnings.some((w) => w.includes("SMTP is ignored"))).toBe(true);
  });

  it("warns when MAIL_FROM has no way to send", () => {
    const c = readConfig({ ...base, MAIL_FROM: "a@x.com" });
    expect(c.mail).toBeNull();
    expect(c.warnings.some((w) => w.includes("SMTP_HOST or RESEND_API_KEY"))).toBe(true);
  });

  it("handles Stripe and Mercado Pago pairs", () => {
    const s = readConfig({ ...base, STRIPE_SECRET_KEY: "sk" });
    expect(s.stripe).toBeNull();
    expect(s.warnings.some((w) => w.includes("STRIPE_WEBHOOK_SECRET"))).toBe(true);
    expect(readConfig({ ...base, STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh" }).stripe).toEqual({
      secretKey: "sk",
      webhookSecret: "wh",
    });
    const m = readConfig({ ...base, MERCADOPAGO_WEBHOOK_SECRET: "wh" });
    expect(m.mercadoPago).toBeNull();
    expect(m.warnings.some((w) => w.includes("MERCADOPAGO_ACCESS_TOKEN"))).toBe(true);
    expect(
      readConfig({ ...base, MERCADOPAGO_ACCESS_TOKEN: "t", MERCADOPAGO_WEBHOOK_SECRET: "wh" }).mercadoPago,
    ).toEqual({ accessToken: "t", webhookSecret: "wh" });
  });

  it("parses boolean flags", () => {
    expect(readConfig({ ...base, UPDATE_CHECK: "false" }).updateCheck).toBe(false);
    expect(readConfig({ ...base, UPDATE_CHECK: "FALSE" }).updateCheck).toBe(false);
    expect(readConfig({ ...base, UPDATE_CHECK: "0" }).updateCheck).toBe(true);
  });

  it("treats empty strings (as passed by docker compose) like unset variables", () => {
    const empty = Object.fromEntries(
      [
        "APP_URL", "SECRET_KEY", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
        "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "RESEND_API_KEY", "MAIL_FROM", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
        "MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET", "UPDATE_CHECK",
      ].map((k) => [k, ""]),
    );
    const c = readConfig({ ...base, ...empty });
    expect(c).toEqual(readConfig(base));
    expect(c.warnings).toEqual([]);
  });
});
