import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailConfig } from "@/lib/config";
import { resendTransport, sendMail, transportOptions, type Transport } from "./send";

const smtp = { provider: "smtp", host: "smtp.example.com", port: 587, user: "u", pass: "secret-pass", from: "Agency <no-reply@agency.test>" } satisfies MailConfig;
const msg = { to: "client@customer.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi" };

afterEach(() => vi.restoreAllMocks());

describe("sendMail", () => {
  it("returns sent:false without SMTP, logging only once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const transport: Transport = { sendMail: vi.fn() };
    expect(await sendMail(msg, transport, null)).toEqual({ sent: false });
    expect(await sendMail(msg, transport, null)).toEqual({ sent: false });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(log.mock.calls.filter((c) => String(c[0]).includes("[mail] e-mail not configured; skipping"))).toHaveLength(1);
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

describe("resendTransport", () => {
  const resend = { provider: "resend", apiKey: "re_secret_key", from: "Agency <no-reply@agency.test>" } satisfies MailConfig;

  it("posts the message to the Resend API with the key as a bearer token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    expect(await sendMail(msg, resendTransport(resend.apiKey, fetchFn), resend)).toEqual({ sent: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_secret_key");
    expect(JSON.parse(String(init.body))).toEqual({
      from: resend.from,
      to: ["client@customer.test"],
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  it("logs Resend's error message without the API key", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify({ statusCode: 403, name: "validation_error", message: "The agency.test domain is not verified." });
    const fetchFn = vi.fn().mockResolvedValue(new Response(body, { status: 403 }));
    expect(await sendMail(msg, resendTransport(resend.apiKey, fetchFn), resend)).toEqual({ sent: false });
    const line = String(error.mock.calls[0]?.join(" "));
    expect(line).toContain("Resend API returned 403: The agency.test domain is not verified.");
    expect(line).not.toContain("re_secret_key");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("oops", { status: 502, statusText: "Bad Gateway" }));
    await expect(resendTransport("k", fetchFn).sendMail({ from: "a@x.test", ...msg })).rejects.toThrow(
      "Resend API returned 502: Bad Gateway",
    );
  });

  it("reports a network failure as not sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await sendMail(msg, resendTransport(resend.apiKey, fetchFn), resend)).toEqual({ sent: false });
  });
});
