"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { ChargeState } from "@/app/admin/(panel)/charges/charge-state";
import { SubmitButton } from "./submit-button";
import { buttonClasses, Field, Input, Select } from "./ui";

export type ChargeNewLabels = {
  client: string;
  pickClient: string;
  label: string;
  amount: string;
  kind: string;
  kindOneTime: string;
  kindMonthly: string;
  provider: string;
  create: string;
  cancel: string;
  manualHint: string;
};

type Kind = "one_time" | "subscription";

/**
 * "New charge": client, what it is for, amount, one-time or monthly, and the provider. The
 * providers offered follow the kind and whether the client has an e-mail; the default is the
 * agency's when it is among them.
 */
export function ChargeNewForm({
  action,
  clients,
  matrix,
  defaultProvider,
  providerLabels,
  placeholder,
  initialClientId,
  labels,
}: {
  action: (prev: ChargeState, fd: FormData) => Promise<ChargeState>;
  clients: { id: string; name: string; hasEmail: boolean }[];
  matrix: Record<Kind, { withEmail: string[]; withoutEmail: string[] }>;
  defaultProvider: string | null;
  providerLabels: Record<string, string>;
  placeholder: string;
  initialClientId: string;
  labels: ChargeNewLabels;
}) {
  const [state, formAction] = useActionState(action, null);
  const values = state?.values;
  const [clientId, setClientId] = useState(values?.clientId ?? initialClientId);
  const [kind, setKind] = useState<Kind>(values?.kind === "subscription" ? "subscription" : "one_time");
  const [provider, setProvider] = useState(values?.provider ?? "");

  const hasEmail = clients.find((c) => c.id === clientId)?.hasEmail ?? false;
  const offered = hasEmail ? matrix[kind].withEmail : matrix[kind].withoutEmail;
  const preselected = defaultProvider && offered.includes(defaultProvider) ? defaultProvider : offered[0];
  const chosen = offered.includes(provider) ? provider : preselected;
  const onlyManual = offered.length === 1 && offered[0] === "manual";

  return (
    <form action={formAction} className="space-y-5">
      <Field label={labels.client} htmlFor="nc-client">
        <Select id="nc-client" name="clientId" required value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">{labels.pickClient}…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={labels.label} htmlFor="nc-label">
        <Input id="nc-label" name="label" required maxLength={200} autoComplete="off" defaultValue={values?.label ?? ""} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={labels.amount} htmlFor="nc-amount">
          <Input id="nc-amount" name="amount" required inputMode="decimal" autoComplete="off" placeholder={placeholder} defaultValue={values?.amount ?? ""} />
        </Field>
        <Field label={labels.kind} htmlFor="nc-kind">
          <Select id="nc-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="one_time">{labels.kindOneTime}</option>
            <option value="subscription">{labels.kindMonthly}</option>
          </Select>
        </Field>
      </div>
      <Field label={labels.provider} htmlFor="nc-provider" hint={onlyManual ? labels.manualHint : null}>
        <Select id="nc-provider" name="provider" value={chosen} onChange={(e) => setProvider(e.target.value)}>
          {offered.map((p) => (
            <option key={p} value={p}>
              {providerLabels[p]}
            </option>
          ))}
        </Select>
      </Field>
      {state?.error ? (
        <p role="alert" className="text-[0.8125rem] font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="ink">{labels.create}</SubmitButton>
        <Link href="/admin/charges" className={buttonClasses("ghost", "md")}>
          {labels.cancel}
        </Link>
      </div>
    </form>
  );
}
