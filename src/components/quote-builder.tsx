"use client";

import { startTransition, useActionState, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Button, Callout, Card, Field, Input, LinkButton, SectionTitle, Select, Textarea, cn } from "@/components/ui";
import type { Currency } from "@/lib/core/settings";
import { formatMoney, moneyPlaceholder, parseMoney } from "@/lib/format";
import { fmt, type Dict, type Locale } from "@/lib/i18n";

export type BuilderClient = { id: string; name: string };
export type BuilderSite = { id: string; name: string; clientId: string };
export type BuilderKind = "site_creation" | "maintenance" | "support";
export type HoursMode = "off" | "internal" | "package";

type NewSiteRow = { key: string; name: string; url: string };
/** One item as the form holds it: every number is still the text that was typed. */
export type BuilderItem = {
  key: string;
  kind: BuilderKind;
  title: string;
  description: string;
  amount: string;
  siteId: string;
  newSiteName: string;
  newSiteUrl: string;
  siteIds: string[];
  newSites: NewSiteRow[];
  hoursMode: HoursMode;
  includedHours: string;
  extraHourPrice: string;
};
export type BuilderInitial = {
  mode: "client" | "prospect";
  clientId: string;
  prospectName: string;
  prospectEmail: string;
  title: string;
  notes: string;
  items: (Omit<BuilderItem, "key" | "newSites"> & { newSites: { name: string; url: string }[] })[];
};

export type BuilderState = { error?: string } | null;
export type BuilderLabels = Dict["quotes"];
export type HoursLabels = Pick<
  Dict["clients"],
  "hoursMode" | "hoursOff" | "hoursInternal" | "hoursInternalHint" | "hoursToggle" | "hoursHint" | "includedHours" | "extraHourValue" | "extraHourHint"
>;

function emptyItem(kind: BuilderKind, key: string): BuilderItem {
  return {
    key,
    kind,
    title: "",
    description: "",
    amount: "",
    siteId: "",
    newSiteName: "",
    newSiteUrl: "",
    siteIds: [],
    newSites: [],
    hoursMode: "off",
    includedHours: "",
    extraHourPrice: "",
  };
}

function Choice({ on, disabled, onClick, children }: { on: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-10 items-center justify-center rounded-field border px-3 text-[0.875rem] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        on ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:bg-chip",
      )}
    >
      {children}
    </button>
  );
}

/** The builder of a quote: who it is for, the items with what closing it sets up, live totals. Posts its state as JSON. */
export function QuoteBuilder({
  action,
  quoteId,
  clients,
  sites,
  initial,
  labels,
  hoursLabels,
  locale,
  currency,
  submitLabel,
  cancelHref,
}: {
  action: (prev: BuilderState, formData: FormData) => Promise<BuilderState>;
  quoteId?: string;
  clients: BuilderClient[];
  sites: BuilderSite[];
  initial?: BuilderInitial;
  labels: BuilderLabels;
  hoursLabels: HoursLabels;
  locale: Locale;
  currency: Currency;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [mode, setMode] = useState<"client" | "prospect">(initial?.mode ?? (clients.length > 0 ? "client" : "prospect"));
  const [clientId, setClientId] = useState(initial?.clientId || clients[0]?.id || "");
  const [prospectName, setProspectName] = useState(initial?.prospectName ?? "");
  const [prospectEmail, setProspectEmail] = useState(initial?.prospectEmail ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [items, setItems] = useState<BuilderItem[]>(() =>
    // keys by position: the server and the browser must render the same ones
    (initial?.items ?? []).map((i, n) => ({
      ...i,
      key: `i${n}`,
      newSites: i.newSites.map((s, m) => ({ ...s, key: `i${n}s${m}` })),
    })),
  );
  const seq = useRef(0);
  const nextKey = () => `n${++seq.current}`;

  const clientSites = sites.filter((s) => s.clientId === clientId);
  const placeholder = moneyPlaceholder(locale);
  const patch = (key: string, change: Partial<BuilderItem>) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...change } : i)));

  let oneTime = 0;
  let monthly = 0;
  for (const item of items) {
    const cents = parseMoney(item.amount) ?? 0;
    if (item.kind === "support") monthly += cents;
    else oneTime += cents;
  }

  const payload = JSON.stringify({
    mode,
    clientId,
    prospectName,
    prospectEmail,
    title,
    notes,
    items: items.map((item) => ({
      kind: item.kind,
      title: item.title,
      description: item.description,
      amount: item.amount,
      siteId: item.siteId,
      newSiteName: item.newSiteName,
      newSiteUrl: item.newSiteUrl,
      siteIds: item.siteIds,
      newSites: item.newSites.map(({ name, url }) => ({ name, url })),
      hoursMode: item.hoursMode,
      includedHours: item.includedHours,
      extraHourPrice: item.extraHourPrice,
    })),
  });

  const kindLabel: Record<BuilderKind, string> = {
    site_creation: labels.kindSiteCreation,
    maintenance: labels.kindMaintenance,
    support: labels.kindSupport,
  };
  const modes: { value: HoursMode; label: string; hint?: string }[] = [
    { value: "off", label: hoursLabels.hoursOff },
    { value: "internal", label: hoursLabels.hoursInternal, hint: hoursLabels.hoursInternalHint },
    { value: "package", label: hoursLabels.hoursToggle, hint: hoursLabels.hoursHint },
  ];

  return (
    // Submitted by hand: a form action would reset the form afterwards and clear the selects and number
    // fields the page shows, while the typed state (kept on an error) stays.
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      <input type="hidden" name="payload" value={payload} />
      {quoteId ? <input type="hidden" name="quoteId" value={quoteId} /> : null}
      {state?.error ? <Callout tone="danger" title={state.error} /> : null}

      <Card className="space-y-5 p-6 max-sm:p-4">
        <Field label={labels.colTitle} htmlFor="q-title">
          <Input id="q-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </Field>

        <div>
          <div className="mb-1.5 text-[0.875rem] font-medium text-ink">{labels.forWho}</div>
          <div role="group" aria-label={labels.forWho} className="grid gap-2.5 sm:grid-cols-2">
            <Choice on={mode === "client"} disabled={clients.length === 0} onClick={() => setMode("client")}>
              {labels.existingClient}
            </Choice>
            <Choice on={mode === "prospect"} onClick={() => setMode("prospect")}>
              {labels.newProspect}
            </Choice>
          </div>
        </div>

        {mode === "client" ? (
          <Field label={labels.clientField} htmlFor="q-client">
            <Select
              id="q-client"
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                // the sites picked belong to the old client
                setItems((prev) => prev.map((i) => ({ ...i, siteId: "", siteIds: [] })));
              }}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={labels.prospectName} htmlFor="q-pname">
              <Input id="q-pname" value={prospectName} onChange={(e) => setProspectName(e.target.value)} />
            </Field>
            <Field label={`${labels.prospectEmail} (${labels.optional})`} htmlFor="q-pemail" hint={labels.prospectHint}>
              <Input id="q-pemail" type="email" value={prospectEmail} onChange={(e) => setProspectEmail(e.target.value)} />
            </Field>
          </div>
        )}

        <Field label={`${labels.notesField} (${labels.optional})`} htmlFor="q-notes">
          <Textarea id="q-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </Card>

      <section aria-labelledby="q-items">
        <SectionTitle className="mb-3">
          <span id="q-items">{labels.items}</span>
        </SectionTitle>
        {items.length === 0 ? (
          <Card className="px-6 py-8 text-center text-[0.875rem] text-muted">{labels.noItems}</Card>
        ) : null}
        <div className="space-y-4">
          {items.map((item, index) => (
            <Card key={item.key} className="p-6 max-sm:p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="min-w-0 text-[0.875rem]">
                  <span className="tabular font-medium text-muted">{String(index + 1).padStart(2, "0")}</span>{" "}
                  <span className="font-medium text-ink">{kindLabel[item.kind]}</span>
                  <span className="text-muted"> · {item.kind === "support" ? labels.monthly : labels.oneTime}</span>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}>
                  <Icon name="x" />
                  {labels.remove}
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
                <Field label={labels.itemTitle} htmlFor={`it-${item.key}`}>
                  <Input id={`it-${item.key}`} value={item.title} onChange={(e) => patch(item.key, { title: e.target.value })} required />
                </Field>
                <Field label={fmt(labels.itemAmount, { currency })} htmlFor={`ia-${item.key}`}>
                  <Input
                    id={`ia-${item.key}`}
                    inputMode="decimal"
                    placeholder={placeholder}
                    value={item.amount}
                    onChange={(e) => patch(item.key, { amount: e.target.value })}
                  />
                </Field>
              </div>
              <Field label={`${labels.itemDescription} (${labels.optional})`} htmlFor={`id-${item.key}`} className="mt-4">
                <Textarea id={`id-${item.key}`} rows={2} value={item.description} onChange={(e) => patch(item.key, { description: e.target.value })} />
              </Field>

              <div className="mt-4 space-y-4 rounded-field border border-line bg-paper p-4 max-sm:p-3.5">
                <div className="text-[0.8125rem] font-medium text-muted">{labels.shortcuts}</div>

                {item.kind === "maintenance" && mode === "client" ? <MaintenancePick item={item} sites={clientSites} labels={labels} patch={patch} /> : null}
                {item.kind === "site_creation" || (item.kind === "maintenance" && !(mode === "client" && item.siteId)) ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={labels.scNewSiteName} htmlFor={`sn-${item.key}`}>
                      <Input id={`sn-${item.key}`} value={item.newSiteName} onChange={(e) => patch(item.key, { newSiteName: e.target.value })} placeholder="example.com" />
                    </Field>
                    <Field label={`${labels.scNewSiteUrl} (${labels.optional})`} htmlFor={`su-${item.key}`}>
                      <Input id={`su-${item.key}`} value={item.newSiteUrl} onChange={(e) => patch(item.key, { newSiteUrl: e.target.value })} placeholder="https://" />
                    </Field>
                  </div>
                ) : null}

                {item.kind === "support" ? (
                  <>
                    {mode === "client" && clientSites.length > 0 ? (
                      <div>
                        <div className="mb-2 text-[0.875rem] font-medium text-ink">{labels.scSupportSites}</div>
                        <div className="flex flex-wrap gap-2">
                          {clientSites.map((s) => {
                            const on = item.siteIds.includes(s.id);
                            return (
                              <button
                                key={s.id}
                                type="button"
                                aria-pressed={on}
                                onClick={() => patch(item.key, { siteIds: on ? item.siteIds.filter((id) => id !== s.id) : [...item.siteIds, s.id] })}
                                className={cn(
                                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[0.8125rem] font-medium transition-colors",
                                  on ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:bg-chip",
                                )}
                              >
                                <Icon name={on ? "check" : "plus"} size={14} />
                                {s.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    <div>
                      <div className="mb-2 text-[0.875rem] font-medium text-ink">{labels.scSupportNewSites}</div>
                      <div className="space-y-2">
                        {item.newSites.map((row) => (
                          <div key={row.key} className="flex flex-wrap items-center gap-2">
                            <Input
                              aria-label={labels.scNewSiteName}
                              className="min-w-0 flex-1 basis-40"
                              placeholder="example.com"
                              value={row.name}
                              onChange={(e) => patch(item.key, { newSites: item.newSites.map((r) => (r.key === row.key ? { ...r, name: e.target.value } : r)) })}
                            />
                            <Input
                              aria-label={labels.scNewSiteUrl}
                              className="min-w-0 flex-1 basis-40"
                              placeholder="https://"
                              value={row.url}
                              onChange={(e) => patch(item.key, { newSites: item.newSites.map((r) => (r.key === row.key ? { ...r, url: e.target.value } : r)) })}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={labels.remove}
                              onClick={() => patch(item.key, { newSites: item.newSites.filter((r) => r.key !== row.key) })}
                            >
                              <Icon name="x" />
                            </Button>
                          </div>
                        ))}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn("-ml-2.5", item.newSites.length > 0 && "mt-2")}
                        onClick={() => {
                          const key = nextKey();
                          patch(item.key, { newSites: [...item.newSites, { key, name: "", url: "" }] });
                        }}
                      >
                        <Icon name="plus" />
                        {labels.scAddNewSite}
                      </Button>
                    </div>

                    <fieldset className="space-y-2.5">
                      <legend className="mb-2.5 text-[0.875rem] font-medium text-ink">{hoursLabels.hoursMode}</legend>
                      {modes.map((m) => (
                        <label key={m.value} className="flex cursor-pointer items-start gap-3">
                          <input
                            type="radio"
                            name={`hours-${item.key}`}
                            value={m.value}
                            checked={item.hoursMode === m.value}
                            onChange={() => patch(item.key, { hoursMode: m.value })}
                            className="mt-0.5 size-4 accent-brand"
                          />
                          <span>
                            <span className="block text-[0.875rem] font-medium text-ink">{m.label}</span>
                            {m.hint ? <span className="mt-0.5 block text-[0.8125rem] text-muted">{m.hint}</span> : null}
                          </span>
                        </label>
                      ))}
                      {item.hoursMode === "package" ? (
                        <div className="space-y-4 pl-7 pt-2">
                          <Field label={hoursLabels.includedHours} htmlFor={`ih-${item.key}`}>
                            <Input
                              id={`ih-${item.key}`}
                              type="number"
                              inputMode="decimal"
                              min={0}
                              step="any"
                              value={item.includedHours}
                              onChange={(e) => patch(item.key, { includedHours: e.target.value })}
                              className="max-w-48"
                            />
                          </Field>
                          <Field
                            label={`${fmt(hoursLabels.extraHourValue, { currency })} (${labels.optional})`}
                            htmlFor={`eh-${item.key}`}
                            hint={hoursLabels.extraHourHint}
                          >
                            <Input
                              id={`eh-${item.key}`}
                              inputMode="decimal"
                              placeholder={placeholder}
                              value={item.extraHourPrice}
                              onChange={(e) => patch(item.key, { extraHourPrice: e.target.value })}
                              className="max-w-48"
                            />
                          </Field>
                        </div>
                      ) : null}
                    </fieldset>
                  </>
                ) : null}
              </div>
            </Card>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[0.8125rem] font-medium text-muted">{labels.addItem}</span>
          {(["site_creation", "maintenance", "support"] as const).map((kind) => (
            <Button key={kind} type="button" variant="secondary" size="sm" onClick={() => {
                const key = nextKey();
                setItems((prev) => [...prev, emptyItem(kind, key)]);
              }}>
              <Icon name="plus" />
              {kindLabel[kind]}
            </Button>
          ))}
        </div>
      </section>

      <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 max-sm:px-4 lg:sticky lg:bottom-4">
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <div className="text-[0.8125rem] text-muted">{labels.totalOneTime}</div>
            <div className="tabular text-[1.125rem] font-semibold leading-snug tracking-[-0.02em] text-ink">{formatMoney(oneTime, currency, locale)}</div>
          </div>
          <div>
            <div className="text-[0.8125rem] text-muted">{labels.totalMonthly}</div>
            <div className="tabular text-[1.125rem] font-semibold leading-snug tracking-[-0.02em] text-ink">
              {formatMoney(monthly, currency, locale)}
              <span className="text-[0.8125rem] font-normal text-muted">{labels.perMonth}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LinkButton href={cancelHref} variant="ghost">
            {labels.cancel}
          </LinkButton>
          <Button type="submit" disabled={pending}>
            {pending ? <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
            {submitLabel}
          </Button>
        </div>
      </Card>
    </form>
  );
}

function MaintenancePick({
  item,
  sites,
  labels,
  patch,
}: {
  item: BuilderItem;
  sites: BuilderSite[];
  labels: BuilderLabels;
  patch: (key: string, change: Partial<BuilderItem>) => void;
}) {
  return (
    <Field label={labels.scPickSite} htmlFor={`ms-${item.key}`}>
      <Select id={`ms-${item.key}`} value={item.siteId} onChange={(e) => patch(item.key, { siteId: e.target.value })}>
        <option value="">{labels.scNewSiteOption}</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
