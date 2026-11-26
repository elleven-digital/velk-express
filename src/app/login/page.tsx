import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";
import { getAgency, logoPath } from "@/lib/agency";
import { getPortalSession } from "@/lib/auth/session";
import { fmt } from "@/lib/i18n";
import { getPublicDict } from "@/lib/i18n/server";
import { portalLoginAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function PortalLoginPage() {
  if (await getPortalSession()) redirect("/");
  const { t, locale } = await getPublicDict();
  const agency = await getAgency();
  const name = agency?.name ?? "Velk Express";

  return (
    <AuthShell

      language={{ value: locale, label: t.ui.language }}
      title={t.auth.portalAreaLabel}
      sub={fmt(t.auth.portalLoginSub, { agency: name })}
      agency={{ name, logoUrl: logoPath(agency?.logoFileId ?? null) }}
      footer={
        <Link href="/admin/login" className="font-medium text-ink hover:underline underline-offset-[3px]">
          {t.auth.teamLoginLink}
        </Link>
      }
    >
      <LoginForm
        action={portalLoginAction}
        labels={{
          email: t.common.email,
          password: t.common.password,
          submit: t.ui.logIn,
          forgot: t.ui.forgotPassword,
          forgotHref: "/forgot?side=portal",
        }}
      />
    </AuthShell>
  );
}
