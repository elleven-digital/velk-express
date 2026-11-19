"use client";

import { useActionState } from "react";
import { Callout, Field, Input, Select } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { TimeZoneSelect } from "@/components/time-zone-select";
import type { TimeZoneGroup } from "@/lib/time-zone";
import { installAction, type InstallState } from "./actions";

export type InstallLabels = {
  agencyName: string;
  ownerName: string;
  email: string;
  password: string;
  passwordHint: string;
  publicUrl: string;
  publicUrlHint: string;
  publicUrlFixed: string;
  currency: string;
  language: string;
  timeZone: string;
  timeZoneHint: string;
  submit: string;
};

export function InstallForm({
  labels,
  detectedUrl,
  fixedUrl,
  defaultLocale,
  localeOptions,
  currencies,
  timeZones,
  minPassword,
}: {
  labels: InstallLabels;
  detectedUrl: string;
  /** Set when APP_URL is defined: shown as plain text, not editable. */
  fixedUrl: string | null;
  defaultLocale: string;
  localeOptions: { value: string; label: string }[];
  currencies: string[];
  timeZones: TimeZoneGroup[];
  minPassword: number;
}) {
  const [state, action] = useActionState<InstallState, FormData>(installAction, null);
  const v = state?.values;

  return (
    <form action={action} className="space-y-5">
      {state?.error ? <Callout tone="danger" title={state.error} /> : null}

      <Field label={labels.agencyName} htmlFor="agencyName">
        <Input id="agencyName" name="agencyName" required maxLength={120} defaultValue={v?.agencyName} autoFocus />
      </Field>
      <Field label={labels.ownerName} htmlFor="ownerName">
        <Input id="ownerName" name="ownerName" required maxLength={120} autoComplete="name" defaultValue={v?.ownerName} />
      </Field>
      <Field label={labels.email} htmlFor="ownerEmail">
        <Input id="ownerEmail" name="ownerEmail" type="email" required autoComplete="email" defaultValue={v?.ownerEmail} />
      </Field>
      <Field label={labels.password} htmlFor="password" hint={labels.passwordHint}>
        <Input id="password" name="password" type="password" required minLength={minPassword} autoComplete="new-password" />
      </Field>

      {fixedUrl ? (
        <Field label={labels.publicUrl} hint={labels.publicUrlFixed}>
          <p className="text-[0.875rem] text-ink break-all">{fixedUrl}</p>
        </Field>
      ) : (
        <Field label={labels.publicUrl} htmlFor="appUrl" hint={labels.publicUrlHint}>
          <Input id="appUrl" name="appUrl" type="url" required defaultValue={v?.appUrl ?? detectedUrl} />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label={labels.currency} htmlFor="currency">
          <Select id="currency" name="currency" defaultValue={v?.currency ?? "BRL"}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.language} htmlFor="locale">
          <Select id="locale" name="locale" defaultValue={v?.locale ?? defaultLocale}>
            {localeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label={labels.timeZone} htmlFor="timeZone" hint={labels.timeZoneHint}>
        {/* starts on the browser's zone when it is in the list, else São Paulo */}
        <TimeZoneSelect id="timeZone" name="timeZone" groups={timeZones} value={v?.timeZone} preferBrowser />
      </Field>

      <SubmitButton size="lg" className="w-full">
        {labels.submit}
      </SubmitButton>
    </form>
  );
}
