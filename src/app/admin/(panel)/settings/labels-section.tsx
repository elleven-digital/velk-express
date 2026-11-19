"use client";

import { useActionState } from "react";
import { LabelColorPicker, type LabelColorTexts } from "@/components/label-color-picker";
import { SubmitButton } from "@/components/submit-button";
import { Callout, Field, Input } from "@/components/ui";
import { Icon } from "@/components/icons";
import { fmt } from "@/lib/i18n";
import { LABEL_NAME_MAX } from "@/lib/labels";
import type { SettingsState } from "./settings-state";

type Action = (prev: SettingsState, formData: FormData) => Promise<SettingsState>;

export type LabelRow = { id: string; name: string; color: string; tickets: number };

export type LabelsTexts = {
  name: string;
  newLabel: string;
  create: string;
  color: LabelColorTexts;
  save: string;
  remove: string;
  confirmRemove: string;
  empty: string;
  ticketsOne: string;
  ticketsMany: string;
};

function Notice({ state }: { state: SettingsState }) {
  if (state?.error) return <Callout tone="danger" title={state.error} />;
  if (state?.ok) {
    return (
      <div role="status">
        <Callout tone="ok" title={state.ok} />
      </div>
    );
  }
  return null;
}

function CreateForm({ action, texts }: { action: Action; texts: LabelsTexts }) {
  const [state, run] = useActionState(action, null);
  const typed = state?.values;
  return (
    <form action={run} className="space-y-4">
      <Notice state={state} />
      <Field label={texts.newLabel} htmlFor="label-new">
        <Input
          id="label-new"
          name="name"
          required
          maxLength={LABEL_NAME_MAX}
          placeholder={texts.name}
          defaultValue={typed?.name ?? ""}
        />
      </Field>
      <div className="space-y-1.5">
        <span className="block text-[0.875rem] font-medium text-ink">{texts.color.color}</span>
        <LabelColorPicker texts={texts.color} defaultValue={typed?.color} />
      </div>
      <SubmitButton variant="secondary">
        <Icon name="plus" />
        {texts.create}
      </SubmitButton>
    </form>
  );
}

function Row({
  label,
  updateAction,
  deleteAction,
  texts,
}: {
  label: LabelRow;
  updateAction: Action;
  deleteAction: Action;
  texts: LabelsTexts;
}) {
  const [state, run] = useActionState(updateAction, null);
  const [delState, runDelete] = useActionState(deleteAction, null);
  const typed = state?.values;
  return (
    <li className="px-3 py-2">
      {state?.error || delState?.error ? (
        <div className="mb-2">
          <Notice state={state?.error ? state : delState} />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <form action={run} className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-nowrap">
          <input type="hidden" name="labelId" value={label.id} />
          <Input
            name="name"
            defaultValue={typed?.name ?? label.name}
            required
            maxLength={LABEL_NAME_MAX}
            aria-label={texts.name}
            className="!h-8 min-w-32 flex-1 !py-1"
          />
          <LabelColorPicker texts={texts.color} defaultValue={typed?.color ?? label.color} compact />
          <span className="w-20 flex-none whitespace-nowrap text-right text-[0.8125rem] text-muted tabular">
            {label.tickets === 1 ? texts.ticketsOne : fmt(texts.ticketsMany, { n: label.tickets })}
          </span>
          <SubmitButton variant="secondary" size="sm" className="flex-none">
            {texts.save}
          </SubmitButton>
        </form>
        <form
          action={runDelete}
          className="flex-none"
          onSubmit={(e) => {
            if (!window.confirm(texts.confirmRemove)) e.preventDefault();
          }}
        >
          <input type="hidden" name="labelId" value={label.id} />
          <SubmitButton
            variant="ghost"
            size="sm"
            className="w-8 !px-0 text-muted hover:text-danger"
            aria-label={`${texts.remove} ${label.name}`}
          >
            <Icon name="trash" />
          </SubmitButton>
        </form>
      </div>
    </li>
  );
}

/** The agency's labels: create one, then rename, recolor or delete each in its row. */
export function LabelsSection({
  labels,
  texts,
  createAction,
  updateAction,
  deleteAction,
}: {
  labels: LabelRow[];
  texts: LabelsTexts;
  createAction: Action;
  updateAction: Action;
  deleteAction: Action;
}) {
  return (
    <>
      <CreateForm action={createAction} texts={texts} />
      {labels.length === 0 ? (
        <p className="mt-4 text-muted">{texts.empty}</p>
      ) : (
        <ul className="mt-5 divide-y divide-line rounded-card border border-line">
          {labels.map((l) => (
            <Row key={l.id} label={l} updateAction={updateAction} deleteAction={deleteAction} texts={texts} />
          ))}
        </ul>
      )}
    </>
  );
}
