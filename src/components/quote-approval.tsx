"use client";

import { useState, type ReactNode } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Card } from "@/components/ui";
import type { Currency } from "@/lib/core/settings";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/lib/i18n";

export type ApprovalItem = { id: string; amountCents: number; monthly: boolean; row: ReactNode };

/**
 * The client's choice on a sent quote: every item starts ticked, the summary adds up only the
 * ticked ones as they change, and confirming needs at least one (the server refuses none too).
 */
export function QuoteApprovalForm({
  action,
  token,
  version,
  items,
  currency,
  locale,
  labels,
}: {
  action: (formData: FormData) => void | Promise<void>;
  token: string;
  version: string;
  items: ApprovalItem[];
  currency: Currency;
  locale: Locale;
  labels: { summary: string; oneTimeTotal: string; monthlyTotal: string; perMonth: string; selectHint: string; confirm: string };
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));
  const chosen = items.filter((i) => picked.has(i.id));
  const oneTimeCents = chosen.filter((i) => !i.monthly).reduce((sum, i) => sum + i.amountCents, 0);
  const monthlyCents = chosen.filter((i) => i.monthly).reduce((sum, i) => sum + i.amountCents, 0);
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="version" value={version} />
      <Card className="divide-y divide-line">
        {items.map((item) => (
          <label key={item.id} className="flex items-start gap-3 px-4 py-3 cursor-pointer">
            <input
              type="checkbox"
              name="itemId"
              value={item.id}
              checked={picked.has(item.id)}
              onChange={(e) => toggle(item.id, e.target.checked)}
              className="mt-1 size-4 accent-ink flex-none"
            />
            {item.row}
          </label>
        ))}
      </Card>

      <Card className="mt-6 px-4 py-3">
        <div className="text-[0.8125rem] font-medium text-muted mb-2">{labels.summary}</div>
        <dl className="space-y-1 text-[0.875rem]" aria-live="polite">
          {oneTimeCents > 0 || monthlyCents === 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{labels.oneTimeTotal}</dt>
              <dd className="font-medium text-ink tabular-nums">{money(oneTimeCents)}</dd>
            </div>
          ) : null}
          {monthlyCents > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{labels.monthlyTotal}</dt>
              <dd className="font-medium text-ink tabular-nums">
                {money(monthlyCents)}
                <span className="text-muted font-normal">{labels.perMonth}</span>
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>

      <div className="mt-6">
        <p className="text-[0.8125rem] text-muted mb-3">{labels.selectHint}</p>
        <SubmitButton size="lg" className="max-sm:w-full" disabled={chosen.length === 0}>
          {labels.confirm}
        </SubmitButton>
      </div>
    </form>
  );
}
