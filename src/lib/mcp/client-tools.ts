import "server-only";
import * as z from "zod";
import { isStaff } from "@/lib/access";
import { agencyTimeZone, getAgency } from "@/lib/agency";
import { getAppUrl } from "@/lib/app-url";
import type { TeamSession } from "@/lib/auth/session";
import { getClientTeam, setClientAssignees, updateClientAutoAssign } from "@/lib/core/assignments";
import { chargeFor } from "@/lib/core/charges";
import {
  addSite,
  createClient,
  deleteSite,
  getClient,
  listClients,
  listSites,
  updateClient,
  updateSite,
  updateSupport,
  type SiteInput,
  type SupportInput,
} from "@/lib/core/clients";
import { addHourPurchase, deleteHourPurchase, getClientHoursCycle, getHoursSummary } from "@/lib/core/hours";
import {
  invitePortalUser,
  listCompanyUsers,
  removePortalUser,
  resendPortalInvite,
  setPortalRole,
} from "@/lib/core/portal-users";
import { fail, ok, type Result } from "@/lib/core/result";
import { listMembers } from "@/lib/core/team";
import { listTickets } from "@/lib/core/ticket-list";
import type { Client, Site } from "@/lib/db";
import { parseMoney } from "@/lib/format";
import { cycleKey } from "@/lib/hours";
import { hoursPlanOf, type HoursPlan } from "@/lib/hours-plan";
import {
  clientAccessUrl,
  clientUrl,
  presentClientDetail,
  presentClientHours,
  presentClientRow,
  presentPortalLogin,
  presentSite,
  type ClientDetail,
} from "@/lib/mcp/present-clients";
import {
  dictFor,
  minutesToDuration,
  PEOPLE_TEXT,
  READ_ONLY,
  recordWrite,
  refusalOf,
  refused,
  teamTool,
  toolData,
  toolError,
  writeAnnotations,
  written,
  type ToolRegistrar,
} from "@/lib/mcp/tools";

/**
 * Clients, as the panel's Clients pages: list and detail for everyone the
 * client is visible to; the rest — writing, money, team, rotation, the Hours
 * and Access tabs — is owners and managers only. Same cores as the panel.
 * The panel's forms send every field; these tools change only the fields
 * given, so they read the client first and merge (`mergeSupport`, `mergeSite`).
 */

export const CLIENT_TOOLS = [
  "list_clients",
  "get_client",
  "create_client",
  "update_client",
  "set_client_team",
  "set_client_rotation",
  "add_site",
  "update_site",
  "delete_site",
  "get_hours",
  "add_hour_package",
  "delete_hour_package",
  "get_portal_access",
  "invite_to_portal",
  "resend_portal_invite",
  "cancel_portal_invite",
  "set_portal_role",
  "remove_from_portal",
] as const;

const CLIENT_ID = z.string().describe("The client id (from list_clients).");
const SITE_ID = z.string().describe("The site id (from get_client).");
const PORTAL_USER_ID = z.string().describe("The portal login id (from get_portal_access).");
const CYCLE = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe("Monthly cycle, YYYY-MM, in the agency's time zone.");
const MONEY = (what: string) =>
  z
    .string()
    .max(50)
    .nullable()
    .optional()
    .describe(`${what}, in the agency's currency as typed in the panel (e.g. "1200", "1.200,50" or "1,200.50"; not cents). null or "" clears it.`);

/** A partial change of the support plan: what is left out keeps its current value, hours option by option. */
export type SupportPatch = Partial<Omit<SupportInput, "hours">> & { hours?: Partial<HoursPlan> };

/** `updateSupport` replaces the whole plan: the current plan with the patch on top. */
export function mergeSupport(current: { client: Client; sites: Site[] }, patch: SupportPatch): SupportInput {
  const { client, sites } = current;
  return {
    supportActive: patch.supportActive ?? client.supportActive,
    monthlyCents: patch.monthlyCents === undefined ? client.supportMonthlyCents : patch.monthlyCents,
    generalTickets: patch.generalTickets ?? client.generalTicketsEnabled,
    siteIdsInPlan: patch.siteIdsInPlan ?? sites.filter((s) => s.includedInSupport).map((s) => s.id),
    hours: { ...hoursPlanOf(client), ...patch.hours },
  };
}

/** Only the hours options given; undefined when none is, so an untouched plan does not count as a change. */
function hoursPatch(patch: Partial<HoursPlan>): Partial<HoursPlan> | undefined {
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<HoursPlan>;
  return Object.keys(given).length > 0 ? given : undefined;
}

/** `updateSite` replaces the whole site (a missing `includedInSupport` is false): the site with the patch on top. */
export function mergeSite(current: Site, patch: Partial<SiteInput>): SiteInput {
  return {
    name: patch.name ?? current.name,
    url: patch.url === undefined ? current.url : patch.url,
    notes: patch.notes === undefined ? current.notes : patch.notes,
    includedInSupport: patch.includedInSupport ?? current.includedInSupport,
  };
}

const given = (o: object) => Object.values(o).some((v) => v !== undefined);

/** A money field: left out keeps it (undefined), null or empty clears it, anything else must read as money. */
function moneyField(raw: string | null | undefined): Result<number | null | undefined> {
  if (raw === undefined) return ok(undefined);
  const text = (raw ?? "").trim();
  if (!text) return ok(null);
  const cents = parseMoney(text);
  return cents === null ? fail("invalid") : ok(cents);
}

/**
 * Everything the client's page shows the actor: the client, its sites, this
 * cycle's hours and open tickets; for staff also the money, the team, the
 * rotation and the support charge.
 */
async function clientDetail(actor: TeamSession, clientId: string): Promise<Result<ClientDetail>> {
  const found = await getClient(actor, clientId);
  if (!found.ok) return found;
  const client = found.value;
  const [sitesRes, hours, open] = await Promise.all([
    listSites(actor, client.id),
    getHoursSummary(client.id),
    listTickets(actor, { clientId: client.id, status: "open" }, 1),
  ]);
  if (!sitesRes.ok) return sitesRes;
  let staff: ClientDetail["staff"] = null;
  if (isStaff(actor.user)) {
    const [team, charge, members, brand] = await Promise.all([
      getClientTeam(client.id),
      chargeFor(actor, { source: "support", sourceId: client.id }),
      listMembers(actor),
      getAgency(),
    ]);
    const names = new Map((members.ok ? members.value : []).map((m) => [m.id, m.name]));
    staff = {
      currency: brand?.currency ?? null,
      team: team.assignees.map((u) => ({ id: u.id, name: u.name })),
      rotation: {
        enabled: team.rotation.enabled,
        people: team.rotation.userIds.map((id) => ({ id, name: names.get(id) ?? "" })),
      },
      supportCharge: charge.ok ? charge.value : null,
    };
  }
  return ok({ client, sites: sitesRes.value, hours, openTickets: open.total, staff });
}

/** After an invite or a resend: whether the e-mail went out, and where the link is when it didn't. Never the link. */
function mailOutcome(actor: TeamSession, emailed: boolean, accessUrl: string) {
  return emailed ? { email_sent: true } : { email_sent: false, notice: dictFor(actor).mcp.portalInviteNotEmailed, access_url: accessUrl };
}

export const registerClientTools: ToolRegistrar = (server, scope) => {
  // ---------- reading ----------

  server.registerTool(
    "list_clients",
    {
      description:
        "Lists the agency's clients the person can see (collaborators: per the agency's visibility rule), by name: contact e-mail, number of sites and support plan (track_hours, show_hours_to_client, included_minutes_per_month: null without included hours, client_can_buy_hours). Owners and managers also see the money." +
        PEOPLE_TEXT,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    teamTool(scope, "list_clients", "member", async (actor) => {
      const staff = isStaff(actor.user);
      const [rows, appUrl, brand] = await Promise.all([listClients(actor), getAppUrl(), staff ? getAgency() : null]);
      const money = { staff, currency: brand?.currency ?? null };
      return toolData({ clients: rows.map((r) => presentClientRow(r, appUrl, money)) });
    }),
  );

  server.registerTool(
    "get_client",
    {
      description:
        "One client as its panel page shows it: contact data, support plan (track_hours; show_hours_to_client = the client sees the hours in the portal; included_minutes_per_month = included hours with a balance, null without; client_can_buy_hours = the client buys extra hours in the portal), this month's hours in the agency's time zone, open tickets and sites (with their ids, for open_ticket's site_id). Owners and managers also get the money, the client's team, the ticket rotation and the support charge." +
        PEOPLE_TEXT,
      inputSchema: z.object({ client_id: CLIENT_ID }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "get_client", "member", async (actor, args) => {
      const detail = await clientDetail(actor, args.client_id);
      if (!detail.ok) return refused(actor, detail.error, "clients");
      return toolData({ client: presentClientDetail(detail.value, await getAppUrl()) });
    }),
  );

  server.registerTool(
    "get_hours",
    {
      description:
        "Owners and managers: a client's Hours tab for one monthly cycle (default: the current month in the agency's time zone) — how hours are kept (track_hours, show_hours_to_client, has_included_hours), the minutes (with included hours: included, purchased, used and balance; without: used), every time entry of the cycle (only support tickets count against the hours) and the hour packages with their charge. A client whose hours are not tracked, or are kept for the team only, says so in notice." +
        PEOPLE_TEXT,
      inputSchema: z.object({ client_id: CLIENT_ID, cycle: CYCLE.optional() }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "get_hours", "staff", async (actor, args) => {
      const found = await getClient(actor, args.client_id);
      if (!found.ok) return refused(actor, found.error, "hours");
      const cycle = args.cycle ?? cycleKey(new Date(), await agencyTimeZone());
      const res = await getClientHoursCycle(actor, found.value.id, cycle);
      if (!res.ok) return refused(actor, res.error, "hours");
      const { summary, entries, purchases } = res.value;
      const [appUrl, brand, charges] = await Promise.all([
        getAppUrl(),
        getAgency(),
        Promise.all(purchases.map((p) => chargeFor(actor, { source: "hours", sourceId: p.id }))),
      ]);
      const t = dictFor(actor);
      const notice = !summary.tracked ? t.hours.notTracked : !summary.visible ? t.hours.internalOnly : null;
      return toolData({
        hours: presentClientHours(
          {
            client: found.value,
            summary,
            entries,
            purchases: purchases.map((p, i) => ({ ...p, charge: charges[i].ok ? charges[i].value : null })),
            currency: brand?.currency ?? null,
            notice,
          },
          appUrl,
        ),
      });
    }),
  );

  server.registerTool(
    "get_portal_access",
    {
      description:
        "Owners and managers: who can enter the client's area (portal) — each login with its id, role (admin or collaborator) and status (invited = hasn't set a password yet, or active). Invite links stay in the panel (access_url)." +
        PEOPLE_TEXT,
      inputSchema: z.object({ client_id: CLIENT_ID }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "get_portal_access", "staff", async (actor, args) => {
      const found = await getClient(actor, args.client_id);
      if (!found.ok) return refused(actor, found.error, "clients");
      const logins = await listCompanyUsers(actor, found.value.id);
      if (!logins.ok) return refused(actor, logins.error, "portalUsers");
      return toolData({
        client: { id: found.value.id, name: found.value.name },
        logins: logins.value.map(presentPortalLogin),
        access_url: clientAccessUrl(await getAppUrl(), found.value.id),
      });
    }),
  );

  // ---------- client data ----------

  server.registerTool(
    "create_client",
    {
      description:
        "Owners and managers: registers a new client (company). Sites and the support plan come after (add_site, update_client).",
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        email: z.string().max(254).optional(),
        phone: z.string().max(50).optional(),
        notes: z.string().max(5000).optional(),
      }),
      annotations: writeAnnotations({ destructive: false }),
    },
    teamTool(scope, "create_client", "staff", async (actor, args) => {
      const result = await createClient(actor, args);
      if (!result.ok) return refused(actor, result.error, "clients");
      recordWrite(scope, actor, "create_client");
      const { clientId } = result.value;
      return written({ client: { id: clientId, name: args.name.trim(), url: clientUrl(await getAppUrl(), clientId) } });
    }),
  );

  server.registerTool(
    "update_client",
    {
      description:
        "Owners and managers: changes a client's data and/or support plan. Only the fields given change. Support rules (as in the panel): without support_active there is no monthly value, no general tickets, no hours and no site in the plan. Hours options, each needing the one before: track_hours (time is kept); show_hours_to_client (the client sees the hours in the portal); included_minutes_per_month (included hours with a balance; null removes them, and with them the extra hour price and buying); extra_hour_amount (needs included hours); client_can_buy_hours (the client buys extra hours in the portal: needs show_hours_to_client, included hours and an extra hour price). An option whose requirement is missing is turned off. The balance is informative: nothing is blocked. sites_in_plan replaces the set of the client's sites covered by the plan (ids from get_client).",
      inputSchema: z.object({
        client_id: CLIENT_ID,
        name: z.string().min(1).max(200).optional(),
        email: z.string().max(254).nullable().optional(),
        phone: z.string().max(50).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
        support_active: z.boolean().optional(),
        monthly_amount: MONEY("The support plan's monthly value"),
        general_tickets: z.boolean().optional().describe("Lets the client open tickets not tied to a site."),
        track_hours: z.boolean().optional(),
        show_hours_to_client: z.boolean().optional(),
        included_minutes_per_month: z.number().int().min(0).max(100000).nullable().optional(),
        extra_hour_amount: MONEY("The price of one extra hour (needs included hours)"),
        client_can_buy_hours: z.boolean().optional(),
        sites_in_plan: z.array(z.string()).max(200).optional(),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "update_client", "staff", async (actor, args) => {
      const found = await getClient(actor, args.client_id);
      if (!found.ok) return refused(actor, found.error, "clients");
      const sitesRes = await listSites(actor, found.value.id);
      if (!sitesRes.ok) return refused(actor, sitesRes.error, "clients");
      const client = found.value;

      // Both amounts are read before anything is written, so a bad one changes nothing.
      const monthly = moneyField(args.monthly_amount);
      if (!monthly.ok) return refused(actor, "invalidMoney", "clients");
      const extra = moneyField(args.extra_hour_amount);
      if (!extra.ok) return refused(actor, "invalidExtraHour", "clients");

      const data = { name: args.name, email: args.email, phone: args.phone, notes: args.notes };
      const support: SupportPatch = {
        supportActive: args.support_active,
        monthlyCents: monthly.value,
        generalTickets: args.general_tickets,
        siteIdsInPlan: args.sites_in_plan,
        hours: hoursPatch({
          tracked: args.track_hours,
          visible: args.show_hours_to_client,
          ...(args.included_minutes_per_month === undefined
            ? {}
            : args.included_minutes_per_month === null
              ? { limited: false }
              : { limited: true, includedMinutes: args.included_minutes_per_month }),
          extraHourCents: extra.value,
          purchasable: args.client_can_buy_hours,
        }),
      };

      if (given(data)) {
        const result = await updateClient(actor, client.id, {
          name: args.name ?? client.name,
          email: args.email === undefined ? client.email : args.email,
          phone: args.phone === undefined ? client.phone : args.phone,
          notes: args.notes === undefined ? client.notes : args.notes,
        });
        if (!result.ok) return refused(actor, result.error, "clients");
        recordWrite(scope, actor, "update_client");
      }
      if (given(support)) {
        const result = await updateSupport(actor, client.id, mergeSupport({ client, sites: sitesRes.value }, support));
        if (!result.ok) {
          // The client's data is already saved: say so, or the app would think nothing changed.
          if (!given(data)) return refused(actor, result.error, "clients");
          return toolError(`${refusalOf(actor, result.error, "clients")} ${dictFor(actor).mcp.clientDataSavedPlanNot}`);
        }
        if (!given(data)) recordWrite(scope, actor, "update_client");
      }
      const detail = await clientDetail(actor, client.id);
      if (!detail.ok) return refused(actor, detail.error, "clients");
      return written({ client: presentClientDetail(detail.value, await getAppUrl()) });
    }),
  );

  server.registerTool(
    "set_client_team",
    {
      description:
        "Owners and managers: replaces the team members taking part in the client (user ids from list_team; an empty list removes everyone). It matters for collaborators, who may only see their clients when the agency says so.",
      inputSchema: z.object({ client_id: CLIENT_ID, user_ids: z.array(z.string()).max(200) }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "set_client_team", "staff", async (actor, args) => {
      const result = await setClientAssignees(actor, args.client_id, args.user_ids);
      if (!result.ok) return refused(actor, result.error, "clients");
      recordWrite(scope, actor, "set_client_team");
      const team = await getClientTeam(args.client_id);
      return written({ client_id: args.client_id, team: team.assignees.map((u) => ({ id: u.id, name: u.name })) });
    }),
  );

  server.registerTool(
    "set_client_rotation",
    {
      description:
        "Owners and managers: the client's own rotation of client-opened support tickets, overriding the agency's. enabled turns it on (only when user_ids has someone); user_ids replaces who takes part (they also join the client).",
      inputSchema: z.object({
        client_id: CLIENT_ID,
        enabled: z.boolean(),
        user_ids: z.array(z.string()).max(200),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "set_client_rotation", "staff", async (actor, args) => {
      const result = await updateClientAutoAssign(actor, args.client_id, { enabled: args.enabled, userIds: args.user_ids });
      if (!result.ok) return refused(actor, result.error, "clients");
      recordWrite(scope, actor, "set_client_rotation");
      return written({ client_id: args.client_id, enabled: result.value.enabled });
    }),
  );

  // ---------- sites ----------

  server.registerTool(
    "add_site",
    {
      description:
        "Owners and managers: adds a site to a client. url may be typed as people do (\"acme.com\"). in_support_plan only sticks when the client has an active support plan.",
      inputSchema: z.object({
        client_id: CLIENT_ID,
        name: z.string().min(1).max(200),
        url: z.string().max(2048).optional(),
        notes: z.string().max(5000).optional(),
        in_support_plan: z.boolean().optional(),
      }),
      annotations: writeAnnotations({ destructive: false }),
    },
    teamTool(scope, "add_site", "staff", async (actor, args) => {
      const result = await addSite(actor, args.client_id, {
        name: args.name,
        url: args.url,
        notes: args.notes,
        includedInSupport: args.in_support_plan,
      });
      if (!result.ok) return refused(actor, result.error, "clients");
      recordWrite(scope, actor, "add_site");
      const listed = await listSites(actor, args.client_id);
      const site = listed.ok ? listed.value.find((s) => s.id === result.value.siteId) : undefined;
      return written({ client_id: args.client_id, site: site ? presentSite(site) : { id: result.value.siteId } });
    }),
  );

  server.registerTool(
    "update_site",
    {
      description:
        "Owners and managers: changes a client's site. Only the fields given change (null clears url or notes). in_support_plan only sticks when the client has an active support plan.",
      inputSchema: z.object({
        client_id: CLIENT_ID,
        site_id: SITE_ID,
        name: z.string().min(1).max(200).optional(),
        url: z.string().max(2048).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
        in_support_plan: z.boolean().optional(),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "update_site", "staff", async (actor, args) => {
      const listed = await listSites(actor, args.client_id);
      if (!listed.ok) return refused(actor, listed.error, "clients");
      const current = listed.value.find((s) => s.id === args.site_id);
      if (!current) return refused(actor, "notFound", "clients");
      const result = await updateSite(
        actor,
        args.client_id,
        current.id,
        mergeSite(current, { name: args.name, url: args.url, notes: args.notes, includedInSupport: args.in_support_plan }),
      );
      if (!result.ok) return refused(actor, result.error, "clients");
      recordWrite(scope, actor, "update_site");
      const after = await listSites(actor, args.client_id);
      const site = after.ok ? after.value.find((s) => s.id === current.id) : undefined;
      return written({ client_id: args.client_id, site: site ? presentSite(site) : { id: current.id } });
    }),
  );

  server.registerTool(
    "delete_site",
    {
      description:
        "Owners and managers: deletes a client's site. Its tickets stay with the client, as general tickets. Confirm with the person first.",
      inputSchema: z.object({ client_id: CLIENT_ID, site_id: SITE_ID }),
      annotations: writeAnnotations({ destructive: true, idempotent: true }),
    },
    teamTool(scope, "delete_site", "staff", async (actor, args) => {
      const result = await deleteSite(actor, args.client_id, args.site_id);
      if (!result.ok) return refused(actor, result.error, "clients");
      recordWrite(scope, actor, "delete_site");
      return written({ client_id: args.client_id, site_id: args.site_id });
    }),
  );

  // ---------- hours ----------

  server.registerTool(
    "add_hour_package",
    {
      description:
        "Owners and managers: records extra support hours bought by the client for a monthly cycle; they count in that cycle's balance at once. minutes: whole minutes (e.g. 600 for 10 hours). price is optional, as typed in the panel; charging it is a separate step (create_charge).",
      inputSchema: z.object({
        client_id: CLIENT_ID,
        minutes: z.number().describe("Whole minutes bought, from 1 to 100000 (e.g. 90 for 1h30)."),
        cycle: CYCLE,
        price: z
          .string()
          .max(50)
          .optional()
          .describe('The price, in the agency\'s currency as typed in the panel (e.g. "150" or "1.200,50"; not cents).'),
        note: z.string().max(5000).optional(),
      }),
      annotations: writeAnnotations({ destructive: false }),
    },
    teamTool(scope, "add_hour_package", "staff", async (actor, args) => {
      const result = await addHourPurchase(actor, args.client_id, {
        duration: minutesToDuration(args.minutes),
        cycle: args.cycle,
        price: args.price,
        note: args.note,
      });
      if (!result.ok) return refused(actor, result.error, "hours");
      recordWrite(scope, actor, "add_hour_package");
      return written({ client_id: args.client_id, hour_package: { id: result.value.id, minutes: args.minutes, cycle: args.cycle } });
    }),
  );

  server.registerTool(
    "delete_hour_package",
    {
      description:
        "Owners and managers: deletes an hour package of the client (id from get_hours). Refused for one bought in the portal and not paid yet, and for one with an open or paid charge (cancel the charge first).",
      inputSchema: z.object({ client_id: CLIENT_ID, hour_package_id: z.string() }),
      annotations: writeAnnotations({ destructive: true, idempotent: true }),
    },
    teamTool(scope, "delete_hour_package", "staff", async (actor, args) => {
      const result = await deleteHourPurchase(actor, args.client_id, args.hour_package_id);
      if (!result.ok) return refused(actor, result.error, "hours");
      recordWrite(scope, actor, "delete_hour_package");
      return written({ client_id: args.client_id, hour_package_id: args.hour_package_id });
    }),
  );

  // ---------- portal access ----------

  server.registerTool(
    "invite_to_portal",
    {
      description:
        "Owners and managers: gives a person access to the client's area. A new e-mail gets a login and an invite by e-mail (the link itself never comes back here). An e-mail that already has a login through other companies is never linked silently: the answer is a question (outcome confirm, ok false, nothing written) to put to the person; only if they say yes, call again with the same arguments and confirm copied from that answer's existing_login (portal_user_id, status, will_be_admin). If the login changed since (it became active, or the company's first admin changed), the answer is the question again, nothing linked: ask again. The company's first login is always an admin. Only when the connected person asks.",
      inputSchema: z.object({
        client_id: CLIENT_ID,
        name: z.string().min(1).max(200),
        email: z.string().min(3).max(254),
        role: z.enum(["admin", "collaborator"]).describe("admin also manages the company's logins and sees its payments."),
        confirm: z
          .object({
            portal_user_id: z.string(),
            status: z.enum(["active", "invited"]),
            will_be_admin: z.boolean(),
          })
          .optional()
          .describe(
            "Only after the person said yes to linking the existing login: portal_user_id, status and will_be_admin exactly as the previous answer's existing_login showed them.",
          ),
      }),
      annotations: writeAnnotations({ destructive: false, openWorld: true }),
    },
    teamTool(scope, "invite_to_portal", "staff", async (actor, args) => {
      // A confirm carries the login as the person was shown it; the core links only while it is still
      // that way (same login, same active flag, same admin outcome), and asks again otherwise.
      const result = await invitePortalUser(actor, args.client_id, {
        name: args.name,
        email: args.email,
        role: args.role,
        ...(args.confirm
          ? {
              confirm: {
                clientUserId: args.confirm.portal_user_id,
                active: args.confirm.status === "active",
                willBeAdmin: args.confirm.will_be_admin,
              },
            }
          : {}),
      });
      if (!result.ok) return refused(actor, result.error, "portalUsers");
      const value = result.value;
      const t = dictFor(actor);

      if (value.outcome === "confirm" && value.existing) {
        const { existing } = value;
        return toolData({
          ok: false,
          client_id: args.client_id,
          outcome: "confirm",
          question: t.mcp.portalLinkQuestion,
          existing_login: {
            portal_user_id: value.clientUserId,
            name: existing.name,
            status: existing.active ? "active" : "invited",
            companies: existing.companies,
            will_be_admin: existing.willBeAdmin,
          },
          warnings: [
            existing.active ? t.mcp.portalLinkActive : t.portalUsers.confirmPending,
            ...(existing.willBeAdmin ? [t.portalUsers.confirmAdmin] : []),
          ],
        });
      }

      recordWrite(scope, actor, "invite_to_portal");
      if (value.outcome === "linked") {
        return written({
          client_id: args.client_id,
          portal_user_id: value.clientUserId,
          outcome: "linked",
          was_pending: Boolean(value.wasPending),
          ...(value.wasPending ? { notice: t.portalUsers.linkedPendingDone } : {}),
        });
      }
      return written({
        client_id: args.client_id,
        portal_user_id: value.clientUserId,
        outcome: "invited",
        ...mailOutcome(actor, value.emailed, clientAccessUrl(await getAppUrl(), args.client_id)),
      });
    }),
  );

  server.registerTool(
    "resend_portal_invite",
    {
      description:
        "Owners and managers: e-mails a new invite link (the old one stops working) to a login of the client that hasn't set a password yet (status invited in get_portal_access). The link itself never comes back here.",
      inputSchema: z.object({ client_id: CLIENT_ID, portal_user_id: PORTAL_USER_ID }),
      annotations: writeAnnotations({ destructive: false, openWorld: true }),
    },
    teamTool(scope, "resend_portal_invite", "staff", async (actor, args) => {
      const result = await resendPortalInvite(actor, args.client_id, args.portal_user_id);
      if (!result.ok) return refused(actor, result.error, "portalUsers");
      recordWrite(scope, actor, "resend_portal_invite");
      return written({
        client_id: args.client_id,
        portal_user_id: args.portal_user_id,
        ...mailOutcome(actor, result.value.emailed, clientAccessUrl(await getAppUrl(), args.client_id)),
      });
    }),
  );

  server.registerTool(
    "cancel_portal_invite",
    {
      description:
        "Owners and managers: cancels an invite nobody accepted yet (status invited); the login goes too when it had no other company. For someone already active, use remove_from_portal.",
      inputSchema: z.object({ client_id: CLIENT_ID, portal_user_id: PORTAL_USER_ID }),
      annotations: writeAnnotations({ destructive: true, idempotent: true }),
    },
    teamTool(scope, "cancel_portal_invite", "staff", async (actor, args) => {
      const logins = await listCompanyUsers(actor, args.client_id);
      if (!logins.ok) return refused(actor, logins.error, "portalUsers");
      const login = logins.value.find((l) => l.id === args.portal_user_id);
      if (!login) return refused(actor, "notFound", "portalUsers");
      if (!login.pending) return refused(actor, "alreadyActive", "portalUsers");
      const result = await removePortalUser(actor, args.client_id, login.id);
      if (!result.ok) return refused(actor, result.error, "portalUsers");
      recordWrite(scope, actor, "cancel_portal_invite");
      return written({ client_id: args.client_id, portal_user_id: login.id, login_deleted: result.value.loginDeleted });
    }),
  );

  server.registerTool(
    "set_portal_role",
    {
      description:
        "Owners and managers: a login's role in the client's area — admin (manages the company's logins, sees payments) or collaborator. The company always keeps one admin who can sign in. Only when the connected person asks.",
      inputSchema: z.object({
        client_id: CLIENT_ID,
        portal_user_id: PORTAL_USER_ID,
        role: z.enum(["admin", "collaborator"]),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "set_portal_role", "staff", async (actor, args) => {
      const result = await setPortalRole(actor, args.client_id, args.portal_user_id, args.role);
      if (!result.ok) return refused(actor, result.error, "portalUsers");
      recordWrite(scope, actor, "set_portal_role");
      return written({ client_id: args.client_id, portal_user_id: args.portal_user_id, role: args.role });
    }),
  );

  server.registerTool(
    "remove_from_portal",
    {
      description:
        "Owners and managers: takes a person out of the client's area (their login is deleted when they had no other company; a pending invite stops working). The company always keeps one admin who can sign in. Only when the connected person asks.",
      inputSchema: z.object({ client_id: CLIENT_ID, portal_user_id: PORTAL_USER_ID }),
      annotations: writeAnnotations({ destructive: true, idempotent: true }),
    },
    teamTool(scope, "remove_from_portal", "staff", async (actor, args) => {
      const result = await removePortalUser(actor, args.client_id, args.portal_user_id);
      if (!result.ok) return refused(actor, result.error, "portalUsers");
      recordWrite(scope, actor, "remove_from_portal");
      return written({ client_id: args.client_id, portal_user_id: args.portal_user_id, login_deleted: result.value.loginDeleted });
    }),
  );
};
