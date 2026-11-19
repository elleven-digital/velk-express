"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePortalAdmin } from "@/lib/auth/guards";
import { switchActiveCompany } from "@/lib/auth/session";
import { buyHours } from "@/lib/core/portal-payments";

/**
 * Makes another of the person's companies the active one. A company they do not belong to is
 * refused by `switchActiveCompany`; either way the person lands on the home. The redirect is
 * what makes the new session show: within this request the old one is cached.
 */
export async function switchCompanyAction(formData: FormData): Promise<void> {
  await switchActiveCompany(String(formData.get("clientId") ?? ""));
  revalidatePath("/", "layout");
  redirect("/");
}

/**
 * The company's admin buys extra hours: the pending purchase and its charge are created, then the
 * browser goes to the charge's pay link. The company is the session's own; a refusal comes back
 * to the home with its code, which the home turns into a message.
 */
export async function buyHoursAction(formData: FormData): Promise<void> {
  const session = await requirePortalAdmin();
  const raw = String(formData.get("hours") ?? "").trim();
  const res = await buyHours(session, /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN);
  if (!res.ok) redirect(`/?err=${encodeURIComponent(res.error)}`);
  revalidatePath("/");
  redirect(res.value.payUrl);
}
