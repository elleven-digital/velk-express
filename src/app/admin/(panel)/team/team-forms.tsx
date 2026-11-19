"use client";

import { useActionState } from "react";
import { LinkBox } from "@/components/link-box";
import { Callout, Checkbox, Field, Input, Select } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { fmt } from "@/lib/i18n";
import type { UserRole } from "@/lib/db";
import type { TeamState } from "./team-state";

type Action = (prev: TeamState, formData: FormData) => Promise<TeamState>;

export type TeamLabels = {
  role: string;
  roles: Record<UserRole, string>;
  inviteButton: string;
  rolesHint: string;
  name: string;
  email: string;
  saveRole: string;
  resendInvite: string;
  resetLink: string;
  remove: string;
  confirmRemove: string;
  linkTitle: string;
  linkHint: string;
  expiresInvite: string;
  expiresReset: string;
  emailSent: string;
  emailNotSent: string;
  copyLink: string;
  copiedLink: string;
  clientsOf: string;
  noClientsYet: string;
  saveClients: string;
};

function Notice({ state }: { state: TeamState }) {
  if (state?.error) return <Callout tone="danger" title={state.error} />;
  return null;
}

export function InviteForm({ action, labels }: { action: Action; labels: TeamLabels }) {
  const [state, formAction] = useActionState(action, null);
  const v = state?.values;
  return (
    <form action={formAction} className="space-y-4">
      <Field label={labels.name} htmlFor="tm-name">
        <Input id="tm-name" name="name" required maxLength={120} autoComplete="off" defaultValue={v?.name ?? ""} />
      </Field>
      <Field label={labels.email} htmlFor="tm-email">
        <Input id="tm-email" name="email" type="email" required maxLength={254} autoComplete="off" defaultValue={v?.email ?? ""} />
      </Field>
      <Field label={labels.role} htmlFor="tm-role" hint={labels.rolesHint}>
        <Select key={v?.role} id="tm-role" name="role" defaultValue={v?.role ?? "collaborator"}>
          {(Object.keys(labels.roles) as UserRole[]).map((r) => (
            <option key={r} value={r}>
              {labels.roles[r]}
            </option>
          ))}
        </Select>
      </Field>
      <Notice state={state} />
      <SubmitButton className="w-full">{labels.inviteButton}</SubmitButton>
      <LinkBox state={state} labels={labels} />
    </form>
  );
}

export type MemberView = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  pending: boolean;
  isMe: boolean;
  /** Clients this member takes part in. */
  clientIds: string[];
};

export type MemberActions = {
  changeRole: Action;
  resendInvite: Action;
  resetLink: Action;
  remove: Action;
  setClients: Action;
};

/** One member's controls. Forms keep their own state so each can show its link or error. */
export function MemberControls({
  member,
  actions,
  labels,
  clients,
}: {
  member: MemberView;
  actions: MemberActions;
  labels: TeamLabels;
  clients: { id: string; name: string }[];
}) {
  const [linkState, linkFormAction] = useActionState(member.pending ? actions.resendInvite : actions.resetLink, null);
  const [roleState, roleFormAction] = useActionState(actions.changeRole, null);
  const [removeState, removeFormAction] = useActionState(actions.remove, null);
  const [clientsState, clientsFormAction] = useActionState(actions.setClients, null);
  const taking = new Set(member.clientIds);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {member.isMe ? null : (
          <form action={roleFormAction} className="flex items-center gap-2">
            <input type="hidden" name="userId" value={member.id} />
            <Select
              name="role"
              defaultValue={member.role}
              aria-label={`${labels.role}: ${member.name}`}
              className="h-8 !w-auto !py-1"
            >
              {(Object.keys(labels.roles) as UserRole[]).map((r) => (
                <option key={r} value={r}>
                  {labels.roles[r]}
                </option>
              ))}
            </Select>
            <SubmitButton variant="secondary" size="sm">
              {labels.saveRole}
            </SubmitButton>
          </form>
        )}
        {member.isMe ? null : (
          <form action={linkFormAction}>
            <input type="hidden" name="userId" value={member.id} />
            <input type="hidden" name="name" value={member.name} />
            <input type="hidden" name="email" value={member.email} />
            <SubmitButton variant="secondary" size="sm">
              {member.pending ? labels.resendInvite : labels.resetLink}
            </SubmitButton>
          </form>
        )}
        {member.isMe ? null : (
          <form
            action={removeFormAction}
            onSubmit={(e) => {
              if (!window.confirm(fmt(labels.confirmRemove, { name: member.name }))) e.preventDefault();
            }}
          >
            <input type="hidden" name="userId" value={member.id} />
            <SubmitButton variant="ghost" size="sm" className="text-muted hover:text-danger">
              {labels.remove}
            </SubmitButton>
          </form>
        )}
      </div>
      {member.role === "collaborator" ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[0.875rem] font-medium text-ink">
            {labels.clientsOf} ({member.clientIds.length})
          </summary>
          <form action={clientsFormAction} className="mt-3 space-y-3">
            <input type="hidden" name="userId" value={member.id} />
            {clients.length === 0 ? (
              <p className="text-muted">{labels.noClientsYet}</p>
            ) : (
              <div className="space-y-2.5">
                {clients.map((c) => (
                  <Checkbox key={c.id} name="clientIds" value={c.id} defaultChecked={taking.has(c.id)} label={c.name} />
                ))}
              </div>
            )}
            <div className="flex items-center gap-3">
              <SubmitButton variant="secondary" size="sm">
                {labels.saveClients}
              </SubmitButton>
              {clientsState?.ok ? (
                <span role="status" className="text-[0.875rem] font-medium text-ink">
                  {clientsState.ok}
                </span>
              ) : null}
            </div>
          </form>
        </details>
      ) : null}
      {[roleState, linkState, removeState, clientsState].map((s, i) =>
        s?.error ? (
          <div key={i} className="mt-2">
            <Callout tone="danger" title={s.error} />
          </div>
        ) : null,
      )}
      <LinkBox state={linkState} labels={labels} />
    </div>
  );
}
