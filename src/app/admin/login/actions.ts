"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/auth-forms";
import { authenticate, normalizeEmail } from "@/lib/auth/credentials";
import { safeReturnPath } from "@/lib/auth/return-path";
import { createSession } from "@/lib/auth/session";
import { getPublicDict } from "@/lib/i18n/server";
import { clientIp, loginRules, passesAll } from "@/lib/rate-limit";

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { t } = await getPublicDict();
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: t.auth.invalidCredentials };

  const ip = clientIp(await headers());
  if (!passesAll(loginRules("team", ip, email))) {
    return { error: t.auth.tooManyAttempts };
  }

  const user = await authenticate(email, password);
  if (!user) return { error: t.auth.invalidCredentials };
  await createSession("agency", user.id);
  const next = formData.get("next");
  redirect(safeReturnPath(typeof next === "string" ? next : null) ?? "/admin");
}
