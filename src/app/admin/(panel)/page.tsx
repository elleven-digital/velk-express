import Link from "next/link";
import { Icon } from "@/components/icons";
import { Card, LinkButton, PageHeader, SectionTitle } from "@/components/ui";
import { getAgency } from "@/lib/agency";
import { requireTeam } from "@/lib/auth/guards";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

/** The panel home. Any team member lands here (a role check would loop with requireTeam's redirect). */
export default async function PanelHome() {
  const me = await requireTeam();
  const { t } = await getUserDict();
  const agency = await getAgency();
  const owner = me.user.role === "owner";
  const manager = me.user.role === "manager";
  const link = "font-medium text-ink underline underline-offset-2";

  return (
    <>
      <PageHeader
        title={fmt(t.panel.homeTitle, { agency: agency?.name ?? "Velk Express" })}
        sub={t.panel.homeSub}
        actions={
          owner ? (
            <LinkButton href="/admin/quotes/new" variant="secondary">
              <Icon name="file" />
              {t.panel.quickNewQuote}
            </LinkButton>
          ) : undefined
        }
      />
      <Card className="max-w-2xl p-6 max-sm:p-4">
        <SectionTitle className="mb-3">{t.panel.nextTitle}</SectionTitle>
        <ul className="space-y-2 text-[0.875rem] text-muted">
          <li>
            {owner ? (
              <Link href="/admin/team" className={link}>
                {t.panel.navTeam}
              </Link>
            ) : null}
            {owner ? ": " : null}
            {t.panel.stepTeam}
          </li>
          <li>
            {owner ? (
              <Link href="/admin/settings" className={link}>
                {t.panel.navSettings}
              </Link>
            ) : null}
            {owner ? ": " : null}
            {t.panel.stepSettings}
          </li>
          {owner ? (
            <li>
              <Link href="/admin/quotes" className={link}>
                {t.panel.navQuotes}
              </Link>
              : {t.panel.stepQuotes}
            </li>
          ) : null}
          {manager ? (
            <li>
              <Link href="/admin/charges" className={link}>
                {t.panel.navCharges}
              </Link>
              : {t.panel.stepCharges}
            </li>
          ) : null}
        </ul>
      </Card>
    </>
  );
}
