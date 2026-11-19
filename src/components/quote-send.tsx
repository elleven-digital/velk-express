"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/link-box";
import { SubmitButton } from "@/components/submit-button";
import { Callout } from "@/components/ui";

export type QuoteSendState = { error?: string; ok?: string; link?: string } | null;
export type QuoteSendLabels = { send: string; hint: string; copyLink: string; copied: string };

/** "Send" / "Resend": marks the quote as sent, then says who got the e-mail and offers the public link to copy. */
export function QuoteSend({
  action,
  quoteId,
  labels,
}: {
  action: (prev: QuoteSendState, formData: FormData) => Promise<QuoteSendState>;
  quoteId: string;
  labels: QuoteSendLabels;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="quoteId" value={quoteId} />
      <p className="text-[0.8125rem] text-muted">{labels.hint}</p>
      <SubmitButton variant="secondary" size="sm">
        {labels.send}
      </SubmitButton>
      {state?.error ? <Callout tone="danger" title={state.error} /> : null}
      {state?.ok ? (
        <div role="status" className="space-y-2 text-[0.875rem]">
          <p className="font-medium text-ink">{state.ok}</p>
          {state.link ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                readOnly
                aria-label={state.link}
                value={state.link}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 basis-48 rounded-field border border-line bg-white px-3 py-[7px] font-mono text-[0.8125rem] text-ink"
              />
              <CopyButton text={state.link} label={labels.copyLink} copiedLabel={labels.copied} />
            </div>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
