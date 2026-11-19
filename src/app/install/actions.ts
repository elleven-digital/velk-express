"use server";

import { redirect } from "next/navigation";
import { getConfig } from "@/lib/config";
import { detectAppUrl } from "@/lib/app-url";
import { installAgency } from "@/lib/core/install";
import { fmt, getDict, isLocale } from "@/lib/i18n";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { getPublicLocale } from "@/lib/i18n/server";
import { headers } from "next/headers";

export type InstallValues = {
  agencyName: string;
  ownerName: string;
  ownerEmail: string;
  appUrl: string;
  currency: string;
  locale: string;
  timeZone: string;
};

export type InstallState = { error: string; values: InstallValues } | null;

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

export async function installAction(_prev: InstallState, formData: FormData): Promise<InstallState> {
  const values: InstallValues = {
    agencyName: text(formData, "agencyName"),
    ownerName: text(formData, "ownerName"),
    ownerEmail: text(formData, "ownerEmail"),
    appUrl: text(formData, "appUrl"),
    currency: text(formData, "currency"),
    locale: text(formData, "locale"),
    timeZone: text(formData, "timeZone"),
  };
  const locale = isLocale(values.locale) ? values.locale : await getPublicLocale();
  const t = (await getDict(locale)).install;

  // With APP_URL set the address is fixed and the form value is ignored.
  const appUrl = getConfig().appUrl ?? (values.appUrl || detectAppUrl(await headers()) || "");

  let res: Awaited<ReturnType<typeof installAgency>>;
  try {
    res = await installAgency({
      agencyName: values.agencyName,
      ownerName: values.ownerName,
      ownerEmail: values.ownerEmail,
      password: text(formData, "password"),
      currency: values.currency as "BRL" | "USD" | "EUR",
      locale,
      timeZone: values.timeZone,
      appUrl,
    });
  } catch (err) {
    console.error("[install] failed:", err instanceof Error ? err.message : err);
    return { error: t.errors.generic, values };
  }

  if (res.ok) {
    let signedIn = true;
    try {
      await createSession("agency", res.value.ownerId);
    } catch (err) {
      // The install is done; the owner can still sign in by hand.
      signedIn = false;
      console.error("[install] could not start the owner's session:", err instanceof Error ? err.message : err);
    }
    redirect(signedIn ? "/admin" : "/admin/login");
  }
  if (res.error === "alreadyInstalled") redirect("/admin/login");
  const message =
    res.error === "invalid"
      ? fmt(t.errors.invalid, { min: MIN_PASSWORD_LENGTH })
      : res.error === "invalidTimeZone"
        ? t.errors.invalidTimeZone
        : t.errors.generic;
  return { error: message, values };
}
