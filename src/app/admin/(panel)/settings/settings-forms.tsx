"use client";

import { useActionState } from "react";
import { AgencyAvatar } from "@/components/agency-avatar";
import { Callout, Checkbox, Field, Input, Select } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { TimeZoneSelect } from "@/components/time-zone-select";
import type { TimeZoneGroup } from "@/lib/time-zone";
import type { SettingsState } from "./settings-state";

type Action = (prev: SettingsState, formData: FormData) => Promise<SettingsState>;

function Notice({ state }: { state: SettingsState }) {
  if (state?.error) return <Callout tone="danger" title={state.error} />;
  if (state?.ok) return <Callout tone="ok" title={state.ok} />;
  return null;
}

export type AgencyFormLabels = {
  name: string;
  currency: string;
  language: string;
  languageHint: string;
  timeZone: string;
  timeZoneHint: string;
  save: string;
};

export function AgencyForm({
  action,
  labels,
  values,
  currencies,
  locales,
  timeZones,
}: {
  action: Action;
  labels: AgencyFormLabels;
  values: { name: string; currency: string; locale: string; timeZone: string };
  currencies: string[];
  locales: { value: string; label: string }[];
  timeZones: TimeZoneGroup[];
}) {
  const [state, run] = useActionState(action, null);
  const typed = state?.values;
  return (
    <form action={run} className="space-y-5">
      <Notice state={state} />
      <Field label={labels.name} htmlFor="name">
        <Input id="name" name="name" required maxLength={120} defaultValue={typed?.name ?? values.name} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={labels.currency} htmlFor="currency">
          <Select key={typed?.currency} id="currency" name="currency" defaultValue={typed?.currency ?? values.currency}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.language} htmlFor="locale" hint={labels.languageHint}>
          <Select key={typed?.locale} id="locale" name="locale" defaultValue={typed?.locale ?? values.locale}>
            {locales.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={labels.timeZone} htmlFor="timeZone" hint={labels.timeZoneHint}>
        {/* a forged zone sent back with the error is not in the list: the saved one shows instead */}
        <TimeZoneSelect id="timeZone" name="timeZone" groups={timeZones} value={typed?.timeZone} fallback={values.timeZone} />
      </Field>
      <SubmitButton>{labels.save}</SubmitButton>
    </form>
  );
}

export type LogoFormLabels = {
  logo: string;
  hint: string;
  none: string;
  upload: string;
  replace: string;
  remove: string;
};

export function LogoForm({
  uploadAction,
  removeAction,
  labels,
  agencyName,
  logoUrl,
}: {
  uploadAction: Action;
  removeAction: () => Promise<SettingsState>;
  labels: LogoFormLabels;
  agencyName: string;
  logoUrl: string | null;
}) {
  const [upState, upload] = useActionState(uploadAction, null);
  const [rmState, remove] = useActionState(removeAction, null);
  const state = upState ?? rmState;
  return (
    <div className="space-y-4">
      <Notice state={state} />
      <div className="flex flex-wrap items-center gap-4">
        <AgencyAvatar name={agencyName} logoUrl={logoUrl} size={56} />
        <p className="min-w-0 flex-1 basis-56 text-[0.875rem] text-muted">{logoUrl ? labels.hint : labels.none}</p>
      </div>
      <form action={upload} className="space-y-1.5">
        <label htmlFor="logo" className="block text-[0.875rem] font-medium text-ink">
          {labels.logo}
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <input
            id="logo"
            name="logo"
            type="file"
            required
            accept="image/png,image/jpeg,image/webp"
            className="min-w-0 max-w-full text-[0.875rem] text-muted file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-line file:bg-white file:px-3 file:text-[0.875rem] file:font-medium file:text-ink hover:file:bg-chip"
          />
          <SubmitButton variant="secondary">{logoUrl ? labels.replace : labels.upload}</SubmitButton>
        </div>
        <p className="text-[0.8125rem] text-muted">{labels.hint}</p>
      </form>
      {logoUrl ? (
        <form action={remove}>
          <SubmitButton variant="danger" size="sm">
            {labels.remove}
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}

export function AppUrlForm({
  action,
  label,
  hint,
  save,
  value,
}: {
  action: Action;
  label: string;
  hint: string;
  save: string;
  value: string;
}) {
  const [state, run] = useActionState(action, null);
  return (
    <form action={run} className="space-y-3">
      <Notice state={state} />
      <Field label={label} htmlFor="appUrl" hint={hint}>
        <Input id="appUrl" name="appUrl" type="url" required maxLength={2048} defaultValue={state?.values?.appUrl ?? value} />
      </Field>
      <SubmitButton variant="secondary">{save}</SubmitButton>
    </form>
  );
}

export type VisibilityFormLabels = {
  clientScope: string;
  clientScopeAll: string;
  clientScopeAssigned: string;
  ticketScope: string;
  ticketScopeAll: string;
  ticketScopeAssigned: string;
  seesUnassigned: string;
  save: string;
};

const radio = "size-4 flex-none accent-brand";
const radioRow = "flex items-center gap-2.5 cursor-pointer text-[0.875rem] text-ink";

export function VisibilityForm({
  action,
  labels,
  values,
}: {
  action: Action;
  labels: VisibilityFormLabels;
  values: { clientScope: string; ticketScope: string; seesUnassigned: boolean };
}) {
  const [state, run] = useActionState(action, null);
  const typed = state?.values;
  const clientScope = typed?.clientScope ?? values.clientScope;
  const ticketScope = typed?.ticketScope ?? values.ticketScope;
  return (
    <form action={run} className="space-y-5">
      <Notice state={state} />
      <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
        <fieldset>
          <legend className="text-[0.875rem] font-medium text-ink">{labels.clientScope}</legend>
          <div className="mt-2.5 space-y-2.5">
            <label className={radioRow}>
              <input type="radio" name="clientScope" value="all" defaultChecked={clientScope === "all"} className={radio} />
              {labels.clientScopeAll}
            </label>
            <label className={radioRow}>
              <input
                type="radio"
                name="clientScope"
                value="assigned"
                defaultChecked={clientScope !== "all"}
                className={radio}
              />
              {labels.clientScopeAssigned}
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[0.875rem] font-medium text-ink">{labels.ticketScope}</legend>
          <div className="mt-2.5 space-y-2.5">
            <label className={radioRow}>
              <input type="radio" name="ticketScope" value="all" defaultChecked={ticketScope !== "assigned"} className={radio} />
              {labels.ticketScopeAll}
            </label>
            <label className={radioRow}>
              <input
                type="radio"
                name="ticketScope"
                value="assigned"
                defaultChecked={ticketScope === "assigned"}
                className={radio}
              />
              {labels.ticketScopeAssigned}
            </label>
            <div className="pl-6 pt-1">
              <Checkbox name="seesUnassigned" defaultChecked={typed ? typed.seesUnassigned === "on" : values.seesUnassigned} label={labels.seesUnassigned} />
            </div>
          </div>
        </fieldset>
      </div>
      <SubmitButton>{labels.save}</SubmitButton>
    </form>
  );
}

export function DefaultProviderForm({
  action,
  label,
  hint,
  save,
  value,
  options,
}: {
  action: Action;
  label: string;
  hint: string;
  save: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  const [state, run] = useActionState(action, null);
  return (
    <form action={run} className="space-y-4">
      <Notice state={state} />
      <Field label={label} htmlFor="provider" hint={hint}>
        <Select key={`${state?.values?.provider ?? ""}:${value}`} id="provider" name="provider" defaultValue={state?.values?.provider ?? value}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <SubmitButton variant="secondary">{save}</SubmitButton>
    </form>
  );
}
