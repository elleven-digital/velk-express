import { headers } from "next/headers";
import { AuthShell } from "@/components/auth-shell";
import { getConfig } from "@/lib/config";
import { detectAppUrl } from "@/lib/app-url";
import { LOCALES, LOCALE_NAMES, fmt } from "@/lib/i18n";
import { getPublicDict } from "@/lib/i18n/server";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { timeZoneGroups } from "@/lib/time-zone";
import { InstallForm } from "./install-form";

export const dynamic = "force-dynamic";

export default async function InstallPage() {
  const { t, locale } = await getPublicDict();
  const i = t.install;
  const fixedUrl = getConfig().appUrl;
  const detectedUrl = detectAppUrl(await headers()) ?? "";

  return (
    <AuthShell
      title={i.title}
      sub={i.sub}
      kicker={i.kicker}
      agency={{ name: "Velk Express" }}
      wide
    >
      <InstallForm
        labels={{
          agencyName: i.agencyName,
          ownerName: i.ownerName,
          email: i.email,
          password: i.password,
          passwordHint: fmt(i.passwordHint, { min: MIN_PASSWORD_LENGTH }),
          publicUrl: i.publicUrl,
          publicUrlHint: i.publicUrlHint,
          publicUrlFixed: i.publicUrlFixed,
          currency: i.currency,
          language: i.language,
          timeZone: i.timeZone,
          timeZoneHint: i.timeZoneHint,
          submit: i.submit,
        }}
        detectedUrl={detectedUrl}
        fixedUrl={fixedUrl}
        defaultLocale={locale}
        localeOptions={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
        currencies={["BRL", "USD", "EUR"]}
        timeZones={timeZoneGroups()}
        minPassword={MIN_PASSWORD_LENGTH}
      />
    </AuthShell>
  );
}
