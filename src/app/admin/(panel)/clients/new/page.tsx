import { PageHeader } from "@/components/ui";
import { requireTeam } from "@/lib/auth/guards";
import { getUserDict } from "@/lib/i18n/server";
import { createClientAction } from "../actions";
import { CompanyForm, SettingsCard } from "../client-forms";

export const dynamic = "force-dynamic";

export default async function NewClientPage() {
  await requireTeam(["owner", "manager"]);
  const { t } = await getUserDict();

  return (
    <div className="max-w-2xl">
      {/* a string title also names the page in the top bar: "Clients / New client" */}
      <PageHeader title={t.clients.new} />
      <SettingsCard title={t.clients.companySection}>
        <CompanyForm action={createClientAction} labels={t.clients} />
      </SettingsCard>
    </div>
  );
}
