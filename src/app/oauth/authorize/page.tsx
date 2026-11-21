import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { Button, LinkButton } from "@/components/ui";
import { getAgency, logoPath } from "@/lib/agency";
import { getPortalSession, getTeamSession } from "@/lib/auth/session";
import { fmt } from "@/lib/i18n";
import { getPortalDict, getUserDict } from "@/lib/i18n/server";
import {
  AUTHORIZE_FIELDS,
  authorizeAttemptAllowed,
  authorizePagePath,
  checkAuthorizeRequest,
  type AuthorizeQuery,
} from "@/lib/oauth/authorize-request";
import { approveAuthorization, denyAuthorization } from "./actions";

export const dynamic = "force-dynamic";

async function dictForViewer() {
  return (await getTeamSession()) ? getUserDict() : getPortalDict();
}

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await dictForViewer();
  return { title: t.oauth.title, robots: { index: false, follow: false } };
}

/**
 * "Authorize access": an AI app (Claude, ChatGPT) asks to act in the panel
 * on a team member's behalf. They see who asks, what it will be able to do
 * (everything they can do in the agency) and where they go back to, and pick
 * Authorize or Decline.
 *
 * The app's name is whatever it said about itself — anyone can register an
 * app called "Claude" — so the page shows the return address and, for
 * dynamically registered apps, says the name wasn't verified. It's rendered
 * as text.
 *
 * Without a team session the page sends to the team login with the whole
 * request in `next`. A portal session can't authorize: the page says so and
 * only offers Decline (or logging in as a team member).
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<AuthorizeQuery> }) {
  const query = await searchParams;
  const here = authorizePagePath(query);
  const loginHref = `/admin/login?next=${encodeURIComponent(here)}`;
  const team = await getTeamSession();
  const portal = team ? null : await getPortalSession();
  const who = team ? `team:${team.user.id}` : portal ? `portal:${portal.user.id}` : null;
  if (!who) redirect(loginHref);

  const { t } = await dictForViewer();
  const agency = await getAgency();
  const agencyName = agency?.name ?? "Velk Express";
  const shell = (body: ReactNode) => (
    <AuthShell
      title={t.oauth.title}
      agency={{ name: agencyName, logoUrl: logoPath(agency?.logoFileId ?? null) }}
      areaLabel={t.auth.areaLabel}
      wide
    >
      {body}
    </AuthShell>
  );
  const failure = (message: string) =>
    shell(
      <>
        <p role="alert" className="mb-6 text-[0.875rem] leading-relaxed text-muted">
          {message}
        </p>
        <LinkButton href={team ? "/admin" : "/"} variant="secondary">
          {t.oauth.goHome}
        </LinkButton>
      </>,
    );

  if (!authorizeAttemptAllowed(who)) return failure(t.oauth.tooMany);
  const check = await checkAuthorizeRequest(query);
  if (!check.ok) {
    if ("redirectTo" in check) redirect(check.redirectTo);
    return failure(t.oauth[check.show]);
  }

  const hidden = AUTHORIZE_FIELDS.map((name) => {
    const value = query[name];
    return typeof value === "string" ? <input key={name} type="hidden" name={name} value={value} /> : null;
  });

  if (!team) {
    return shell(
      <form action={denyAuthorization}>
        {hidden}
        <p className="mb-6 text-[0.875rem] leading-relaxed text-muted">{t.oauth.clientAccount}</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <LinkButton href={loginHref} variant="secondary">
            {t.oauth.teamLogin}
          </LinkButton>
          <Button type="submit">{t.oauth.deny}</Button>
        </div>
      </form>,
    );
  }

  const { client } = check;
  const returnOrigin = new URL(check.redirectUri).origin;
  const appOrigin = client.kind === "metadata_document" ? new URL(client.clientId).origin : returnOrigin;
  const domain = new URL(appOrigin).host;

  return shell(
    <form action={approveAuthorization}>
      {hidden}
      <div className="mb-8 space-y-3 break-words text-[0.875rem] leading-relaxed text-muted">
        <p>
          <strong className="font-semibold text-ink">{client.name}</strong>{" "}
          <strong className="font-medium text-ink">{`(${domain})`}</strong> {t.oauth.wants}
        </p>
        <p>{fmt(t.oauth.actsAs, { name: team.user.name, agency: agencyName })}</p>
        <p>
          {t.oauth.returnTo} <strong className="font-medium text-ink">{returnOrigin}</strong>
        </p>
        {client.kind === "registered" ? <p>{t.oauth.selfDeclared}</p> : null}
        {returnOrigin !== appOrigin ? (
          <p role="note" className="text-ink">
            {t.oauth.otherSite}
          </p>
        ) : null}
        <p>{t.oauth.revokeHint}</p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="submit" variant="ghost" formAction={denyAuthorization}>
          {t.oauth.deny}
        </Button>
        <Button type="submit">{t.oauth.authorize}</Button>
      </div>
    </form>,
  );
}
