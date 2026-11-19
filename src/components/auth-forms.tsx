"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Field, Input } from "./ui";
import { SubmitButton } from "./submit-button";
import { Icon } from "./icons";
import type { Side } from "@/lib/auth/credentials";

/** What an auth server action returns: null before the first submit. */
export type FormState = {
  error?: string;
  ok?: boolean;
  fieldErrors?: Record<string, string>;
} | null;

export type AuthAction = (prev: FormState, formData: FormData) => Promise<FormState>;

export type LoginLabels = {
  email: string;
  password: string;
  submit: string;
  forgot?: string;
  forgotHref?: string;
};

/*
 * Notes are white boxes with a tinted line and an icon, like Callout.
 */
const noteBox =
  "flex items-start gap-3 rounded-card border bg-white px-4 py-3 text-[0.875rem] font-medium text-ink";

function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className={`${noteBox} border-[color-mix(in_srgb,var(--color-dot-danger)_32%,#fff)]`}>
      <Icon name="alert" className="mt-0.5 text-dot-danger" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

function NoticeBanner({ message }: { message: string }) {
  return (
    <div role="status" className={`${noteBox} border-[color-mix(in_srgb,var(--color-dot-ok)_35%,#fff)]`}>
      <Icon name="check" className="mt-0.5 text-dot-ok" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

export function LoginForm({
  action,
  labels,
  next,
  error,
  notice,
}: {
  action: AuthAction;
  labels: LoginLabels;
  /** Where to go after login (the action decides whether it's allowed). */
  next?: string;
  /** A message to show before the first submit (e.g. from a redirect). */
  error?: string;
  notice?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {notice ? <NoticeBanner message={notice} /> : null}
      <ErrorBanner message={state?.error ?? error} />
      <Field label={labels.email} htmlFor="email">
        <Input id="email" name="email" type="email" required autoComplete="email" autoFocus />
      </Field>
      <Field label={labels.password} htmlFor="password">
        <Input id="password" name="password" type="password" required autoComplete="current-password" />
      </Field>
      {labels.forgot && labels.forgotHref ? (
        <div className="flex items-center justify-between gap-3 pt-1">
          <Link
            href={labels.forgotHref}
            className="text-[0.875rem] font-medium text-ink hover:underline underline-offset-[3px]"
          >
            {labels.forgot}
          </Link>
          <SubmitButton>{labels.submit}</SubmitButton>
        </div>
      ) : (
        <div className="pt-1">
          <SubmitButton className="w-full">{labels.submit}</SubmitButton>
        </div>
      )}
    </form>
  );
}

export function ForgotForm({
  action,
  labels,
  side,
}: {
  action: AuthAction;
  labels: { email: string; submit: string; sent: string };
  /** Which login asked: carried to the action in a hidden field. */
  side?: Side;
}) {
  const [state, formAction] = useActionState(action, null);
  if (state?.ok) {
    return (
      <div
        role="status"
        className={`${noteBox} border-[color-mix(in_srgb,var(--color-dot-ok)_35%,#fff)]`}
      >
        <Icon name="check" className="mt-0.5 text-dot-ok" />
        <span className="min-w-0">{labels.sent}</span>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4">
      {side ? <input type="hidden" name="side" value={side} /> : null}
      <ErrorBanner message={state?.error} />
      <Field label={labels.email} htmlFor="email" error={state?.fieldErrors?.email}>
        <Input id="email" name="email" type="email" required autoFocus />
      </Field>
      <SubmitButton className="w-full">{labels.submit}</SubmitButton>
    </form>
  );
}

export function SetPasswordForm({
  action,
  labels,
  token,
  nameField,
}: {
  action: AuthAction;
  labels: { password: string; confirm: string; submit: string };
  /** An editable name above the password (invites). */
  nameField?: { label: string; defaultValue: string };
  /** The reset or invite token, sent back to the action as a hidden field. */
  token?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-4">
      {token ? <input type="hidden" name="token" value={token} /> : null}
      <ErrorBanner message={state?.error} />
      {nameField ? (
        <Field label={nameField.label} htmlFor="name">
          <Input id="name" name="name" required maxLength={120} autoComplete="name" defaultValue={nameField.defaultValue} />
        </Field>
      ) : null}
      <Field label={labels.password} htmlFor="password" error={state?.fieldErrors?.password}>
        <Input id="password" name="password" type="password" required minLength={8} autoFocus={!nameField} autoComplete="new-password" />
      </Field>
      <Field label={labels.confirm} htmlFor="confirm" error={state?.fieldErrors?.confirm}>
        <Input id="confirm" name="confirm" type="password" required minLength={8} autoComplete="new-password" />
      </Field>
      <SubmitButton className="w-full">{labels.submit}</SubmitButton>
    </form>
  );
}
