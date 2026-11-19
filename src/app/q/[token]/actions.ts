"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { approveQuote } from "@/lib/core/quote-public";
import { cookieSecure } from "@/lib/auth/session";
import { isLocale, localeCookieOptions } from "@/lib/i18n";
import { LOCALE_COOKIE } from "@/lib/i18n/server";
import { approveQuoteRules, clientIp, passesAll } from "@/lib/rate-limit";

const MAX_TOKEN = 200;

function pageOf(token: string, err?: string): string {
  return `/q/${encodeURIComponent(token)}${err ? `?err=${err}` : ""}`;
}

function tokenOf(formData: FormData): string {
  const token = String(formData.get("token") ?? "");
  return token.length <= MAX_TOKEN ? token : "";
}

/**
 * The client confirms the checked items. Every outcome lands back on the page, which shows the
 * decision (or the error) from the database: an answered quote just shows its decision.
 */
export async function approveQuoteAction(formData: FormData): Promise<void> {
  const token = tokenOf(formData);
  if (!token) redirect("/");
  if (!passesAll(approveQuoteRules(clientIp(await headers())))) redirect(pageOf(token, "tooManyAttempts"));

  const itemIds = formData.getAll("itemId").map(String);
  const version = formData.get("version");
  const res = await approveQuote(token, itemIds, {}, typeof version === "string" ? version : undefined);
  revalidatePath(pageOf(token).split("?")[0]);
  if (!res.ok && (res.error === "nothingSelected" || res.error === "quoteChanged")) redirect(pageOf(token, res.error));
  redirect(pageOf(token));
}

/** Remembers the visitor's language (a year) and comes back to the page. */
export async function setQuoteLocaleAction(formData: FormData): Promise<void> {
  const token = tokenOf(formData);
  const locale = formData.get("locale");
  if (isLocale(locale)) {
    (await cookies()).set(LOCALE_COOKIE, locale, localeCookieOptions(await cookieSecure()));
  }
  redirect(token ? pageOf(token) : "/");
}
