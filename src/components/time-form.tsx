"use client";

import { useActionState } from "react";
import type { MessageActionState } from "./chat";
import { Icon } from "./icons";
import { SubmitButton } from "./submit-button";
import { Field, Input } from "./ui";

export type TimeFormLabels = {
  open: string;
  time: string;
  hint: string;
  date: string;
  note: string;
  submit: string;
};

/**
 * "Log time": a collapsed form (time as typed, day, what was done). A refusal comes back with what
 * was typed, so nothing is lost; a success clears the form. `today` is the day in the cycle time
 * zone: the default and the latest day the date can take.
 */
export function TimeForm({
  action,
  today,
  labels,
}: {
  action: (prev: MessageActionState, fd: FormData) => Promise<MessageActionState>;
  today: string;
  labels: TimeFormLabels;
}) {
  const [state, formAction] = useActionState(action, null);
  const values = state?.values;
  return (
    // open again after a refusal, so the message and the typed values are in view
    <details className="group/log" open={state?.error ? true : undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.875rem] font-medium text-ink hover:underline underline-offset-[3px] [&::-webkit-details-marker]:hidden">
        <Icon name="plus" size={14} />
        {labels.open}
      </summary>
      <form action={formAction} className="mt-3 space-y-3">
        <Field label={labels.time} htmlFor="log-duration" hint={labels.hint}>
          <Input
            id="log-duration"
            name="duration"
            required
            autoComplete="off"
            placeholder="1h30"
            defaultValue={values?.duration ?? ""}
          />
        </Field>
        <Field label={labels.date} htmlFor="log-date">
          <Input id="log-date" name="workedOn" type="date" required max={today} defaultValue={values?.workedOn ?? today} />
        </Field>
        <Field label={labels.note} htmlFor="log-note">
          <Input id="log-note" name="note" maxLength={500} defaultValue={values?.note ?? ""} />
        </Field>
        {state?.error ? (
          <p role="alert" className="text-[0.8125rem] font-medium text-danger">
            {state.error}
          </p>
        ) : null}
        <SubmitButton variant="secondary" size="sm" className="w-full">
          {labels.submit}
        </SubmitButton>
      </form>
    </details>
  );
}
