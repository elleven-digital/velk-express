import { notFound, redirect } from "next/navigation";
import { PortalUsersPanel, type PortalUsersLabels } from "@/components/portal-users-panel";
import { isStaff } from "@/lib/access";
import { requireTeam } from "@/lib/auth/guards";
import { listCompanyUsers } from "@/lib/core/portal-users";
import { getUserDict } from "@/lib/i18n/server";
import {
  createPortalResetLinkAction,
  invitePortalUserAction,
  removePortalUserAction,
  resendPortalInviteAction,
  setPortalRoleAction,
} from "../../actions";

export const dynamic = "force-dynamic";

/** Who signs in to the portal for this client. Owners and managers only; collaborators go back to the overview. */
export default async function ClientAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireTeam();
  if (!isStaff(me.user)) redirect(`/admin/clients/${id}`);
  const [res, { t }] = await Promise.all([listCompanyUsers(me, id), getUserDict()]);
  if (!res.ok) notFound();

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
    confirm: {
      title: p.confirmTitle,
      companies: p.confirmCompanies,
      pending: p.confirmPending,
      active: p.confirmActive,
      admin: p.confirmAdmin,
      activeWarning: p.confirmActiveWarning,
      link: p.confirmLink,
      cancel: p.confirmCancel,
    },
  };

  return (
    <>
      <p className="mb-6 max-w-[62ch] text-muted">{t.clients.accessSub}</p>
      <PortalUsersPanel
        users={res.value}
        labels={labels}
        actions={{
          invite: invitePortalUserAction.bind(null, id),
          setRole: setPortalRoleAction.bind(null, id),
          remove: removePortalUserAction.bind(null, id),
          resend: resendPortalInviteAction.bind(null, id),
          resetLink: createPortalResetLinkAction.bind(null, id),
        }}
      />
    </>
  );
}
