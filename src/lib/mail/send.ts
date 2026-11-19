import "server-only";
import nodemailer from "nodemailer";
import { getConfig, type SmtpConfig } from "@/lib/config";

export type MailMessage = { to: string; subject: string; html: string; text: string };

/** The minimal slice of a nodemailer transport that we use. */
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

function getDefaultTransport(smtp: SmtpConfig): Transport {
  defaultTransport ??= nodemailer.createTransport(transportOptions(smtp));
  return defaultTransport;
}

/**
 * Sends one e-mail. Never throws: returns `{ sent: false }` when SMTP is not
 * configured or the transport fails.
 *
 * `smtp` defaults to the app config and decides both whether mail is enabled
 * and the `from` address; tests pass it (together with a fake `transport`)
 * instead of touching the environment.
 */
export async function sendMail(
  msg: MailMessage,
  transport?: Transport,
  smtp: SmtpConfig | null = getConfig().smtp,
): Promise<{ sent: boolean }> {
  if (!smtp) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.log("[mail] SMTP not configured; skipping");
    }
    return { sent: false };
  }
  try {
    await (transport ?? getDefaultTransport(smtp)).sendMail({ from: smtp.from, ...msg });
    return { sent: true };
  } catch (err) {
    const domain = msg.to.split("@").pop() ?? "unknown";
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[mail] send to ${domain} failed: ${reason}`);
    return { sent: false };
  }
}
