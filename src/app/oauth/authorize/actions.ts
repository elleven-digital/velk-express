"use server";

import { redirect } from "next/navigation";
import { getPortalSession, getTeamSession } from "@/lib/auth/session";
import {
  AUTHORIZE_FIELDS,
  authorizeAttemptAllowed,
  authorizePagePath,
  authorizeRedirect,
  checkAuthorizeRequest,
  type AuthorizeCheck,
  type AuthorizeQuery,
} from "@/lib/oauth/authorize-request";
import { createAuthorizationCode } from "@/lib/oauth/store";

/**
 * The two buttons of "Authorize access". Both start from the session and
 * check the request again from scratch: the form is what the browser sent
 * and may have been changed after the page showed it.
 */

function queryFromForm(formData: FormData): AuthorizeQuery {
  const query: AuthorizeQuery = {};
  for (const name of AUTHORIZE_FIELDS) {
    const values = formData.getAll(name).filter((v): v is string => typeof v === "string");
    if (values.length === 1) query[name] = values[0];
    else if (values.length > 1) query[name] = values;
  }
  return query;
}

function refuse(check: Exclude<AuthorizeCheck, { ok: true }>, query: AuthorizeQuery): never {
  if ("show" in check) redirect(authorizePagePath(query));
  redirect(check.redirectTo);
}

/** Authorize: creates the code for the team member and returns to the app with it. */
export async function approveAuthorization(formData: FormData): Promise<void> {
  const query = queryFromForm(formData);
  // No team session (none, or only a portal one): back to the page, which sends to login or explains.
  const session = await getTeamSession();
  if (!session) redirect(authorizePagePath(query));
  if (!authorizeAttemptAllowed(`team:${session.user.id}`)) redirect(authorizePagePath(query));
  const check = await checkAuthorizeRequest(query);
  if (!check.ok) refuse(check, query);

  const code = await createAuthorizationCode({
    userId: session.user.id,
    clientId: check.client.clientId,
    redirectUri: check.redirectUri,
    codeChallenge: check.codeChallenge,
    resource: check.resource,
  });
  redirect(await authorizeRedirect(check.redirectUri, { code }, check.state));
}

/** Decline (a team or portal session): back to the app with `access_denied`, no code. */
export async function denyAuthorization(formData: FormData): Promise<void> {
  const query = queryFromForm(formData);
  const team = await getTeamSession();
  const portal = team ? null : await getPortalSession();
  // Signed out, the page never shows this button: back to it (and to login), with no app lookup.
  const who = team ? `team:${team.user.id}` : portal ? `portal:${portal.user.id}` : null;
  if (!who || !authorizeAttemptAllowed(who)) redirect(authorizePagePath(query));
  const check = await checkAuthorizeRequest(query);
  if (!check.ok) refuse(check, query);
  redirect(await authorizeRedirect(check.redirectUri, { error: "access_denied" }, check.state));
}
