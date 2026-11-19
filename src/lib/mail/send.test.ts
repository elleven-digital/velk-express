import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmtpConfig } from "@/lib/config";
import { sendMail, transportOptions, type Transport } from "./send";

const smtp: SmtpConfig = { host: "smtp.example.com", port: 587, user: "u", pass: "secret-pass", from: "Agency <no-reply@agency.test>" };
const msg = { to: "client@customer.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi" };

afterEach(() => vi.restoreAllMocks());

describe("sendMail", () => {
  it("returns sent:false without SMTP, logging only once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const transport: Transport = { sendMail: vi.fn() };
    expect(await sendMail(msg, transport, null)).toEqual({ sent: false });
    expect(await sendMail(msg, transport, null)).toEqual({ sent: false });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(log.mock.calls.filter((c) => String(c[0]).includes("[mail] SMTP not configured; skipping"))).toHaveLength(1);
  });

  it("returns sent:false and does not throw when the transport fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport: Transport = { sendMail: vi.fn().mockRejectedValue(new Error("connection refused")) };
    expect(await sendMail(msg, transport, smtp)).toEqual({ sent: false });
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.join(" "));
    expect(line).toContain("customer.test");
    expect(line).toContain("connection refused");
    expect(line).not.toContain("secret-pass");
    expect(line).not.toContain("client@customer.test");
  });

  it("sends with MAIL_FROM as the sender", async () => {
    const sendMailFn = vi.fn().mockResolvedValue({});
    expect(await sendMail(msg, { sendMail: sendMailFn }, smtp)).toEqual({ sent: true });
    expect(sendMailFn).toHaveBeenCalledWith({ from: smtp.from, ...msg });
  });
});

describe("transportOptions", () => {
  it("sets connection, greeting and socket timeouts", () => {
    expect(transportOptions(smtp)).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: "u", pass: "secret-pass" },
    });
    expect(transportOptions({ ...smtp, port: 465, user: null }).secure).toBe(true);
  });
});
