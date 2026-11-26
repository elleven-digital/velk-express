"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useActionState, useEffect } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Callout } from "@/components/ui";

export type QuoteSendState = { error?: string; ok?: string } | null;
export type QuoteSendLabels = { send: string; hint: string };

/**
 * "Send" / "Resend": marks the quote as sent, then says who got the e-mail. The public link is the
 * page's own (it shows once the quote is sent), so it is not repeated here; a "Saved" notice left in
 * the address by the save that led here goes away.
 */
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
  const router = useRouter();
  const pathname = usePathname();
  const hasNotice = useSearchParams().has("ok");
  useEffect(() => {
    if (state?.ok && hasNotice) router.replace(pathname, { scroll: false });
  }, [state, hasNotice, router, pathname]);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="quoteId" value={quoteId} />
      <p className="text-[0.8125rem] text-muted">{labels.hint}</p>
      <SubmitButton variant="secondary" size="sm">
        {labels.send}
      </SubmitButton>
      {state?.error ? <Callout tone="danger" title={state.error} /> : null}
      {state?.ok ? <Callout tone="ok" title={state.ok} /> : null}
    </form>
  );
}
