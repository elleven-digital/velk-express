"use client";

import { useActionState } from "react";
import { LinkBox, type LinkActionState, type LinkBoxLabels } from "@/components/link-box";
import { SubmitButton } from "@/components/submit-button";
import { Callout, SectionTitle } from "@/components/ui";

export type QuoteExecuteLabels = {
  section: string;
  hint: string;
  button: string;
  confirm: string;
  link: LinkBoxLabels;
};

/**
 * "Close this quote": the form the item checkboxes belong to, and what the execution returned (an
 * error, or the done note with the invite link of a new portal login). It stays mounted after the
 * quote is executed, so the link survives the page refresh; only the form goes away.
 */
export function QuoteExecute({
  action,
  quoteId,
  formId,
  executable,
  labels,
}: {
  action: (prev: LinkActionState, formData: FormData) => Promise<LinkActionState>;
  quoteId: string;
  /** The id the item checkboxes point at (`form=`), so they can live in the item list. */
  formId: string;
  executable: boolean;
  labels: QuoteExecuteLabels;
}) {
  const [state, formAction] = useActionState(action, null);
  if (!executable && !state) return null;
  return (
    <div className="space-y-3 border-t border-line px-5 py-4">
      {executable ? (
        <form
          id={formId}
          action={formAction}
          onSubmit={(e) => {
            if (!window.confirm(labels.confirm)) e.preventDefault();
          }}
          className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3"
        >
          <input type="hidden" name="quoteId" value={quoteId} />
          <div className="min-w-0 max-w-prose">
            <SectionTitle>{labels.section}</SectionTitle>
            <p className="mt-1 text-[0.8125rem] text-muted">{labels.hint}</p>
          </div>
          <SubmitButton>{labels.button}</SubmitButton>
        </form>
      ) : null}
      {state?.error ? <Callout tone="danger" title={state.error} /> : null}
      {state?.ok && !state.link ? <Callout tone="ok" title={state.ok} /> : null}
      <LinkBox state={state} labels={labels.link} />
    </div>
  );
}
