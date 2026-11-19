import { asc } from "drizzle-orm";
import { CopyButton } from "@/components/link-box";
import { RotationForm } from "@/components/rotation-form";
import { Badge, Card, PageHeader, SectionTitle } from "@/components/ui";
import { logoPath } from "@/lib/agency";
import { requireTeam } from "@/lib/auth/guards";
import { getVisibility } from "@/lib/access";
import { getAgencyRotation } from "@/lib/core/assignments";
import { listLabels } from "@/lib/core/labels";
import { CURRENCIES, getInstallationStatus, getPaymentSettings } from "@/lib/core/settings";
import { fmt, LOCALES, LOCALE_NAMES } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { timeZoneGroups, timeZoneOrDefault } from "@/lib/time-zone";
import { isNewer, UPDATE_GUIDE_URL } from "@/lib/update-check";
import { db, agency as agencyTable, users } from "@/lib/db";
import {
  removeLogoAction,
  saveAgencyAction,
  saveAppUrlAction,
  saveAutoAssignAction,
  saveDefaultProviderAction,
  createLabelAction,
  deleteLabelAction,
  saveVisibilityAction,
  updateLabelAction,
  uploadLogoAction,
} from "./actions";
import { LabelsSection } from "./labels-section";
import { AgencyForm, AppUrlForm, DefaultProviderForm, LogoForm, VisibilityForm } from "./settings-forms";

export const dynamic = "force-dynamic";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3">
      <dt className="text-[0.875rem] text-muted">{label}</dt>
      <dd className="min-w-0 text-[0.875rem] text-ink">{children}</dd>
    </div>
  );
}

export default async function SettingsPage() {
  // Managers open the page for the labels only; every other section is the owner's.
  const session = await requireTeam(["owner", "manager"]);
  const isOwner = session.user.role === "owner";
  const { t } = await getUserDict();
  const s = t.settings;
  const labels = await listLabels();
  const labelsSection = (
    <section aria-labelledby="labels-title">
      <SectionTitle className="mb-1">
        <span id="labels-title">{s.labelsTitle}</span>
      </SectionTitle>
      <p className="mb-4 text-[0.875rem] text-muted">{s.labelsHint}</p>
      <Card className="p-6 max-sm:p-4">
        <LabelsSection
          labels={labels.map((l) => ({ id: l.id, name: l.name, color: l.color, tickets: l.tickets }))}
          createAction={createLabelAction}
          updateAction={updateLabelAction}
          deleteAction={deleteLabelAction}
          texts={{
            name: s.labelName,
            newLabel: s.labelNew,
            create: s.labelCreate,
            save: s.save,
            remove: t.common.delete,
            confirmRemove: s.labelDeleteConfirm,
            empty: s.labelsEmpty,
            ticketsOne: s.labelTicketsOne,
            ticketsMany: s.labelTicketsMany,
            color: {
              presets: {
                gray: s.colorNone,
                red: s.colorRed,
                orange: s.colorOrange,
                amber: s.colorAmber,
                green: s.colorGreen,
                teal: s.colorTeal,
                blue: s.colorBlue,
                purple: s.colorPurple,
                pink: s.colorPink,
              },
              color: s.labelColor,
              hex: s.labelHex,
              pick: s.labelPickColor,
            },
          }}
        />
      </Card>
    </section>
  );

  if (!isOwner) {
    return (
      <>
        <PageHeader title={s.title} />
        <div className="max-w-3xl space-y-8">{labelsSection}</div>
      </>
    );
  }

  const [brand] = await db.select().from(agencyTable).limit(1);
  const status = await getInstallationStatus();
  const visibility = await getVisibility();
  const paymentsRes = await getPaymentSettings(session);
  const payments = paymentsRes.ok ? paymentsRes.value : { providers: [], defaultProvider: null };
  const providerName = (n: string) => (n === "stripe" ? s.stripe : s.mercadoPago);
  const activeProviders = payments.providers.filter((p) => p.active);
  const installPayments =
    activeProviders.length === 0
      ? s.paymentsManualOnly
      : fmt(s.paymentsStatus, {
          stripe: status.payments.stripe ? s.paymentsActive : s.paymentsInactive,
          mercadoPago: status.payments.mercadoPago ? s.paymentsActive : s.paymentsInactive,
        });
  const [rotation, team] = await Promise.all([getAgencyRotation(), db.select().from(users).orderBy(asc(users.name), asc(users.id))]);
  const name = brand?.name ?? "";

  const updateAvailable = status.latest !== null && isNewer(status.latest.version, status.version);

  return (
    <>
      <PageHeader title={s.title} sub={s.sub} />
      <div className="max-w-3xl space-y-8">
        <section aria-labelledby="agency-title">
          <SectionTitle className="mb-1">
            <span id="agency-title">{s.agencyTitle}</span>
          </SectionTitle>
          <p className="mb-4 text-[0.875rem] text-muted">{s.agencySub}</p>
          <div className="space-y-6">
            <Card className="p-6 max-sm:p-4">
              <AgencyForm
                action={saveAgencyAction}
                labels={{
                  name: s.name,
                  currency: s.currency,
                  language: s.language,
                  languageHint: s.languageHint,
                  timeZone: s.timeZone,
                  timeZoneHint: s.timeZoneHint,
                  save: s.save,
                }}
                values={{
                  name: name,
                  currency: brand?.currency ?? "BRL",
                  locale: brand?.locale ?? "en",
                  timeZone: timeZoneOrDefault(brand?.timeZone),
                }}
                currencies={[...CURRENCIES]}
                timeZones={timeZoneGroups()}
                locales={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))}
              />
            </Card>
            <Card className="p-6 max-sm:p-4">
              <LogoForm
                uploadAction={uploadLogoAction}
                removeAction={removeLogoAction}
                agencyName={name}
                logoUrl={logoPath(brand?.logoFileId ?? null)}
                labels={{
                  logo: s.logo,
                  hint: s.logoHint,
                  none: s.logoNone,
                  upload: s.logoUpload,
                  replace: s.logoReplace,
                  remove: s.logoRemove,
                }}
              />
            </Card>
          </div>
        </section>

        <section aria-labelledby="visibility-title">
          <SectionTitle className="mb-1">
            <span id="visibility-title">{s.visibilityTitle}</span>
          </SectionTitle>
          <p className="mb-4 text-[0.875rem] text-muted">{s.visibilitySub} {s.visibilityHint}</p>
          <Card className="p-6 max-sm:p-4">
            <VisibilityForm
              action={saveVisibilityAction}
              labels={{
                clientScope: s.clientScopeLabel,
                clientScopeAll: s.clientScopeAll,
                clientScopeAssigned: s.clientScopeAssigned,
                ticketScope: s.ticketScopeLabel,
                ticketScopeAll: s.ticketScopeAll,
                ticketScopeAssigned: s.ticketScopeAssigned,
                seesUnassigned: s.seesUnassigned,
                save: s.save,
              }}
              values={visibility}
            />
          </Card>
        </section>

        <section aria-labelledby="rotation-title">
          <SectionTitle className="mb-1">
            <span id="rotation-title">{s.autoAssignSection}</span>
          </SectionTitle>
          <p className="mb-4 text-[0.875rem] text-muted">{s.autoAssignHint}</p>
          <Card className="p-6 max-sm:p-4">
            <RotationForm
              action={saveAutoAssignAction}
              enabled={rotation.enabled}
              selected={rotation.userIds}
              people={team.map((u) => ({ id: u.id, name: u.name, email: u.email }))}
              labels={{ toggle: s.autoAssignToggle, who: s.autoAssignWho, none: t.clients.noTeamUsers, save: s.save }}
            />
          </Card>
        </section>

        {labelsSection}

        <section aria-labelledby="install-title">
          <SectionTitle className="mb-1">
            <span id="install-title">{s.installTitle}</span>
          </SectionTitle>
          <p className="mb-4 text-[0.875rem] text-muted">{s.installSub}</p>
          <Card className="divide-y divide-line">
            <div className="p-4">
              {status.appUrlLockedByEnv ? (
                <dl>
                  <Row label={s.publicUrl}>
                    <span className="break-all">{status.appUrl}</span>
                    <span className="block text-muted">{s.publicUrlLocked}</span>
                  </Row>
                </dl>
              ) : (
                <AppUrlForm
                  action={saveAppUrlAction}
                  label={s.publicUrl}
                  hint={s.publicUrlHint}
                  save={s.save}
                  value={status.appUrl}
                />
              )}
            </div>
            <dl className="divide-y divide-line">
              <Row label={s.mail}>
                <Badge tone={status.mail ? "ok" : "muted"}>{status.mail ? s.mailOn : s.mailOff}</Badge>
              </Row>
              <Row label={s.storage}>
                <Badge tone={status.storage.writable ? "ok" : "danger"}>
                  {status.storage.mode === "s3" ? s.storageS3 : s.storageDisk},{" "}
                  {status.storage.writable ? s.storageWritable : s.storageNotWritable}
                </Badge>
              </Row>
              <Row label={s.paymentsLabel}>
                <span>{installPayments}</span>
              </Row>
              <Row label={s.version}>
                <span className="tabular">{status.version}</span>
              </Row>
              <Row label={s.latest}>
                {!status.updateCheck ? (
                  <span className="text-muted">{s.updateCheckOff}</span>
                ) : status.latest === null ? (
                  <span className="text-muted">{s.unknown}</span>
                ) : updateAvailable ? (
                  <a
                    href={status.latest.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    {fmt(s.updateAvailable, { version: status.latest.version })}
                  </a>
                ) : (
                  <Badge tone="ok">{s.upToDate}</Badge>
                )}
              </Row>
              <Row label={s.updateGuideLabel}>
                <a href={UPDATE_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
                  {s.updateGuide}
                </a>
              </Row>
            </dl>
          </Card>
        </section>

        <section aria-labelledby="payments-title">
          <SectionTitle className="mb-1">
            <span id="payments-title">{s.paymentsTitle}</span>
          </SectionTitle>
          <p className="mb-4 text-[0.875rem] text-muted">{s.paymentsSub}</p>
          <div className="space-y-6">
            {payments.providers.map((p) => (
              <Card key={p.name} className="divide-y divide-line">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <h3 className="text-[0.9375rem] font-medium text-ink">{providerName(p.name)}</h3>
                  <Badge tone={p.active ? "ok" : "muted"}>{p.active ? s.on : s.off}</Badge>
                </div>
                <div className="space-y-3 px-4 py-3">
                  <div>
                    <div className="text-[0.8125rem] text-muted">{s.paymentsTurnedOn}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {p.envVars.map((v) => (
                        <code key={v} className="rounded-field border border-line bg-paper px-2 py-0.5 font-mono text-[0.8125rem] text-ink">
                          {v}
                        </code>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[0.8125rem] text-muted">{s.paymentsWebhook}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <input
                        readOnly
                        aria-label={`${providerName(p.name)}: ${s.paymentsWebhook}`}
                        value={p.webhookUrl}
                        className="min-w-0 flex-1 basis-60 rounded-field border border-line bg-white px-3 py-[7px] font-mono text-[0.8125rem] text-ink"
                      />
                      <CopyButton text={p.webhookUrl} label={t.common.copy} copiedLabel={t.common.copied} />
                    </div>
                  </div>
                  <div>
                    <div className="text-[0.8125rem] text-muted">{p.name === "stripe" ? s.paymentsEvents : s.paymentsTopics}</div>
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {p.events.map((e) => (
                        <li key={e} className="rounded-field border border-line bg-paper px-2 py-0.5 font-mono text-[0.8125rem] text-ink">
                          {e}
                        </li>
                      ))}
                    </ul>
                    {p.name === "mercadopago" ? <p className="mt-2 text-[0.8125rem] text-muted">{s.paymentsBrlOnly}</p> : null}
                  </div>
                </div>
              </Card>
            ))}
            <Card className="p-6 max-sm:p-4">
              <DefaultProviderForm
                action={saveDefaultProviderAction}
                label={s.paymentsDefault}
                hint={s.paymentsDefaultHint}
                save={s.save}
                value={activeProviders.some((p) => p.name === payments.defaultProvider) ? (payments.defaultProvider ?? "") : ""}
                options={[
                  { value: "", label: s.paymentsDefaultNone },
                  ...activeProviders.map((p) => ({ value: p.name, label: providerName(p.name) })),
                ]}
              />
            </Card>
          </div>
        </section>
      </div>
    </>
  );
}
