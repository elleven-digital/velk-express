"use client";

import { useActionState, useState } from "react";
import { LinkBox, type LinkActionState, type LinkBoxLabels } from "@/components/link-box";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Callout, buttonClasses, Card, EmptyState, Field, Input, SectionTitle, Select } from "@/components/ui";
import type { ClientRole } from "@/lib/db";
import { fmt } from "@/lib/i18n";

type Action = (prev: LinkActionState, formData: FormData) => Promise<LinkActionState>;

/** The people of one company, as the server read them. */
export type PanelUser = { id: string; name: string; email: string; role: ClientRole; pending: boolean };

/** Actions already bound to the company (and to whoever is acting): the panel only sends the person's id and the fields. */
export type PortalUsersActions = {
  invite: Action;
  setRole: Action;
  remove: Action;
  resend: Action;
  /** Only given on the team side: a portal admin cannot issue reset links. */
  resetLink?: Action;
};

export type PortalUsersLabels = LinkBoxLabels & {
  listTitle: string;
  empty: string;
  inviteTitle: string;
  inviteButton: string;
  name: string;
  email: string;
  role: string;
  roles: Record<ClientRole, string>;
  rolesHint: string;
  pending: string;
  saveRole: string;
  resendInvite: string;
  resetLink: string;
  remove: string;
  confirmRemove: string;
  /** Marks the signed-in person in the list ("you"). */
  you: string;
  /** The team-side confirmation before an existing login is linked; the portal never shows it. */
  confirm?: {
    title: string;
    companies: string;
    pending: string;
    active: string;
    admin: string;
    activeWarning: string;
    link: string;
    cancel: string;
  };
};

const ROLES: ClientRole[] = ["admin", "collaborator"];

function Errors({ states }: { states: LinkActionState[] }) {
  return states.map((s, i) =>
    s?.error ? (
      <div key={i} className="mt-2">
        <Callout tone="danger" title={s.error} />
      </div>
    ) : null,
  );
}

function InviteForm({ action, labels }: { action: Action; labels: PortalUsersLabels }) {
  const [state, formAction] = useActionState(action, null);
  const [dismissed, setDismissed] = useState<unknown>(null);
  const confirm = labels.confirm && state?.confirm && dismissed !== state ? state.confirm : null;

  if (confirm && labels.confirm) {
    // The form resets after every submit, so the typed values travel back as hidden fields.
    return (
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="name" value={confirm.typed.name} />
        <input type="hidden" name="email" value={confirm.typed.email} />
        <input type="hidden" name="role" value={confirm.typed.role} />
        <input type="hidden" name="confirmLinkOf" value={confirm.clientUserId} />
        <input type="hidden" name="confirmActive" value={confirm.active ? "1" : "0"} />
        <input type="hidden" name="confirmWillBeAdmin" value={confirm.willBeAdmin ? "1" : "0"} />
        <Callout tone="warn" title={fmt(labels.confirm.title, { name: confirm.name })}>
          <p className="text-muted">{confirm.typed.email}</p>
          <p className="mt-2">{labels.confirm.companies}</p>
          <ul className="mt-1 list-disc pl-5">
            {confirm.companies.map((c, i) => (
              <li key={i}>
                {c.name} ({labels.roles[c.role]})
              </li>
            ))}
          </ul>
          <p className="mt-2">{confirm.active ? labels.confirm.active : labels.confirm.pending}</p>
          {confirm.willBeAdmin ? <p className="mt-1">{labels.confirm.admin}</p> : null}
          {confirm.active ? (
            <p className="mt-2 font-medium">{fmt(labels.confirm.activeWarning, { client: confirm.clientName })}</p>
          ) : null}
        </Callout>
        <div className="flex flex-wrap gap-2">
          <SubmitButton>{labels.confirm.link}</SubmitButton>
          <button type="button" className={buttonClasses("secondary", "md")} onClick={() => setDismissed(state)}>
            {labels.confirm.cancel}
          </button>
        </div>
      </form>
    );
  }

  const v = state?.values;
  return (
    <form action={formAction} className="space-y-4">
      <Field label={labels.name} htmlFor="pu-name">
        <Input id="pu-name" name="name" required maxLength={120} autoComplete="off" defaultValue={v?.name ?? ""} />
      </Field>
      <Field label={labels.email} htmlFor="pu-email">
        <Input id="pu-email" name="email" type="email" required maxLength={254} autoComplete="off" defaultValue={v?.email ?? ""} />
      </Field>
      <Field label={labels.role} htmlFor="pu-role" hint={labels.rolesHint}>
        <Select key={v?.role} id="pu-role" name="role" defaultValue={v?.role ?? "collaborator"}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {labels.roles[r]}
            </option>
          ))}
        </Select>
      </Field>
      <Errors states={[state]} />
      <SubmitButton className="w-full">{labels.inviteButton}</SubmitButton>
      {state?.ok && !state.link ? (
        <p role="status" className="text-[0.875rem] font-medium text-ink">
          {state.ok}
        </p>
      ) : null}
      <LinkBox state={state} labels={labels} />
    </form>
  );
}

/** One person's controls. Each form keeps its own state, so each can show its own link or error. */
function UserControls({ user, actions, labels }: { user: PanelUser; actions: PortalUsersActions; labels: PortalUsersLabels }) {
  const linkAction = user.pending ? actions.resend : actions.resetLink;
  const [roleState, roleFormAction] = useActionState(actions.setRole, null);
  const [linkState, linkFormAction] = useActionState(linkAction ?? actions.resend, null);
  const [removeState, removeFormAction] = useActionState(actions.remove, null);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <form action={roleFormAction} className="flex items-center gap-2">
          <input type="hidden" name="clientUserId" value={user.id} />
          <Select name="role" defaultValue={user.role} aria-label={`${labels.role}: ${user.name}`} className="h-8 !w-auto !py-1">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {labels.roles[r]}
              </option>
            ))}
          </Select>
          <SubmitButton variant="secondary" size="sm">
            {labels.saveRole}
          </SubmitButton>
        </form>
        {linkAction ? (
          <form action={linkFormAction}>
            <input type="hidden" name="clientUserId" value={user.id} />
            <input type="hidden" name="name" value={user.name} />
            <input type="hidden" name="email" value={user.email} />
            <SubmitButton variant="secondary" size="sm">
              {user.pending ? labels.resendInvite : labels.resetLink}
            </SubmitButton>
          </form>
        ) : null}
        <form
          action={removeFormAction}
          onSubmit={(e) => {
            if (!window.confirm(fmt(labels.confirmRemove, { name: user.name }))) e.preventDefault();
          }}
        >
          <input type="hidden" name="clientUserId" value={user.id} />
          <SubmitButton variant="ghost" size="sm" className="text-muted hover:text-danger">
            {labels.remove}
          </SubmitButton>
        </form>
      </div>
      <Errors states={[roleState, linkState, removeState]} />
      {roleState?.ok ? (
        <p role="status" className="mt-2 text-[0.875rem] font-medium text-ink">
          {roleState.ok}
        </p>
      ) : null}
      <LinkBox state={linkState} labels={labels} />
    </div>
  );
}

/**
 * The people with access to one company and the form to add more: shared by the client's Access
 * tab (team) and the portal's Users page (company admins). Both pass actions that already know
 * the company, so nothing here chooses which company is being managed.
 */
export function PortalUsersPanel({
  users,
  actions,
  labels,
  currentUserId,
}: {
  users: PanelUser[];
  actions: PortalUsersActions;
  labels: PortalUsersLabels;
  /** The portal person looking at the list: marked "you", with no controls over themselves. */
  currentUserId?: string;
}) {
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <SectionTitle className="mb-3">{labels.listTitle}</SectionTitle>
        {users.length === 0 ? (
          <Card>
            <EmptyState icon="users" title={labels.empty} />
          </Card>
        ) : (
          <Card className="divide-y divide-line">
            {users.map((user) => (
              <div key={user.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="truncate font-medium text-ink">
                      {user.name}
                      {user.id === currentUserId ? <span className="font-normal text-muted"> · {labels.you}</span> : null}
                    </div>
                    <div className="truncate text-muted">{user.email}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {user.pending ? <Badge tone="warn">{labels.pending}</Badge> : null}
                    <Badge tone={user.role === "admin" ? "ink" : "lav"}>{labels.roles[user.role]}</Badge>
                  </div>
                </div>
                {user.id === currentUserId ? null : (
                  <div className="mt-3">
                    <UserControls user={user} actions={actions} labels={labels} />
                  </div>
                )}
              </div>
            ))}
          </Card>
        )}
      </div>

      <Card className="p-6 max-sm:p-4 lg:sticky lg:top-6">
        <SectionTitle className="mb-4">{labels.inviteTitle}</SectionTitle>
        <InviteForm action={actions.invite} labels={labels} />
      </Card>
    </div>
  );
}
