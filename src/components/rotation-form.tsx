"use client";

import { useActionState } from "react";
import { Callout, Checkbox } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

type State = { error?: string; ok?: string } | null;

/**
 * The round robin of one client (with its `clientId`) or of the whole agency
 * (without): a switch and who takes part. Ticking nobody leaves it off.
 */
export function RotationForm({
  action,
  clientId,
  enabled,
  selected,
  people,
  labels,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  clientId?: string;
  enabled: boolean;
  selected: string[];
  people: { id: string; name: string; email: string }[];
  labels: { toggle: string; who: string; none: string; save: string };
}) {
  const [state, formAction] = useActionState(action, null);
  const chosen = new Set(selected);
  return (
    <form action={formAction} className="space-y-5">
      {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
      <Checkbox name="enabled" defaultChecked={enabled} label={labels.toggle} />
      <div>
        <div className="mb-2.5 text-[0.875rem] font-medium text-ink">{labels.who}</div>
        {people.length === 0 ? (
          <p className="text-muted">{labels.none}</p>
        ) : (
          <div className="space-y-2.5">
            {people.map((p) => (
              <Checkbox key={p.id} name="userIds" value={p.id} defaultChecked={chosen.has(p.id)} label={p.name} hint={p.email} />
            ))}
          </div>
        )}
      </div>
      {state?.error ? <Callout tone="danger" title={state.error} /> : null}
      {state?.ok ? <Callout tone="ok" title={state.ok} /> : null}
      <div className="flex justify-end">
        <SubmitButton size="sm">{labels.save}</SubmitButton>
      </div>
    </form>
  );
}
