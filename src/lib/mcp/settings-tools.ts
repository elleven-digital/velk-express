import "server-only";
import * as z from "zod";
import { getVisibility, isStaff } from "@/lib/access";
import { getAgency } from "@/lib/agency";
import { getAppUrl } from "@/lib/app-url";
import { getConfig } from "@/lib/config";
import { getAgencyRotation, updateAutoAssign, updateCollabVisibility } from "@/lib/core/assignments";
import { CURRENCIES, updateAgency, type Currency } from "@/lib/core/settings";
import { LOCALES, type Locale } from "@/lib/i18n";
import {
  READ_ONLY,
  recordWrite,
  refused,
  teamTool,
  toolData,
  writeAnnotations,
  written,
  type ToolRegistrar,
} from "@/lib/mcp/tools";
import { canonicalTimeZone } from "@/lib/time-zone";

/**
 * The agency and its settings, with the panel's roles. `get_agency` is where
 * an app starts: who is connected, with which role, and the agency's language,
 * currency and time zone. The agency's data and what collaborators see are the
 * owner's; the agency's rotation is owners' and managers'. The cores replace
 * every field, so the tools read the current values and change only what is
 * given. Left out: the logo (a file), the public address (changing it from
 * here would cut this very connection) and the payment providers.
 */

export const SETTINGS_TOOLS = ["get_agency", "update_agency", "set_collaborator_visibility", "set_auto_assign"] as const;

const SCOPE = z.enum(["all", "assigned"]);

export const registerSettingsTools: ToolRegistrar = (server, scope) => {
  server.registerTool(
    "get_agency",
    {
      description:
        "Who the connected person is (id, name, email, role: owner, manager or collaborator, and their own language if they picked one), the agency (name, language, currency, time zone, panel URL), what collaborators may see and, for owners and managers, which payment providers are turned on. Call it first.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    teamTool(scope, "get_agency", "member", async (actor) => {
      const { user } = actor;
      const [brand, visibility, appUrl] = await Promise.all([getAgency(), getVisibility(), getAppUrl()]);
      const config = getConfig();
      return toolData({
        you: { id: user.id, name: user.name, email: user.email, role: user.role, locale: user.locale },
        agency: {
          name: brand?.name ?? null,
          locale: brand?.locale ?? null,
          currency: brand?.currency ?? null,
          time_zone: brand?.timeZone ?? null,
          panel_url: `${appUrl.replace(/\/+$/, "")}/admin`,
        },
        collaborator_visibility: {
          client_scope: visibility.clientScope,
          ticket_scope: visibility.ticketScope,
          sees_unassigned: visibility.seesUnassigned,
        },
        ...(isStaff(user)
          ? { payment_providers: { stripe: config.stripe !== null, mercadopago: config.mercadoPago !== null } }
          : {}),
      });
    }),
  );

  server.registerTool(
    "update_agency",
    {
      description:
        "Owners: changes the agency's name, the currency it charges its clients in (new quotes, tickets and charges; existing quotes keep theirs), its language (for people who didn't pick their own, and e-mails) and its time zone (an IANA name such as America/Sao_Paulo; monthly cycles and \"today\" follow it from now on). Fields left out keep their value.",
      inputSchema: z.object({
        name: z.string().min(1).max(120).optional(),
        currency: z.enum(CURRENCIES).optional(),
        locale: z.enum(LOCALES).optional(),
        time_zone: z.string().max(100).optional().describe("IANA time zone, e.g. America/Sao_Paulo or Europe/Lisbon."),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "update_agency", "owner", async (actor, args) => {
      const brand = await getAgency();
      if (!brand) return refused(actor, "generic", "settings");
      const next = {
        name: args.name ?? brand.name,
        currency: args.currency ?? (brand.currency as Currency),
        locale: args.locale ?? (brand.locale as Locale),
        timeZone: args.time_zone ?? brand.timeZone,
      };
      const result = await updateAgency(actor, next);
      if (!result.ok) return refused(actor, result.error, "settings");
      recordWrite(scope, actor, "update_agency");
      return written({
        agency: {
          name: next.name.trim(),
          currency: next.currency,
          locale: next.locale,
          // As stored: the runtime's spelling of the zone.
          time_zone: canonicalTimeZone(next.timeZone) ?? next.timeZone,
        },
      });
    }),
  );

  server.registerTool(
    "set_collaborator_visibility",
    {
      description:
        "Owners: what collaborators see. client_scope: all clients, or only the clients they take part in (assigned). ticket_scope: all tickets of those clients, or only tickets they are responsible for (assigned). sees_unassigned: with ticket_scope assigned, whether they also see tickets nobody took. Fields left out keep their value. Owners and managers always see everything.",
      inputSchema: z.object({
        client_scope: SCOPE.optional(),
        ticket_scope: SCOPE.optional(),
        sees_unassigned: z.boolean().optional(),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "set_collaborator_visibility", "owner", async (actor, args) => {
      const current = await getVisibility();
      const next = {
        clientScope: args.client_scope ?? current.clientScope,
        ticketScope: args.ticket_scope ?? current.ticketScope,
        seesUnassigned: args.sees_unassigned ?? current.seesUnassigned,
      };
      const result = await updateCollabVisibility(actor, next);
      if (!result.ok) return refused(actor, result.error, "settings");
      recordWrite(scope, actor, "set_collaborator_visibility");
      return written({ client_scope: next.clientScope, ticket_scope: next.ticketScope, sees_unassigned: next.seesUnassigned });
    }),
  );

  server.registerTool(
    "set_auto_assign",
    {
      description:
        "Owners and managers: the agency-wide rotation that assigns support tickets opened by clients, one person at a time (a client's own rotation, set_client_rotation, overrides it). enabled turns it on or off; user_ids replaces who takes part (left out: keeps the current people). It only stays on with at least one person.",
      inputSchema: z.object({
        enabled: z.boolean(),
        user_ids: z.array(z.string()).max(200).optional().describe("Team member ids (from list_team)."),
      }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "set_auto_assign", "staff", async (actor, args) => {
      const userIds = args.user_ids ?? (await getAgencyRotation()).userIds;
      const result = await updateAutoAssign(actor, { enabled: args.enabled, userIds });
      if (!result.ok) return refused(actor, result.error, "settings");
      recordWrite(scope, actor, "set_auto_assign");
      const after = await getAgencyRotation();
      return written({ enabled: result.value.enabled, user_ids: after.userIds });
    }),
  );
};
