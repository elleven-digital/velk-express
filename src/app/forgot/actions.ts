"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import type { FormState } from "@/components/auth-forms";
import { getAgency, logoAbsoluteUrl } from "@/lib/agency";
import { getConfig } from "@/lib/config";
import { findUserForReset, normalizeEmail, parseSide, userTypeFor, type Side } from "@/lib/auth/credentials";
import { canDeliverResetMail } from "@/lib/auth/reset-policy";
import { authLink, issueAuthToken } from "@/lib/auth/tokens";
import { getDict, isLocale } from "@/lib/i18n";
import { getPublicDict, getPublicLocale } from "@/lib/i18n/server";
import { buildResetMail } from "@/lib/mail/messages/reset";
import { sendMail } from "@/lib/mail/send";
import { clientIp, forgotRules, passesAll, rateLimit } from "@/lib/rate-limit";

async function issueAndSend(side: Side, email: string, publicLocale: Awaited<ReturnType<typeof getPublicLocale>>) {
  // No SMTP: nothing can be delivered, and a new token would cancel a reset link the owner copied.
  if (!canDeliverResetMail(getConfig().smtp)) return;
  const user = await findUserForReset(side, email);
  if (!user) return;
  const raw = await issueAuthToken("reset", userTypeFor(side), user.id);
  const agency = await getAgency();
  const locale = isLocale(user.locale) ? user.locale : isLocale(agency?.locale) ? agency.locale : publicLocale;
  const dict = await getDict(locale);
  await sendMail(
    buildResetMail(dict.auth.resetMail, {
      to: user.email,
      userName: user.name,
      agencyName: agency?.name ?? "Velk Express",
      logoUrl: await logoAbsoluteUrl(agency?.logoFileId ?? null),
      link: await authLink(raw),
    }),
  );
}

/**
 * Always answers the same way, at the same speed, whether or not the email
 * belongs to someone: the lookup, token and mail run after the response.
 * Without SMTP nothing is sent; the owner can create reset links on the team page.
 */
export async function forgotAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { t, locale } = await getPublicDict();
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  if (!email) return { fieldErrors: { email: t.common.requiredField } };

  const side = parseSide(formData.get("side"));
  const rules = forgotRules(side, clientIp(await headers()), email);
  if (!passesAll(rules.ip)) return { error: t.auth.tooManyAttempts };
  // Per-email cap: same generic answer, just no token (no enumeration).
  if (!rateLimit(rules.account.key, rules.account)) return { ok: true };

  after(async () => {
    try {
      await issueAndSend(side, email, locale);
    } catch (err) {
      console.error("[auth] password reset request failed:", err instanceof Error ? err.message : err);
    }
  });
  return { ok: true };
}
