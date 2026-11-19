import Link from "next/link";
import { notFound } from "next/navigation";
import { isStaff } from "@/lib/access";
import { getAgency } from "@/lib/agency";
import { requireTeam } from "@/lib/auth/guards";
import { asc } from "drizzle-orm";
import { Callout, Card, ProgressBar } from "@/components/ui";
import { ChargeSection } from "@/components/charge-section";
import { RotationForm } from "@/components/rotation-form";
import { getAgencyRotation, getClientTeam } from "@/lib/core/assignments";
import { chargeFor } from "@/lib/core/charges";
import { isBillingSubscription } from "@/lib/charge-utils";
import { getClientCached, listSites } from "@/lib/core/clients";
import { getHoursSummary } from "@/lib/core/hours";
import { minutesToHoursInput } from "@/lib/hours";
import { db, users } from "@/lib/db";
import { formatCycle, formatMinutes, moneyInputValue, moneyPlaceholder } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { setAssigneesAction, updateClientAction, updateClientRotationAction, updateSupportAction } from "../actions";
import { AssigneesForm, CompanyForm, SettingsCard, SupportForm } from "../client-forms";

export const dynamic = "force-dynamic";

function TicketsLink({ clientId, label }: { clientId: string; label: string }) {
  return (
    <p className="mb-5">
      <Link href={`/admin/tickets?client=${clientId}`} className="font-medium text-ink underline-offset-[3px] hover:underline">
        {label} →
      </Link>
    </p>
  );
}

/** This cycle's hours for everyone who can open the client: the balance (or just what was used) and the warning. */
async function HoursCard({ clientId }: { clientId: string }) {
  const [summary, { t, locale }] = await Promise.all([getHoursSummary(clientId), getUserDict()]);
  if (!summary) return null;
  const month = formatCycle(summary.cycle, locale);
  const total = summary.includedMinutes + summary.purchasedMinutes;
  return (
    <div className="mb-5 max-w-xl">
      <Card className="p-4">
        {summary.mode === "internal" ? (
          <>
            <h2 className="text-[0.8125rem] font-medium text-muted">{fmt(t.ui.figHours, { month })}</h2>
            <b className="mt-1 block text-[1.5rem] leading-tight font-semibold tracking-[-0.02em] text-ink tabular">
              {formatMinutes(summary.usedMinutes)}
            </b>
            <p className="mt-0.5 text-[0.8125rem] text-muted">{t.ui.hoursTeamOnly}</p>
          </>
        ) : summary.mode === "package" ? (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h2 className="text-[0.8125rem] font-medium text-muted">{t.ui.hoursBalance}</h2>
              <span className="text-[0.8125rem] text-muted tabular">{fmt(t.ui.hoursIn, { total: formatMinutes(total), month })}</span>
            </div>
            <b
              className={`mb-2.5 block text-[1.5rem] leading-tight font-semibold tracking-[-0.02em] tabular ${
                summary.balanceMinutes < 0 ? "text-danger" : "text-ink"
              }`}
            >
              {formatMinutes(summary.balanceMinutes)}
            </b>
            <ProgressBar value={summary.usedMinutes} max={total} tone={summary.balanceMinutes < 0 ? "danger" : "brand"} />
          </>
        ) : (
          <>
            <h2 className="text-[0.8125rem] font-medium text-muted">{t.ui.hoursBalance}</h2>
            <b className="mt-1 block text-[1.5rem] leading-tight font-semibold text-ink">—</b>
            <p className="mt-0.5 text-[0.8125rem] text-muted">{t.hours.notTracked}</p>
          </>
        )}
      </Card>
      {summary.mode === "package" && summary.balanceMinutes < 0 ? (
        <Callout tone="danger" className="mt-3">
          {t.hours.negativeWarning}
        </Callout>
      ) : null}
    </div>
  );
}

export default async function ClientOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireTeam();
  const [found, sitesRes, agency, { t, locale }] = await Promise.all([
    getClientCached(me, id),
    listSites(me, id),
    getAgency(),
    getUserDict(),
  ]);
  if (!found.ok || !sitesRes.ok) notFound();
  const client = found.value;
  const sites = sitesRes.value;

  if (!isStaff(me.user)) {
    // Collaborators read; the agency edits.
    return (
      <>
      <TicketsLink clientId={client.id} label={t.clients.ticketsLink} />
      <HoursCard clientId={client.id} />
      <SettingsCard title={t.clients.companySection} className="max-w-xl">
        <dl className="space-y-3">
          <div>
            <dt className="text-[0.8125rem] text-muted">{t.clients.companyName}</dt>
            <dd className="font-medium text-ink">{client.name}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-muted">{t.clients.contactEmail}</dt>
            <dd className="text-ink [overflow-wrap:anywhere]">{client.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-muted">{t.clients.phone}</dt>
            <dd className="text-ink">{client.phone ?? "—"}</dd>
          </div>
          {client.notes ? (
            <div>
              <dt className="text-[0.8125rem] text-muted">{t.clients.notes}</dt>
              <dd className="whitespace-pre-line text-ink">{client.notes}</dd>
            </div>
          ) : null}
        </dl>
      </SettingsCard>
      </>
    );
  }

  const [team, everyone, general] = await Promise.all([
    getClientTeam(client.id),
    db.select().from(users).orderBy(asc(users.name), asc(users.id)),
    getAgencyRotation(),
  ]);
  const retainerOffer = client.supportActive && (client.supportMonthlyCents ?? 0) > 0;
  const retainer = await chargeFor(me, { source: "support", sourceId: client.id });
  const retainerBilling = retainer.ok && retainer.value !== null && isBillingSubscription(retainer.value);
  const showRetainer = retainerOffer || (retainer.ok && retainer.value !== null);
  const person = (u: { id: string; name: string; email: string }) => ({ id: u.id, name: u.name, email: u.email });

  return (
    <>
    <TicketsLink clientId={client.id} label={t.clients.ticketsLink} />
    <HoursCard clientId={client.id} />
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <SettingsCard title={t.clients.companySection}>
        <CompanyForm
          action={updateClientAction}
          labels={t.clients}
          clientId={client.id}
          company={{ name: client.name, email: client.email, phone: client.phone, notes: client.notes }}
        />
      </SettingsCard>
      <SettingsCard title={t.clients.supportSection} hint={t.clients.supportHint}>
        <SupportForm
          action={updateSupportAction}
          labels={t.clients}
          clientId={client.id}
          currency={agency?.currency ?? "BRL"}
          support={{ active: client.supportActive, generalTickets: client.generalTicketsEnabled, hoursMode: client.hoursMode }}
          monthlyValue={moneyInputValue(client.supportMonthlyCents, locale)}
          hours={{
            included: minutesToHoursInput(client.includedMinutes),
            extraValue: moneyInputValue(client.extraHourCents, locale),
          }}
          placeholder={moneyPlaceholder(locale)}
          sites={sites.map((s) => ({ id: s.id, name: s.name, url: s.url, notes: s.notes, includedInSupport: s.includedInSupport }))}
          supportToggleHint={retainerBilling ? fmt(t.clients.supportLiveChargeWarning, { card: t.charges.supportCardTitle }) : undefined}
        />
      </SettingsCard>
      {showRetainer ? (
        <SettingsCard title={t.charges.supportCardTitle}>
          <ChargeSection
            me={me}
            source="support"
            sourceId={client.id}
            clientId={client.id}
            kind="subscription"
            offer={retainerOffer}
            amountCents={client.supportMonthlyCents}
          />
        </SettingsCard>
      ) : null}
      <SettingsCard title={t.clients.teamSection} hint={t.clients.teamHint}>
        <AssigneesForm
          action={setAssigneesAction}
          labels={t.clients}
          clientId={client.id}
          people={everyone.map(person)}
          selected={team.assignees.map((u) => u.id)}
        />
      </SettingsCard>
      <SettingsCard
        title={t.clients.autoAssignSection}
        hint={general.enabled ? `${t.clients.autoAssignHint} ${t.clients.autoAssignGlobalOn}` : t.clients.autoAssignHint}
      >
        <RotationForm
          action={updateClientRotationAction}
          clientId={client.id}
          enabled={team.rotation.enabled}
          selected={team.rotation.userIds}
          people={everyone.map(person)}
          labels={{ toggle: t.clients.autoAssignToggle, who: t.clients.rotationWho, none: t.clients.noTeamUsers, save: t.clients.save }}
        />
      </SettingsCard>
    </div>
    </>
  );
}
