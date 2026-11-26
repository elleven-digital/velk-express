"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setOwnLocale } from "@/lib/core/profile";
import { isLocale, localeCookieOptions } from "@/lib/i18n";
import { LOCALE_COOKIE } from "@/lib/i18n/server";
import { requirePortal, requireTeam } from "./guards";
import { safeReturnPath } from "./return-path";
import { cookieSecure, destroySession } from "./session";

/** Ends the team session and goes back to the team login page. */
export async function signOut(): Promise<void> {
  await destroySession("agency");
  redirect("/admin/login");
}

/** Ends the portal session and goes back to the portal login page. */
export async function signOutPortal(): Promise<void> {
  await destroySession("client");
  redirect("/login");
}

/**
 * Saves the signed-in person's language (empty = the agency's) and comes back to the page they
 * were on. The cookie carries the choice to the logged-out pages (login, password) of this browser.
 */
async function saveOwnLocale(session: Parameters<typeof setOwnLocale>[0], formData: FormData, home: string): Promise<never> {
  const raw = String(formData.get("locale") ?? "");
  const locale = isLocale(raw) ? raw : null;
  const res = await setOwnLocale(session, locale);
  if (res.ok) {
    const store = await cookies();
    if (locale) store.set(LOCALE_COOKIE, locale, localeCookieOptions(await cookieSecure()));
    else store.delete(LOCALE_COOKIE);
  }
  revalidatePath("/", "layout");
  // a fresh request, so the new language shows (within this one the session is cached)
  redirect(safeReturnPath(String(formData.get("path") ?? "")) ?? home);
}

/** A team member picks their own language. */
export async function setTeamLocaleAction(formData: FormData): Promise<void> {
  await saveOwnLocale(await requireTeam(), formData, "/admin");
}

/** A portal person picks their own language. */
export async function setPortalLocaleAction(formData: FormData): Promise<void> {
  await saveOwnLocale(await requirePortal(), formData, "/");
}

/**
 * A visitor of the login and password pages picks a language: remembered in this browser (a year)
 * and back to the same page. Signed-in people pick theirs in the sidebar instead.
 */
export async function setVisitorLocaleAction(formData: FormData): Promise<void> {
  const locale = String(formData.get("locale") ?? "");
  if (isLocale(locale)) (await cookies()).set(LOCALE_COOKIE, locale, localeCookieOptions(await cookieSecure()));
  redirect(safeReturnPath(String(formData.get("path") ?? "")) ?? "/login");
}
