"use client";

import { useActionState } from "react";
import { Callout, Card, Checkbox, Field, Input, SectionTitle, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import type { Dict } from "@/lib/i18n";
import { fmt } from "@/lib/i18n";
import type { ClientState } from "./client-state";

type Action = (prev: ClientState, formData: FormData) => Promise<ClientState>;
export type ClientLabels = Dict["clients"];

/** The answer to the last submit of one form: what went wrong, or that it was saved. */
function Notice({ state }: { state: ClientState }) {
  if (state?.error) return <Callout tone="danger" title={state.error} />;
  if (state?.ok) {
    return (
      <div role="status" className="text-[0.875rem] font-medium text-ink">
        {state.ok}
      </div>
    );
  }
  return null;
}

/** A settings box: its title, an optional line on what it does, then the form. */
export function SettingsCard({
  title,
  hint,
  children,
  className,
  id,
}: {
  id?: string;
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card id={id} className={cn("p-5 sm:p-6 scroll-mt-6", className)}>
      <SectionTitle>{title}</SectionTitle>
      {hint ? <p className="mt-1 max-w-[62ch] text-muted">{hint}</p> : null}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

type Company = { name: string; email: string | null; phone: string | null; notes: string | null };

/** Company data: creates a client when there is no `clientId`, edits it otherwise. */
export function CompanyForm({
  action,
  labels,
  clientId,
  company,
}: {
  action: Action;
  labels: ClientLabels;
  clientId?: string;
  company?: Company;
}) {
  const [state, formAction] = useActionState(action, null);
  const opt = (label: string) => (clientId ? label : `${label} (${labels.optional})`);
  const id = clientId ? "c" : "new";
  return (
    // email and phone pair up when the card, not the window, is wide enough
    <form action={formAction} className="@container space-y-4">
      {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
      <Field label={labels.companyName} htmlFor={`${id}-name`}>
        <Input id={`${id}-name`} name="name" defaultValue={state?.values?.name ?? company?.name ?? ""} required maxLength={120} autoFocus={!clientId} />
      </Field>
      <div className="grid gap-4 @md:grid-cols-2">
        <Field label={opt(labels.contactEmail)} htmlFor={`${id}-email`}>
          <Input id={`${id}-email`} name="email" type="email" defaultValue={state?.values?.email ?? company?.email ?? ""} maxLength={254} />
        </Field>
        <Field label={opt(labels.phone)} htmlFor={`${id}-phone`}>
          <Input id={`${id}-phone`} name="phone" defaultValue={state?.values?.phone ?? company?.phone ?? ""} maxLength={40} />
        </Field>
      </div>
      <Field label={opt(labels.notes)} htmlFor={`${id}-notes`}>
        <Textarea id={`${id}-notes`} name="notes" rows={3} defaultValue={state?.values?.notes ?? company?.notes ?? ""} maxLength={5000} />
      </Field>
      <Notice state={state} />
      <div className={cn("flex", clientId ? "justify-end" : "max-sm:*:w-full sm:justify-end")}>
        <SubmitButton variant={clientId ? "secondary" : "primary"} size={clientId ? "sm" : "md"}>
          {clientId ? labels.save : labels.create}
        </SubmitButton>
      </div>
    </form>
  );
}

export type SiteView = { id: string; name: string; url: string | null; notes: string | null; includedInSupport: boolean };

export function SupportForm({
  action,
  labels,
  clientId,
  currency,
  support,
  monthlyValue,
  hours,
  placeholder,
  sites,
  supportToggleHint,
}: {
  action: Action;
  labels: ClientLabels;
  clientId: string;
  currency: string;
  support: { active: boolean; generalTickets: boolean; hoursMode: "off" | "internal" | "package" };
  monthlyValue: string;
  /** The saved package, as the fields show it: decimal hours and the money text. */
  hours: { included: string; extraValue: string };
  placeholder: string;
  sites: SiteView[];
  /** Shown under the support switch while a monthly charge is billing: turning support off does not cancel it. */
  supportToggleHint?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const v = state?.values;
  const ticked = new Set(v?.siteIds ? v.siteIds.split(",") : []);
  const mode = v?.hoursMode ?? support.hoursMode;
  const modes = [
    { value: "off", label: labels.hoursOff, hint: undefined },
    { value: "internal", label: labels.hoursInternal, hint: labels.hoursInternalHint },
    { value: "package", label: labels.hoursToggle, hint: labels.hoursHint },
  ];
  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="clientId" value={clientId} />
      <Checkbox name="supportActive" defaultChecked={v ? v.supportActive === "on" : support.active} label={labels.supportToggle} hint={supportToggleHint} />
      <Field label={`${fmt(labels.monthlyValue, { currency })} (${labels.optional})`} htmlFor="s-monthly">
        <Input id="s-monthly" name="monthly" inputMode="decimal" defaultValue={v?.monthly ?? monthlyValue} placeholder={placeholder} className="max-w-48" />
      </Field>
      {/* the package fields show only while "package" is picked: CSS, so no client code */}
      <fieldset className="group/hours space-y-2.5">
        <legend className="mb-2.5 text-[0.875rem] font-medium text-ink">{labels.hoursMode}</legend>
        {modes.map((m) => (
          <label key={m.value} className="group flex cursor-pointer items-start gap-3">
            <input type="radio" name="hoursMode" value={m.value} defaultChecked={mode === m.value} className="mt-0.5 size-4 accent-brand" />
            <span>
              <span className="block text-[0.875rem] font-medium text-ink">{m.label}</span>
              {m.hint ? <span className="mt-0.5 block text-[0.8125rem] text-muted">{m.hint}</span> : null}
            </span>
          </label>
        ))}
        <div className="hidden space-y-4 pl-7 pt-2 group-has-[[value=package]:checked]/hours:block">
          <Field label={labels.includedHours} htmlFor="s-included">
            <Input
              id="s-included"
              name="includedHours"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              defaultValue={v?.includedHours ?? hours.included}
              className="max-w-48"
            />
          </Field>
          <Field
            label={`${fmt(labels.extraHourValue, { currency })} (${labels.optional})`}
            htmlFor="s-extra"
            hint={labels.extraHourHint}
          >
            <Input id="s-extra" name="extraHourValue" inputMode="decimal" defaultValue={v?.extraHourValue ?? hours.extraValue} placeholder={placeholder} className="max-w-48" />
          </Field>
        </div>
      </fieldset>
      <Checkbox name="generalTickets" defaultChecked={v ? v.generalTickets === "on" : support.generalTickets} label={labels.generalToggle} hint={labels.generalHint} />
      <div>
        <div className="mb-2.5 text-[0.875rem] font-medium text-ink">{labels.sitesInSupport}</div>
        {sites.length === 0 ? (
          <p className="text-muted">{labels.noSitesYet}</p>
        ) : (
          <div className="space-y-2.5">
            {sites.map((site) => (
              <Checkbox
                key={site.id}
                name="siteIds"
                value={site.id}
                defaultChecked={v ? ticked.has(site.id) : site.includedInSupport}
                label={site.name}
                hint={site.url ?? undefined}
              />
            ))}
          </div>
        )}
      </div>
      <Notice state={state} />
      <div className="flex justify-end">
        <SubmitButton size="sm">{labels.save}</SubmitButton>
      </div>
    </form>
  );
}

/** The site's name, and its address as a link that opens it. */
export function SiteName({ site }: { site: Pick<SiteView, "name" | "url"> }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-medium text-ink">{site.name}</div>
      {site.url ? (
        <a
          href={site.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1 text-muted transition-colors hover:text-ink"
        >
          <span className="truncate">{site.url.replace(/^https?:\/\//, "")}</span>
          <Icon name="ext" size={14} />
        </a>
      ) : null}
    </div>
  );
}

export function AddSiteForm({
  action,
  labels,
  clientId,
  supportActive,
}: {
  action: Action;
  labels: ClientLabels;
  clientId: string;
  supportActive: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const v = state?.values;
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="clientId" value={clientId} />
      <Field label={labels.siteName} htmlFor="new-site-name">
        <Input id="new-site-name" name="name" required maxLength={120} placeholder="cafe-aurora.com" defaultValue={v?.name ?? ""} />
      </Field>
      <Field label={`${labels.siteUrl} (${labels.optional})`} htmlFor="new-site-url">
        <Input id="new-site-url" name="url" maxLength={2048} placeholder="https://" defaultValue={v?.url ?? ""} />
      </Field>
      <Field label={`${labels.notes} (${labels.optional})`} htmlFor="new-site-notes">
        <Input id="new-site-notes" name="notes" maxLength={5000} defaultValue={v?.notes ?? ""} />
      </Field>
      {supportActive ? <Checkbox name="includedInSupport" defaultChecked={v?.includedInSupport === "on"} label={labels.siteInSupport} /> : null}
      <Notice state={state} />
      <SubmitButton className="w-full" size="sm">
        <Icon name="plus" />
        {labels.addSite}
      </SubmitButton>
    </form>
  );
}

/** One site: its fields to edit, and a quiet delete below that asks first. */
export function SiteCard({
  site,
  clientId,
  supportActive,
  labels,
  actions,
}: {
  site: SiteView;
  clientId: string;
  supportActive: boolean;
  labels: ClientLabels;
  actions: { update: Action; remove: Action };
}) {
  const [saveState, saveAction] = useActionState(actions.update, null);
  const [removeState, removeAction] = useActionState(actions.remove, null);
  const v = saveState?.values;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
        <SiteName site={site} />
        {site.includedInSupport ? (
          <span className="flex-none text-[0.875rem] text-muted">{labels.inPlan}</span>
        ) : null}
      </div>
      {/* the fields pair up when the card, not the window, is wide enough */}
      <form action={saveAction} className="@container space-y-4 p-5">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="siteId" value={site.id} />
        <div className="grid gap-4 @md:grid-cols-2">
          <Field label={labels.siteName} htmlFor={`n-${site.id}`}>
            <Input id={`n-${site.id}`} name="name" defaultValue={v?.name ?? site.name} required maxLength={120} />
          </Field>
          <Field label={labels.siteUrl} htmlFor={`u-${site.id}`}>
            <Input id={`u-${site.id}`} name="url" defaultValue={v?.url ?? site.url ?? ""} maxLength={2048} placeholder="https://" />
          </Field>
        </div>
        <Field label={labels.notes} htmlFor={`o-${site.id}`}>
          <Input id={`o-${site.id}`} name="notes" defaultValue={v?.notes ?? site.notes ?? ""} maxLength={5000} />
        </Field>
        {supportActive ? (
          <Checkbox name="includedInSupport" defaultChecked={v ? v.includedInSupport === "on" : site.includedInSupport} label={labels.siteInSupport} />
        ) : null}
        <Notice state={saveState} />
        <div className="flex justify-end">
          <SubmitButton variant="secondary" size="sm">
            {labels.save}
          </SubmitButton>
        </div>
      </form>
      <form
        action={removeAction}
        onSubmit={(e) => {
          if (!window.confirm(fmt(labels.confirmDeleteSite, { name: site.name }))) e.preventDefault();
        }}
        className="border-t border-line px-3 py-2"
      >
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="siteId" value={site.id} />
        <SubmitButton variant="ghost" size="sm" className="text-muted hover:text-danger">
          <Icon name="trash" />
          {labels.deleteSite}
        </SubmitButton>
        {removeState?.error ? <Callout tone="danger" title={removeState.error} className="mt-2" /> : null}
      </form>
    </Card>
  );
}

/** Who takes part in the client: one box per person the member may assign. */
export function AssigneesForm({
  action,
  labels,
  clientId,
  people,
  selected,
}: {
  action: Action;
  labels: ClientLabels;
  clientId: string;
  people: { id: string; name: string; email: string }[];
  selected: string[];
}) {
  const [state, formAction] = useActionState(action, null);
  const chosen = new Set(selected);
  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="clientId" value={clientId} />
      {people.length === 0 ? (
        <p className="text-muted">{labels.noTeamUsers}</p>
      ) : (
        <div className="space-y-2.5">
          {people.map((p) => (
            <Checkbox key={p.id} name="userIds" value={p.id} defaultChecked={chosen.has(p.id)} label={p.name} hint={p.email} />
          ))}
        </div>
      )}
      <Notice state={state} />
      <div className="flex justify-end">
        <SubmitButton size="sm">{labels.save}</SubmitButton>
      </div>
    </form>
  );
}
