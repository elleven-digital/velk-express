import "server-only";
import nodemailer from "nodemailer";
import { getConfig, type MailConfig, type SmtpConfig } from "@/lib/config";

export type MailMessage = { to: string; subject: string; html: string; text: string };

/** The minimal slice of a nodemailer transport that we use; the Resend transport has the same shape. */
export type Transport = {
  sendMail(options: { from: string; to: string; subject: string; html: string; text: string }): Promise<unknown>;
};

let defaultTransport: Transport | null = null;
let warnedDisabled = false;

/** Nodemailer options for the SMTP settings. Timeouts keep a dead server from hanging a request. */
export function transportOptions(smtp: SmtpConfig) {
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}),
  };
}

const RESEND_URL = "https://api.resend.com/emails";

/**
 * Sends through the Resend HTTPS API, for hosts that block outbound SMTP.
 * Throws on a non-2xx answer with Resend's own message (never the API key).
 */
export function resendTransport(apiKey: string, fetchFn: typeof fetch = fetch): Transport {
  return {
    async sendMail({ from, to, subject, html, text }) {
      const res = await fetchFn(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "velk-express",
        },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return;
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === "string" && body.message) detail = body.message;
      } catch {
        // keeps the status text
      }
      throw new Error(`Resend API returned ${res.status}: ${detail}`);
    },
  };
}

function getDefaultTransport(mail: MailConfig): Transport {
  defaultTransport ??=
    mail.provider === "resend" ? resendTransport(mail.apiKey) : nodemailer.createTransport(transportOptions(mail));
  return defaultTransport;
}

/**
 * Sends one e-mail. Never throws: returns `{ sent: false }` when e-mail is not
 * configured or the transport fails.
 *
 * `mail` defaults to the app config and decides whether mail is enabled, how
 * it is sent and the `from` address; tests pass it (together with a fake
 * `transport`) instead of touching the environment.
 */
export async function sendMail(
  msg: MailMessage,
  transport?: Transport,
  mail: MailConfig | null = getConfig().mail,
): Promise<{ sent: boolean }> {
  if (!mail) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.log("[mail] e-mail not configured; skipping");
    }
    return { sent: false };
  }
  try {
    await (transport ?? getDefaultTransport(mail)).sendMail({ from: mail.from, ...msg });
    return { sent: true };
  } catch (err) {
    const domain = msg.to.split("@").pop() ?? "unknown";
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[mail] send to ${domain} failed: ${reason}`);
    return { sent: false };
  }
}
