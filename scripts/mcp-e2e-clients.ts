/**
 * Client checks of the connector's end-to-end run (loaded by scripts/mcp-e2e.ts):
 * the owner creates a client and changes only part of its plan and sites,
 * records hours, invites a portal login (with or without e-mail, the link
 * never comes back) and a collaborator reads the client without its money.
 */
import type { Ctx } from "./mcp-e2e";

export async function run({ restore, sql, call, data, sentence, check, section, collaborator, ownerToken, connect }: Ctx) {
  section("Clients — owner");
  const created = data(await call(ownerToken, "create_client", { name: "E2E — Floricultura Ipê", email: "contato@ipe.test" }));
  const clientId = created.client?.id;
  // Deleting the client takes its sites, purchases and memberships with it; the login goes below.
  restore(() => sql`delete from clients where id = ${clientId}`);
  restore(() => sql`delete from client_users where email = 'e2e-portal@ipe.test'`);
  const [row] = await sql`select name, email from clients where id = ${clientId}`;
  check("create_client writes the client", row?.name === "E2E — Floricultura Ipê" && row.email === "contato@ipe.test", row);

  data(
    await call(ownerToken, "update_client", {
      client_id: clientId,
      support_active: true,
      monthly_amount: "900,00",
      hours_mode: "package",
      included_minutes_per_month: 300,
      extra_hour_amount: "120",
    }),
  );
  const site = data(await call(ownerToken, "add_site", { client_id: clientId, name: "Loja", url: "ipe.test", in_support_plan: true })).site;
  data(await call(ownerToken, "update_client", { client_id: clientId, monthly_amount: "950,00" }));
  data(await call(ownerToken, "update_site", { client_id: clientId, site_id: site?.id, name: "Loja online" }));
  const [plan] = await sql`select support_monthly_cents, hours_mode, included_minutes, extra_hour_cents from clients where id = ${clientId}`;
  const [siteRow] = await sql`select name, url, included_in_support from sites where id = ${site?.id}`;
  check(
    "update_client with only monthly_amount keeps the package and its minutes",
    plan?.support_monthly_cents === 95000 && plan.hours_mode === "package" && plan.included_minutes === 300 && plan.extra_hour_cents === 12000,
    plan,
  );
  check(
    "update_site with only a name keeps the site in the plan",
    siteRow?.name === "Loja online" && siteRow.url === "https://ipe.test" && siteRow.included_in_support === true,
    siteRow,
  );

  const cycle = new Date().toISOString().slice(0, 7);
  const pack = data(await call(ownerToken, "add_hour_package", { client_id: clientId, minutes: 90, cycle, price: "150,00" }));
  const [purchase] = await sql`select minutes, price_cents from hour_purchases where id = ${pack.hour_package?.id}`;
  check("add_hour_package records minutes and the panel's price", purchase?.minutes === 90 && purchase.price_cents === 15000, purchase);
  const hours = data(await call(ownerToken, "get_hours", { client_id: clientId, cycle })).hours;
  check("get_hours shows the package", hours?.included_minutes === 300 && hours.purchased_minutes === 90, hours);

  const invite = await call(ownerToken, "invite_to_portal", {
    client_id: clientId,
    name: "Iara",
    email: "e2e-portal@ipe.test",
    role: "admin",
  });
  const invited = data(invite);
  const [login] = await sql`select password_hash from client_users where email = 'e2e-portal@ipe.test'`;
  check("invite_to_portal creates a pending login", invited.outcome === "invited" && login && login.password_hash === null, invited);
  check(
    "the invite answer says whether an e-mail went out, and never carries the link",
    typeof invited.email_sent === "boolean" &&
      (invited.email_sent || invited.access_url?.endsWith(`/admin/clients/${clientId}/access`)) &&
      !JSON.stringify(invite).includes("/set-password"),
    invited,
  );
  const access = data(await call(ownerToken, "get_portal_access", { client_id: clientId }));
  check("get_portal_access lists the login as invited", access.logins?.[0]?.status === "invited", access.logins);
  data(await call(ownerToken, "cancel_portal_invite", { client_id: clientId, portal_user_id: invited.portal_user_id }));
  const [cancelled] = await sql`select count(*)::int as n from client_users where email = 'e2e-portal@ipe.test'`;
  check("cancel_portal_invite removes the pending login", cancelled.n === 0, cancelled.n);

  section("Clients — collaborator");
  await sql`insert into client_assignments (client_id, user_id) values (${clientId}, ${collaborator.id})`;
  const collabToken = (await connect(collaborator.id)).access_token;
  const seen = data(await call(collabToken, "get_client", { client_id: clientId })).client;
  check(
    "get_client as a collaborator: the plan, no money, team or rotation",
    seen?.support?.hours_mode === "package" && !("monthly_cents" in seen.support) && !("team" in seen) && !("rotation" in seen),
    seen,
  );
  const refused = await call(collabToken, "get_hours", { client_id: clientId });
  check("a collaborator can't read the Hours tab", refused.isError === true && sentence(refused).includes("owners and managers"), sentence(refused));
}
