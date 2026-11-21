import "server-only";
import * as z from "zod";
import { getVisibility, isStaff } from "@/lib/access";
import { getAgency } from "@/lib/agency";
import { getAppUrl } from "@/lib/app-url";
import { getConfig } from "@/lib/config";
import { READ_ONLY, teamTool, toolData, type ToolRegistrar } from "@/lib/mcp/tools";

/**
 * The agency and its settings. `get_agency` is where an app starts: who is
 * connected, with which role, and the agency's language, currency and time
 * zone.
 */

export const SETTINGS_TOOLS = ["get_agency"] as const;

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
};
