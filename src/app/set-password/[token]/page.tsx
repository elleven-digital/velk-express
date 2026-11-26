import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { SetPasswordForm } from "@/components/auth-forms";
import { buttonClasses } from "@/components/ui";
import { getAgency, logoPath } from "@/lib/agency";
import { peekPasswordToken } from "@/lib/auth/credentials";
import { getPublicDict } from "@/lib/i18n/server";
import { tokenUserType } from "@/lib/auth/tokens";
import { setPasswordAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { t, locale } = await getPublicDict();
  const agency = await getAgency();
  const brand = { name: agency?.name ?? "Velk Express", logoUrl: logoPath(agency?.logoFileId ?? null) };

  const owner = await peekPasswordToken(token);

  // An unusable link is a normal page (200), with a way to ask for another on the token's own side.
  if (!owner) {
    const portal = (await tokenUserType(token)) === "client";
    return (
      <AuthShell

        language={{ value: locale, label: t.ui.language }}
        title={t.auth.invalidLinkTitle}
        sub={t.auth.invalidLink}
        agency={brand}
        areaLabel={portal ? t.auth.portalAreaLabel : t.auth.areaLabel}
      >
        <Link href={portal ? "/forgot?side=portal" : "/forgot?side=team"} className={buttonClasses("primary", "md")}>
          {t.auth.requestNewLink}
        </Link>
      </AuthShell>
    );
  }

  const invite = owner.purpose === "invite";
  const areaLabel = owner.userType === "client" ? t.auth.portalAreaLabel : t.auth.areaLabel;
  return (
    <AuthShell

      language={{ value: locale, label: t.ui.language }}
      title={invite ? t.auth.setPasswordTitle : t.auth.resetTitle}
      sub={invite ? t.auth.setPasswordSub : t.auth.resetSub}
      agency={brand}
      areaLabel={areaLabel}
    >
      <SetPasswordForm
        action={setPasswordAction}
        token={token}
        nameField={invite ? { label: t.common.name, defaultValue: owner.name } : undefined}
        labels={{ password: t.ui.newPassword, confirm: t.ui.confirmPassword, submit: t.auth.setPasswordButton }}
      />
    </AuthShell>
  );
}
