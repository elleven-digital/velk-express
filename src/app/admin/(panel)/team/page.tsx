import { asc } from "drizzle-orm";
import { Badge, Card, PageHeader, SectionTitle } from "@/components/ui";
import { requireTeam } from "@/lib/auth/guards";
import { listMembers, type FullMemberRow } from "@/lib/core/team";
import { clients, db, type UserRole } from "@/lib/db";
import { getUserDict } from "@/lib/i18n/server";
import {
  changeRoleAction,
  inviteAction,
  removeMemberAction,
  resendInviteAction,
  resetLinkAction,
  setMemberClientsAction,
} from "./actions";
import { InviteForm, MemberControls, type TeamLabels } from "./team-forms";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const me = await requireTeam(["owner"]);
  const { t } = await getUserDict();

  const [listed, allClients] = await Promise.all([
    listMembers(me),
    db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name), asc(clients.id)),
  ]);
  // The page is the owner's, so every row is a full one.
  const members = listed.ok ? listed.value.filter((m): m is FullMemberRow => "email" in m) : [];
  const roles: Record<UserRole, string> = {
    owner: t.team.roleOwner,
    manager: t.team.roleManager,
    collaborator: t.team.roleCollaborator,
  };
  const labels: TeamLabels = {
    role: t.team.role,
    roles,
    inviteButton: t.team.inviteButton,
    rolesHint: t.team.rolesHint,
    name: t.common.name,
    email: t.common.email,
    saveRole: t.team.saveRole,
    resendInvite: t.team.resendInvite,
    resetLink: t.team.resetLink,
    remove: t.team.remove,
    confirmRemove: t.team.confirmRemove,
    linkTitle: t.team.linkTitle,
    linkHint: t.team.linkHint,
    expiresInvite: t.team.expiresInvite,
    expiresReset: t.team.expiresReset,
    emailSent: t.team.emailSent,
    emailNotSent: t.team.emailNotSent,
    copyLink: t.team.copyLink,
    copiedLink: t.team.copiedLink,
    clientsOf: t.team.clientsOf,
    noClientsYet: t.team.noClientsYet,
    saveClients: t.team.saveClients,
  };
  const actions = {
    changeRole: changeRoleAction,
    resendInvite: resendInviteAction,
    resetLink: resetLinkAction,
    remove: removeMemberAction,
    setClients: setMemberClientsAction,
  };

  return (
    <>
      <PageHeader title={t.team.title} sub={t.team.sub} />
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="min-w-0 divide-y divide-line">
          {members.map((member) => {
            const isMe = member.id === me.user.id;
            return (
              <div key={member.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="truncate font-medium text-ink">
                      {member.name}
                      {isMe ? <span className="font-normal text-muted"> · {t.team.you}</span> : null}
                    </div>
                    <div className="truncate text-muted">{member.email}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {member.pending ? <Badge tone="warn">{t.team.pendingInvite}</Badge> : null}
                    <Badge tone={member.role === "owner" ? "ink" : "lav"}>{roles[member.role]}</Badge>
                  </div>
                </div>
                {isMe ? null : (
                  <div className="mt-3">
                    <MemberControls
                      member={{ ...member, isMe }}
                      clients={allClients}
                      actions={actions}
                      labels={labels}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        <Card className="p-6 max-sm:p-4 lg:sticky lg:top-6">
          <SectionTitle className="mb-4">{t.team.inviteTitle}</SectionTitle>
          <InviteForm action={inviteAction} labels={labels} />
        </Card>
      </div>
    </>
  );
}
