"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/auth-forms";
import { completePasswordToken, TokenUserMissingError } from "@/lib/auth/credentials";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { fmt } from "@/lib/i18n";
import { getPublicDict } from "@/lib/i18n/server";
import { clientIp, passesAll, setPasswordRules } from "@/lib/rate-limit";

export async function setPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { t } = await getPublicDict();
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const name = String(formData.get("name") ?? "");

  const problem = passwordProblem(password);
  if (problem === "tooShort") {
    return { fieldErrors: { password: fmt(t.auth.passwordTooShort, { min: MIN_PASSWORD_LENGTH }) } };
  }
  if (problem === "tooLong") {
    return { fieldErrors: { password: fmt(t.auth.passwordTooLong, { max: MAX_PASSWORD_BYTES }) } };
  }
  if (password !== confirm) return { fieldErrors: { confirm: t.auth.passwordMismatch } };
  if (name.length > 120) return { error: t.auth.genericError };

  if (!passesAll(setPasswordRules(clientIp(await headers())))) return { error: t.auth.tooManyAttempts };

  let owner;
  try {
    owner = await completePasswordToken({ token, password, name });
  } catch (err) {
    // The user vanished after the check; the token was not spent.
    if (err instanceof TokenUserMissingError) return { error: t.auth.invalidLink };
    throw err;
  }
  if (!owner) return { error: t.auth.invalidLink };
  await createSession(owner.userType, owner.userId);
  redirect(owner.userType === "client" ? "/" : "/admin");
}
