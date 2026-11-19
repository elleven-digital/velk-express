"use client";

import { useActionState } from "react";
import type { ClientState } from "@/app/admin/(panel)/clients/client-state";
import { Icon } from "./icons";
import { SubmitButton } from "./submit-button";
import { Field, Input } from "./ui";

export type PurchaseFormLabels = {
  time: string;
  hint: string;
  price: string;
  note: string;
  purchaseFor: string;
  add: string;
};

/**
 * "Register purchased hours": time as typed, optional price and note, for the cycle on screen.
 * A refusal comes back with what was typed; a success clears the form.
 */
export function PurchaseForm({
  action,
  cycle,
  cycleLabel,
  placeholder,
  labels,
}: {
  action: (prev: ClientState, fd: FormData) => Promise<ClientState>;
  cycle: string;
  cycleLabel: string;
  placeholder: string;
  labels: PurchaseFormLabels;
}) {
  const [state, formAction] = useActionState(action, null);
  const values = state?.values;
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="cycle" value={cycle} />
      <Field label={labels.time} htmlFor="hp-duration" hint={labels.hint}>
        <Input id="hp-duration" name="duration" required autoComplete="off" placeholder="10h" defaultValue={values?.duration ?? ""} />
      </Field>
      <Field label={labels.price} htmlFor="hp-price">
        <Input id="hp-price" name="price" inputMode="decimal" autoComplete="off" placeholder={placeholder} defaultValue={values?.price ?? ""} />
      </Field>
      <Field label={labels.note} htmlFor="hp-note">
        <Input id="hp-note" name="note" maxLength={500} defaultValue={values?.note ?? ""} />
      </Field>
      <p className="text-[0.8125rem] text-muted">
        {labels.purchaseFor}: <span className="font-medium text-ink">{cycleLabel}</span>
      </p>
      {state?.error ? (
        <p role="alert" className="text-[0.8125rem] font-medium text-danger">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-full" size="sm">
        <Icon name="plus" />
        {labels.add}
      </SubmitButton>
    </form>
  );
}
