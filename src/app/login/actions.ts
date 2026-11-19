"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/auth-forms";
import { authenticateClient, normalizeEmail } from "@/lib/auth/credentials";
import { createSession } from "@/lib/auth/session";
import { getPublicDict } from "@/lib/i18n/server";
import { clientIp, loginRules, passesAll } from "@/lib/rate-limit";

export async function portalLoginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { t } = await getPublicDict();
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: t.auth.invalidCredentials };

  const ip = clientIp(await headers());
  if (!passesAll(loginRules("portal", ip, email))) {
    return { error: t.auth.tooManyAttempts };
  }

  const person = await authenticateClient(email, password);
  if (!person) return { error: t.auth.invalidCredentials };
  await createSession("client", person.id);
  redirect("/");
}
