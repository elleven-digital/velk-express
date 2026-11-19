import { redirect } from "next/navigation";
import { PortalUsersPanel, type PortalUsersLabels } from "@/components/portal-users-panel";
import { PageHeader } from "@/components/ui";
import { requirePortalAdmin } from "@/lib/auth/guards";
import { listCompanyUsers } from "@/lib/core/portal-users";
import { fmt } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";
import { portalInviteAction, portalRemoveAction, portalResendAction, portalRoleAction } from "./actions";

export const dynamic = "force-dynamic";

/** The people of the active company, for its admins; anyone else is sent back to the home. */
export default async function PortalUsersPage() {
  const session = await requirePortalAdmin();
  const [res, { t }] = await Promise.all([listCompanyUsers(session, session.client.id), getPortalDict()]);
  // The core re-reads the role: a demotion since the session was resolved means back home.
  if (!res.ok) redirect("/");

  const p = t.portalUsers;
  const labels: PortalUsersLabels = {
    listTitle: p.listTitle,
    empty: p.empty,
    inviteTitle: p.inviteTitle,
    inviteButton: p.inviteButton,
    name: t.common.name,
    email: t.common.email,
    role: p.role,
    roles: { admin: p.roleAdmin, collaborator: p.roleCollaborator },
    rolesHint: p.rolesHint,
    pending: p.pending,
    saveRole: p.saveRole,
    resendInvite: p.resendInvite,
    resetLink: p.resetLink,
    remove: p.remove,
    confirmRemove: p.confirmRemove,
    you: t.portal.you,
    linkTitle: p.linkTitle,
    linkHint: p.linkHint,
    expiresInvite: p.expiresInvite,
    expiresReset: p.expiresReset,
    emailSent: p.emailSent,
    emailNotSent: p.emailNotSent,
    copyLink: p.copyLink,
    copiedLink: p.copiedLink,
  };

  return (
    <div>
      <PageHeader title={t.portal.usersTitle} sub={fmt(t.portal.usersSub, { client: session.client.name })} crumb={null} />
      <PortalUsersPanel
        users={res.value}
        labels={labels}
        currentUserId={session.user.id}
        actions={{
          invite: portalInviteAction,
          setRole: portalRoleAction,
          remove: portalRemoveAction,
          resend: portalResendAction,
        }}
      />
    </div>
  );
}
