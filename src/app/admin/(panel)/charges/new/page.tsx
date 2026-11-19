import { ChargeNewForm } from "@/components/charge-new-form";
import { providerLabels } from "@/components/charge-section";
import { PageHeader } from "@/components/ui";
import { requireTeam } from "@/lib/auth/guards";
import { chargeProviderMatrix } from "@/lib/core/charge-options";
import { listClients } from "@/lib/core/clients";
import { moneyPlaceholder } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { createFreeChargeAction } from "../actions";

export const dynamic = "force-dynamic";

/** A charge with no ticket, quote, plan or purchase behind it: a client, a name, an amount. */
export default async function NewChargePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const sp = await searchParams;
  const me = await requireTeam(["owner", "manager"]);
  const { t, locale } = await getUserDict();
  const [clients, options] = await Promise.all([listClients(me), chargeProviderMatrix(me)]);
  const initial = clients.find((c) => c.id === sp.client)?.id ?? "";
  const c = t.charges;
  return (
    <div className="max-w-xl">
      <PageHeader title={c.newTitle} sub={c.newSub} />
      <ChargeNewForm
        action={createFreeChargeAction}
        clients={clients.map((x) => ({ id: x.id, name: x.name, hasEmail: Boolean(x.email?.trim()) }))}
        matrix={options.matrix}
        defaultProvider={options.defaultProvider}
        providerLabels={providerLabels(t)}
        placeholder={moneyPlaceholder(locale)}
        initialClientId={initial}
        labels={{
          client: c.fieldClient,
          pickClient: c.pickClient,
          label: c.fieldLabel,
          amount: fmt(c.fieldAmount, { currency: options.currency }),
          kind: c.fieldKind,
          kindOneTime: c.kindOneTime,
          kindMonthly: c.kindMonthly,
          provider: c.providerLabel,
          create: c.create,
          cancel: t.common.cancel,
          // Only the owner reaches Settings → Payments, so a manager is told to ask.
          manualHint: me.user.role === "owner" ? c.manualHint : c.manualHintAsk,
        }}
      />
    </div>
  );
}
