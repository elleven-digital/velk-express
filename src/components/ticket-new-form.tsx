"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { AttachmentField, type AttachmentLabels } from "./attachments";
import { RichEditor, type EditorLabels } from "./editor";
import { SubmitButton } from "./submit-button";
import type { TicketFormState } from "./ticket-form-state";
import { Callout, Field, Input, Select, cn } from "./ui";

type ClientOption = { id: string; name: string; supportActive: boolean };
type SiteOption = { id: string; name: string; clientId: string };

export type TicketFormLabels = EditorLabels &
  AttachmentLabels & {
    forClient: string;
    forSite: string;
    typeField: string;
    typeSingleLong: string;
    typeSupportLong: string;
    titleField: string;
    valueField: string;
    valueHint: string;
    valuePlaceholder: string;
    firstMessage: string;
    submit: string;
    supportNeedsPlan: string;
    noSiteOption: string;
    attachments: string;
  };

/** One of the two ticket types: a bordered option with a radio mark. */
function TypeOption({
  label,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex items-start gap-3 rounded-field border bg-white px-4 py-3 text-left transition-colors",
        selected ? "border-ink" : "border-line hover:border-line-strong hover:bg-paper",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-line disabled:hover:bg-white",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("mt-0.5 size-4 flex-none rounded-full border flex items-center justify-center", selected ? "border-ink" : "border-line-strong")}
      >
        {selected ? <span className="size-2 rounded-full bg-ink" /> : null}
      </span>
      <span className="font-medium text-ink">{label}</span>
    </button>
  );
}

/** The team's new-ticket form. The first message is the rich editor (hidden field `body`); files upload on pick and only their ids go in the form. */
export function TicketNewForm({
  action,
  clients,
  sites,
  labels,
  initialClientId,
  canSetValue,
}: {
  action: (prev: TicketFormState, formData: FormData) => Promise<TicketFormState>;
  clients: ClientOption[];
  sites: SiteOption[];
  labels: TicketFormLabels;
  initialClientId?: string;
  /** Only owners and managers set the agreed value. */
  canSetValue: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const values = state?.values;
  const [clientId, setClientId] = useState(
    values?.clientId ?? (clients.some((c) => c.id === initialClientId) ? initialClientId! : (clients[0]?.id ?? "")),
  );
  const [type, setType] = useState<"single" | "support">(values?.type === "support" ? "support" : "single");
  const [uploading, setUploading] = useState(false);
  const editorRef = useRef<Editor | null>(null);

  const client = useMemo(() => clients.find((c) => c.id === clientId), [clients, clientId]);
  const clientSites = useMemo(() => sites.filter((s) => s.clientId === clientId), [sites, clientId]);
  const supportAllowed = Boolean(client?.supportActive);
  const effectiveType = type === "support" && supportAllowed ? "support" : "single";

  return (
    <form action={formAction} className="space-y-5">
      {state?.error ? <Callout tone="danger">{state.error}</Callout> : null}

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label={labels.forClient} htmlFor="tk-client">
          <Select
            id="tk-client"
            name="clientId"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.forSite} htmlFor="tk-site">
          {/* a new client brings its own sites: start again; an error keeps the chosen one */}
          <Select id="tk-site" key={`${clientId}:${values?.siteId ?? ""}`} name="siteId" defaultValue={values?.clientId === clientId ? (values?.siteId ?? "") : ""}>
            <option value="">{labels.noSiteOption}</option>
            {clientSites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <div className="text-[0.875rem] font-medium text-ink mb-1.5">{labels.typeField}</div>
        <input type="hidden" name="type" value={effectiveType} />
        <div className="grid sm:grid-cols-2 gap-3">
          <TypeOption label={labels.typeSingleLong} selected={effectiveType === "single"} onSelect={() => setType("single")} />
          <TypeOption
            label={labels.typeSupportLong}
            selected={effectiveType === "support"}
            disabled={!supportAllowed}
            onSelect={() => setType("support")}
          />
        </div>
        {!supportAllowed ? <p className="text-[0.8125rem] text-muted mt-2">{labels.supportNeedsPlan}</p> : null}
      </div>

      <Field label={labels.titleField} htmlFor="tk-title">
        <Input id="tk-title" name="title" required maxLength={200} defaultValue={values?.title ?? ""} />
      </Field>

      {canSetValue && effectiveType === "single" ? (
        <Field label={labels.valueField} htmlFor="tk-value" hint={labels.valueHint}>
          <Input
            id="tk-value"
            name="value"
            inputMode="decimal"
            placeholder={labels.valuePlaceholder}
            className="max-w-48"
            defaultValue={values?.value ?? ""}
          />
        </Field>
      ) : null}

      <Field label={labels.firstMessage}>
        <RichEditor editorRef={editorRef} side="team" name="body" labels={labels} minHeight={120} />
      </Field>

      <div className="space-y-1.5">
        <div className="text-[0.875rem] font-medium text-ink">{labels.attachments}</div>
        <AttachmentField name="attachmentIds" side="team" labels={labels} onBusyChange={setUploading} />
      </div>

      <div className="flex justify-end pt-1">
        <SubmitButton disabled={uploading || clients.length === 0}>{labels.submit}</SubmitButton>
      </div>
    </form>
  );
}

export type PortalTicketFormLabels = EditorLabels &
  AttachmentLabels & {
    attachments: string;
    forSite: string;
    generalOption: string;
    titleField: string;
    firstMessage: string;
    submit: string;
  };

/**
 * The portal's new-ticket form: a support ticket for the person's own company (which the server
 * takes from the session, so nothing here names it). `sites` are only ids and names; `general`
 * adds the "no specific site" choice. The description is the rich editor (hidden field `body`).
 */
export function PortalTicketForm({
  action,
  sites,
  general,
  labels,
}: {
  action: (prev: TicketFormState, formData: FormData) => Promise<TicketFormState>;
  sites: { id: string; name: string }[];
  general: boolean;
  labels: PortalTicketFormLabels;
}) {
  const [state, formAction] = useActionState(action, null);
  const values = state?.values;
  const [uploading, setUploading] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const firstSite = sites[0]?.id ?? "";

  return (
    <form action={formAction} className="space-y-5">
      {state?.error ? <Callout tone="danger">{state.error}</Callout> : null}

      <Field label={labels.forSite} htmlFor="pt-site">
        {/* a select keeps the default it first mounted with: remount it after an error */}
        <Select id="pt-site" key={values?.siteId ?? ""} name="siteId" defaultValue={values?.siteId ?? (general ? "" : firstSite)}>
          {general ? <option value="">{labels.generalOption}</option> : null}
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={labels.titleField} htmlFor="pt-title">
        <Input id="pt-title" name="title" required maxLength={200} defaultValue={values?.title ?? ""} />
      </Field>

      <Field label={labels.firstMessage}>
        <RichEditor editorRef={editorRef} side="portal" name="body" labels={labels} minHeight={120} />
      </Field>

      <div className="space-y-1.5">
        <div className="text-[0.875rem] font-medium text-ink">{labels.attachments}</div>
        <AttachmentField name="attachmentIds" side="portal" labels={labels} onBusyChange={setUploading} />
      </div>

      <div className="flex justify-end pt-1">
        <SubmitButton disabled={uploading}>{labels.submit}</SubmitButton>
      </div>
    </form>
  );
}
