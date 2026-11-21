import "server-only";
import * as z from "zod";
import type { TeamSession } from "@/lib/auth/session";
import { chargeOptions, chargeProviderMatrix } from "@/lib/core/charge-options";
import { cancelCharge, createCharge, getCharge, listCharges, markChargePaid, type ChargeInput } from "@/lib/core/charges";
import { getQuote } from "@/lib/core/quotes";
import { getConfig } from "@/lib/config";
import type { ChargeKind } from "@/lib/db";
import type { ProviderName } from "@/lib/payments";
import { presentChargeDetail } from "@/lib/mcp/present-money";
import {
  dictFor,
  PEOPLE_TEXT,
  READ_ONLY,
  recordWrite,
  refused,
  teamTool,
  toolData,
  toolError,
  writeAnnotations,
  written,
  type ToolRegistrar,
} from "@/lib/mcp/tools";

/**
 * Charges to the agency's clients, as the panel's Charges page and the charge
 * blocks of tickets, clients, hours and quotes: list, read, create, cancel and
 * mark as paid. Owners and managers; a quote's charge is the owner's. A
 * charge is a record with its own payment page (`/pay/...`): with a provider
 * the client pays there, without one (manual) it is settled by
 * mark_charge_paid. Attaching the fiscal document (a file) stays in the panel.
 */

export const CHARGE_TOOLS = ["list_charges", "get_charge", "create_charge", "cancel_charge", "mark_charge_paid"] as const;

const CHARGE_ID = z.string().describe("The charge id (from list_charges).");
const SOURCES = ["ticket", "support", "hours", "quote", "none"] as const;
const PROVIDERS = ["stripe", "mercadopago", "manual"] as const;

type Provider = (typeof PROVIDERS)[number];

/** "manual" is the record without a provider, as the panel's form says it. */
const providerName = (p: Provider): ProviderName | null => (p === "manual" ? null : p);

type CreateArgs = {
  source: (typeof SOURCES)[number];
  id?: string;
  client_id?: string;
  label?: string;
  amount_cents?: number;
  kind?: ChargeKind;
  provider?: Provider;
};

/**
 * The provider the panel's form preselects for this charge (`chargeOptions`):
 * the agency's default when it can take the charge, else the first provider
 * that can, else the manual record. The kind, client and currency are the
 * source's as the core will see them (a monthly plan needs the client's
 * e-mail for Mercado Pago; a quote has its own currency).
 */
async function defaultProvider(actor: TeamSession, args: CreateArgs): Promise<ProviderName | null> {
  const kind: ChargeKind = args.source === "support" ? "subscription" : args.source === "none" ? (args.kind ?? "one_time") : "one_time";
  const clientId = args.source === "support" ? (args.id ?? args.client_id ?? null) : args.source === "none" ? (args.client_id ?? null) : null;
  let currency: string | undefined;
  if (args.source === "quote" && args.id) {
    const quote = await getQuote(actor, args.id);
    if (quote.ok) currency = quote.value.quote.currency;
  }
  const options = await chargeOptions(actor, { kind, clientId, currency });
  return providerName(options.defaultProvider);
}

/** The core's input: the source's id, and for a free charge (none) its client, label, amount and kind. */
function chargeInput(args: CreateArgs, provider: ProviderName | null): ChargeInput {
  if (args.source === "none") {
    return { source: "none", clientId: args.client_id, label: args.label, amountCents: args.amount_cents, kind: args.kind, provider };
  }
  return { source: args.source, sourceId: args.source === "support" ? (args.id ?? args.client_id) : args.id, provider };
}

export const registerChargeTools: ToolRegistrar = (server, scope) => {
  server.registerTool(
    "list_charges",
    {
      description:
        "Owners and managers: the agency's charges to its clients, newest first — label, kind (one_time or subscription), status (pending, paid, active, past_due, canceled), provider (stripe, mercadopago, or null for a manual record), amount in cents, client, source and the payment page to send the client. Also says which payment providers are turned on and the agency's default provider. Filters: client_id, status. Managers don't see a quote's charges." +
        PEOPLE_TEXT,
      inputSchema: z.object({
        client_id: z.string().optional(),
        status: z.enum(["pending", "paid", "active", "past_due", "canceled"]).optional(),
      }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "list_charges", "staff", async (actor, args) => {
      const res = await listCharges(actor, { clientId: args.client_id, status: args.status });
      if (!res.ok) return refused(actor, res.error, "charges");
      const config = getConfig();
      const { defaultProvider: preferred } = await chargeProviderMatrix(actor);
      return toolData({
        payment_providers: { stripe: config.stripe !== null, mercadopago: config.mercadoPago !== null },
        // The agency's preferred provider for new charges (null: none picked, the first one that can take it).
        default_provider: preferred,
        charges: res.value.map(presentChargeDetail),
      });
    }),
  );

  server.registerTool(
    "get_charge",
    {
      description:
        "Owners and managers: one charge — status, kind, provider, amount, client, source, payment page and the paid or canceled date." + PEOPLE_TEXT,
      inputSchema: z.object({ charge_id: CHARGE_ID }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "get_charge", "staff", async (actor, args) => {
      const res = await getCharge(actor, args.charge_id);
      if (!res.ok) return refused(actor, res.error, "charges");
      return toolData({ charge: presentChargeDetail(res.value) });
    }),
  );

  server.registerTool(
    "create_charge",
    {
      description:
        "Owners and managers: creates a charge and returns its payment page (pay_url, on this panel's address) for the person to send to the client. source: ticket (a single ticket with a value, set_ticket_value; id = ticket id), support (the client's monthly plan, as a subscription; id = client id), hours (a priced hour package; id from get_hours), quote (owners only: the one-time items of a sent, accepted or executed quote; id = quote id) or none (a free charge: client_id, label, amount_cents and kind one_time, the default, or subscription). provider: stripe, mercadopago (BRL only; a subscription needs the client's e-mail) or manual (a record settled by mark_charge_paid); left out, the agency's default when it can take the charge, as the panel preselects. One open or paid charge per source. Only when the person asks.",
      inputSchema: z.object({
        source: z.enum(SOURCES),
        id: z.string().optional().describe("The source's id; not used for none."),
        client_id: z.string().optional().describe("none: the client charged."),
        label: z.string().max(200).optional().describe("none: what the charge is for."),
        amount_cents: z.number().int().optional().describe("none: the amount, in cents of the agency's currency."),
        kind: z.enum(["one_time", "subscription"]).optional().describe("none: one_time (default) or subscription (monthly)."),
        provider: z.enum(PROVIDERS).optional(),
      }),
      annotations: writeAnnotations({ destructive: false, openWorld: true }),
    },
    teamTool(scope, "create_charge", "staff", async (actor, args) => {
      // A quote's charge is the owner's, as the panel's quote page: the role refusal, not the core's generic one.
      if (args.source === "quote" && actor.user.role !== "owner") return toolError(dictFor(actor).mcp.ownerOnly);
      const provider = args.provider ? providerName(args.provider) : await defaultProvider(actor, args);
      const result = await createCharge(actor, chargeInput(args, provider));
      if (!result.ok) return refused(actor, result.error, "charges");
      recordWrite(scope, actor, "create_charge");
      const created = await getCharge(actor, result.value.id);
      return written({
        charge: created.ok ? presentChargeDetail(created.value) : { id: result.value.id, pay_url: result.value.payUrl },
      });
    }),
  );

  server.registerTool(
    "cancel_charge",
    {
      description:
        "Owners and managers: cancels a charge — its payment page stops working and a subscription is canceled at the provider; an hour package bought in the portal and not paid goes too. A paid charge can't be canceled; canceling a canceled one changes nothing (changed false). Only when the person asks.",
      inputSchema: z.object({ charge_id: CHARGE_ID }),
      annotations: writeAnnotations({ destructive: true, idempotent: true, openWorld: true }),
    },
    teamTool(scope, "cancel_charge", "staff", async (actor, args) => {
      const result = await cancelCharge(actor, args.charge_id);
      if (!result.ok) return refused(actor, result.error, "charges");
      if (result.value.changed) recordWrite(scope, actor, "cancel_charge");
      const after = await getCharge(actor, args.charge_id);
      return written({
        charge: after.ok ? presentChargeDetail(after.value) : { id: args.charge_id, status: "canceled" },
        changed: result.value.changed,
      });
    }),
  );

  server.registerTool(
    "mark_charge_paid",
    {
      description:
        "Owners and managers: records that the client paid a pending one-time charge outside the payment page (Pix, transfer, cash); the page stops working and an hour package waiting for it counts. Only when the person asks.",
      inputSchema: z.object({ charge_id: CHARGE_ID }),
      annotations: writeAnnotations({ destructive: false, openWorld: true }),
    },
    teamTool(scope, "mark_charge_paid", "staff", async (actor, args) => {
      const result = await markChargePaid(actor, args.charge_id);
      if (!result.ok) return refused(actor, result.error, "charges");
      recordWrite(scope, actor, "mark_charge_paid");
      const after = await getCharge(actor, args.charge_id);
      return written({ charge: after.ok ? presentChargeDetail(after.value) : { id: args.charge_id, status: "paid" } });
    }),
  );
};
