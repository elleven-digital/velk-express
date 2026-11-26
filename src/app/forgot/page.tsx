import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { ForgotForm } from "@/components/auth-forms";
import { getAgency, logoPath } from "@/lib/agency";
import { getConfig } from "@/lib/config";
import { canDeliverResetMail } from "@/lib/auth/reset-policy";
import { parseSide } from "@/lib/auth/credentials";
import { getPublicDict } from "@/lib/i18n/server";
import { forgotAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ side?: string | string[] }> }) {
  const side = parseSide((await searchParams).side);
  const { t, locale } = await getPublicDict();
  const agency = await getAgency();
  const canMail = canDeliverResetMail(getConfig().mail);

  return (
    <AuthShell

      language={{ value: locale, label: t.ui.language }}
      title={t.auth.forgotTitle}
      sub={canMail ? t.auth.forgotSub : side === "portal" ? t.auth.forgotNoMailPortal : t.auth.forgotNoMailTeam}
      agency={{ name: agency?.name ?? "Velk Express", logoUrl: logoPath(agency?.logoFileId ?? null) }}
      areaLabel={side === "portal" ? t.auth.portalAreaLabel : t.auth.areaLabel}
      footer={
        <Link href={side === "portal" ? "/login" : "/admin/login"} className="font-medium text-ink hover:underline underline-offset-[3px]">
          {t.auth.backToLogin}
        </Link>
      }
    >
      {!canMail && side !== "portal" ? (
        <a
          href="https://github.com/elleven-digital/velk-express/blob/main/docs/backup-and-restore.md#recovering-the-owner-account"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[0.875rem] font-medium text-ink hover:underline underline-offset-[3px]"
        >
          {t.auth.forgotGuideLink}
        </a>
      ) : null}
      {canMail ? (
        <ForgotForm
          side={side}
          action={forgotAction}
          labels={{ email: t.common.email, submit: t.ui.sendResetLink, sent: t.ui.resetLinkSent }}
        />
      ) : null}
    </AuthShell>
  );
}
