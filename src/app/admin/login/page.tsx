import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";
import { getAgency, logoPath } from "@/lib/agency";
import { getTeamSession } from "@/lib/auth/session";
import { fmt } from "@/lib/i18n";
import { getPublicDict } from "@/lib/i18n/server";
import { safeReturnPath } from "@/lib/auth/return-path";
import { loginAction } from "./actions";

export const dynamic = "force-dynamic";

/** `next`: an internal path to return to after login (e.g. the AI-app authorize page). */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const raw = (await searchParams).next;
  const next = safeReturnPath(typeof raw === "string" ? raw : null);
  if (await getTeamSession()) redirect(next ?? "/admin");
  const { t, locale } = await getPublicDict();
  const agency = await getAgency();
  const name = agency?.name ?? "Velk Express";

  return (
    <AuthShell

      language={{ value: locale, label: t.ui.language }}
      title={t.auth.teamAreaTitle}
      sub={fmt(t.auth.loginSub, { agency: name })}
      agency={{ name, logoUrl: logoPath(agency?.logoFileId ?? null) }}
      footer={
        <Link href="/login" className="font-medium text-ink hover:underline underline-offset-[3px]">
          {t.auth.portalLoginLink}
        </Link>
      }
    >
      <LoginForm
        action={loginAction}
        next={next ?? undefined}
        labels={{
          email: t.common.email,
          password: t.common.password,
          submit: t.ui.logIn,
          forgot: t.ui.forgotPassword,
          forgotHref: "/forgot?side=team",
        }}
      />
    </AuthShell>
  );
}
