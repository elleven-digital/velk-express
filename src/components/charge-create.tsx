"use client";

import { useActionState, useId } from "react";
import type { ChargeState } from "@/app/admin/(panel)/charges/charge-state";
import { SubmitButton } from "./submit-button";
import { Callout, Field, Input, Select } from "./ui";

export type ChargeCreateLabels = {
  provider: string;
  create: string;
  /** Only with an amount field. */
  amount?: string;
  save?: string;
  /** Shown when only the manual record is offered. */
  manualHint?: string | null;
};

/**
 * "Create charge" for one source: the provider (only the ones that serve it, the default
 * preselected) and the button; with `amount`, the value too (a ticket's, saved on its own with
 * "save"). `compact` puts the select and the button on one line, for a table row.
 */
export function ChargeCreate({
  action,
  providers,
  defaultProvider,
  amount,
  compact = false,
  labels,
}: {
  action: (prev: ChargeState, fd: FormData) => Promise<ChargeState>;
  providers: { value: string; label: string }[];
  defaultProvider: string;
  amount?: { value: string; placeholder: string };
  compact?: boolean;
  labels: ChargeCreateLabels;
}) {
  const [state, formAction] = useActionState(action, null);
  const id = useId();
  const values = state?.values;
  const onlyManual = providers.length === 1 && providers[0].value === "manual";
  const select = (
    <Select
      id={`${id}-provider`}
      name="provider"
      aria-label={labels.provider}
      key={values?.provider ?? defaultProvider}
      defaultValue={values?.provider ?? defaultProvider}
      className={compact ? "!h-8 !py-1 min-w-0 flex-1 basis-32 text-[0.8125rem]" : undefined}
    >
      {providers.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </Select>
  );
  const message = state?.error ? (
    <p role="alert" className="basis-full text-[0.8125rem] font-medium text-danger">
      {state.error}
    </p>
  ) : state?.ok ? (
    <Callout tone="ok" title={state.ok} className="basis-full" />
  ) : null;

  if (compact) {
    return (
      <form action={formAction} className="flex flex-wrap items-center gap-1.5">
        {select}
        <SubmitButton variant="secondary" size="sm">
          {labels.create}
        </SubmitButton>
        {message}
      </form>
    );
  }
  return (
    <form action={formAction} className="space-y-3">
      {amount ? (
        <Field label={labels.amount} htmlFor={`${id}-amount`}>
          <Input
            id={`${id}-amount`}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={amount.placeholder}
            defaultValue={values?.amount ?? amount.value}
            key={values?.amount ?? amount.value}
          />
        </Field>
      ) : null}
      <Field label={labels.provider} htmlFor={`${id}-provider`} hint={onlyManual ? labels.manualHint : null}>
        {select}
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="ink" size="sm" name="intent" value="create">
          {labels.create}
        </SubmitButton>
        {amount && labels.save ? (
          <SubmitButton variant="secondary" size="sm" name="intent" value="save">
            {labels.save}
          </SubmitButton>
        ) : null}
        {message}
      </div>
    </form>
  );
}
