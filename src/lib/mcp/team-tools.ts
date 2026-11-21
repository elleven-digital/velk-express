import "server-only";
import * as z from "zod";
import { getAppUrl } from "@/lib/app-url";
import type { TeamSession } from "@/lib/auth/session";
import { getAgencyRotation, setMemberClients } from "@/lib/core/assignments";
import { listClients } from "@/lib/core/clients";
import { changeRole, inviteMember, listMembers, removeMember, ROLES, type MemberRow } from "@/lib/core/team";
import { panelBase } from "@/lib/mcp/present";
import {
  dictFor,
  PEOPLE_TEXT,
  READ_ONLY,
  recordWrite,
  refused,
  teamTool,
  toolData,
  writeAnnotations,
  written,
  type ToolRegistrar,
} from "@/lib/mcp/tools";

/**
 * The agency's team, as the panel's Team page (the owner's) and the team list
 * Settings shows owners and managers for the rotation (names and roles).
 * Inviting, changing roles, removing people and setting a member's clients are
 * the owner's, as in the panel. Invite links never come back: the panel's Team
 * page has them.
 */

export const TEAM_TOOLS = ["list_team", "invite_member", "change_member_role", "remove_member", "set_member_clients"] as const;

const ROLE = z.enum(ROLES);
const MEMBER_ID = z.string().describe("The team member's user id (from list_team).");

/** The Team page, where the owner copies invite links. */
const teamUrl = (appUrl: string) => `${panelBase(appUrl)}/admin/team`;

/** Client names by id, for the clients a member takes part in. */
async function clientNames(actor: TeamSession): Promise<Map<string, string>> {
  return new Map((await listClients(actor)).map((c) => [c.id, c.name]));
}

function presentMember(m: MemberRow, ctx: { you: string; rotation: Set<string>; clients: Map<string, string> | null }) {
  const base = { id: m.id, name: m.name, role: m.role, you: m.id === ctx.you, in_auto_assign: ctx.rotation.has(m.id) };
  if (!("email" in m) || !ctx.clients) return base;
  const names = ctx.clients;
  return {
    ...base,
    email: m.email,
    invite_pending: m.pending,
    clients: m.clientIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) ?? "" })),
  };
}

/** One member as list_team shows them to this actor; null when gone. */
async function memberOf(actor: TeamSession, userId: string) {
  const members = await listMembers(actor);
  const member = members.ok ? members.value.find((m) => m.id === userId) : undefined;
  if (!member) return null;
  const [rotation, clients] = await Promise.all([getAgencyRotation(), "email" in member ? clientNames(actor) : null]);
  return presentMember(member, { you: actor.user.id, rotation: new Set(rotation.userIds), clients });
}

export const registerTeamTools: ToolRegistrar = (server, scope) => {
  server.registerTool(
    "list_team",
    {
      description:
        "The agency's team, oldest first, with who is in the agency's automatic rotation. Owners get the Team page: each member's e-mail, whether the invite is still pending (no password set yet) and the clients each one takes part in. Managers get names and roles. Collaborators can't list the team." +
        PEOPLE_TEXT,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    teamTool(scope, "list_team", "staff", async (actor) => {
      const members = await listMembers(actor);
      if (!members.ok) return refused(actor, members.error, "team");
      const owner = actor.user.role === "owner";
      const [rotation, clients] = await Promise.all([getAgencyRotation(), owner ? clientNames(actor) : null]);
      const ctx = { you: actor.user.id, rotation: new Set(rotation.userIds), clients };
      return toolData({ members: members.value.map((m) => presentMember(m, ctx)) });
    }),
  );

  server.registerTool(
    "invite_member",
    {
      description:
        "Owners: invites someone to the team by e-mail (they get a link to set a password; the link itself never comes back here). Refused when the e-mail is already on the team. The answer says whether the e-mail went out; when it didn't, the link is on the panel's Team page (team_url). Only when the connected person asks.",
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        email: z.string().min(3).max(254),
        role: ROLE.optional().describe("owner, manager or collaborator (default)."),
      }),
      annotations: writeAnnotations({ destructive: false }),
    },
    teamTool(scope, "invite_member", "owner", async (actor, args) => {
      const result = await inviteMember(actor, { name: args.name, email: args.email, role: args.role ?? "collaborator" });
      if (!result.ok) return refused(actor, result.error, "team");
      recordWrite(scope, actor, "invite_member");
      const { userId, emailed } = result.value;
      const member = await memberOf(actor, userId);
      return written({
        member: member ?? { id: userId },
        email_sent: emailed,
        ...(emailed ? {} : { notice: dictFor(actor).mcp.teamInviteNotEmailed, team_url: teamUrl(await getAppUrl()) }),
      });
    }),
  );

  server.registerTool(
    "change_member_role",
    {
      description:
        "Owners: changes a member's role (owner, manager or collaborator); it applies from their next request. The agency always keeps an owner who can sign in. Only when the connected person asks.",
      inputSchema: z.object({ user_id: MEMBER_ID, role: ROLE }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "change_member_role", "owner", async (actor, args) => {
      const result = await changeRole(actor, args.user_id, args.role);
      if (!result.ok) return refused(actor, result.error, "team");
      recordWrite(scope, actor, "change_member_role");
      const member = await memberOf(actor, args.user_id);
      return written({ member: member ? { id: member.id, name: member.name, role: member.role } : { id: args.user_id, role: args.role } });
    }),
  );

  server.registerTool(
    "remove_member",
    {
      description:
        "Owners: removes a member from the team — their account, sessions and AI connections go at once. Nobody removes themselves, and the last owner stays. Only when the connected person asks.",
      inputSchema: z.object({ user_id: MEMBER_ID }),
      annotations: writeAnnotations({ destructive: true }),
    },
    teamTool(scope, "remove_member", "owner", async (actor, args) => {
      const result = await removeMember(actor, args.user_id);
      if (!result.ok) return refused(actor, result.error, "team");
      recordWrite(scope, actor, "remove_member");
      return written({ removed_user_id: args.user_id });
    }),
  );

  server.registerTool(
    "set_member_clients",
    {
      description:
        "Owners: sets which clients a member takes part in (replaces the whole list; an empty list removes them from every client; unknown ids are ignored). It matters for collaborators, who may only see their clients when the agency says so.",
      inputSchema: z.object({
        user_id: MEMBER_ID,
        client_ids: z.array(z.string()).max(500).describe("Client ids (from list_clients)."),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "set_member_clients", "owner", async (actor, args) => {
      const result = await setMemberClients(actor, args.user_id, args.client_ids);
      if (!result.ok) return refused(actor, result.error, "team");
      recordWrite(scope, actor, "set_member_clients");
      const member = await memberOf(actor, args.user_id);
      return written({ user_id: args.user_id, clients: member && "clients" in member ? member.clients : [] });
    }),
  );
};
