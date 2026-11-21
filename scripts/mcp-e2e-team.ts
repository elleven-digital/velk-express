/**
 * Team checks of the connector's end-to-end run (loaded by scripts/mcp-e2e.ts):
 * the owner lists the team and invites someone (the link never comes back,
 * with or without e-mail); the collaborator can't list the team.
 */
import type { Ctx } from "./mcp-e2e";

export async function run({ restore, sql, call, data, sentence, check, section, collaborator, ownerToken, connect }: Ctx) {
  section("Team — owner");
  restore(() => sql`delete from users where email = 'e2e-invite@velk.test'`);
  const team = data(await call(ownerToken, "list_team"));
  check(
    "list_team gives the owner e-mails and pending invites",
    team.members?.length > 0 && team.members.every((m: Record<string, unknown>) => typeof m.email === "string" && "invite_pending" in m),
    team.members?.[0],
  );
  const invite = await call(ownerToken, "invite_member", { name: "E2E Invite", email: "e2e-invite@velk.test", role: "collaborator" });
  const invited = data(invite);
  const [row] = await sql`select role, password_hash from users where email = 'e2e-invite@velk.test'`;
  check("invite_member creates a pending member", row?.role === "collaborator" && row.password_hash === null, row);
  check(
    "the invite answer says whether an e-mail went out, and never carries the link",
    typeof invited.email_sent === "boolean" &&
      (invited.email_sent || invited.team_url?.endsWith("/admin/team")) &&
      !JSON.stringify(invite).includes("/set-password"),
    invited,
  );
  data(await call(ownerToken, "remove_member", { user_id: invited.member?.id }));
  const [gone] = await sql`select count(*)::int as n from users where email = 'e2e-invite@velk.test'`;
  check("remove_member removes them", gone.n === 0, gone.n);

  section("Team — collaborator");
  const collabToken = (await connect(collaborator.id)).access_token;
  const refused = await call(collabToken, "list_team");
  check("a collaborator can't list the team", refused.isError === true && sentence(refused).includes("owners and managers"), sentence(refused));
}
