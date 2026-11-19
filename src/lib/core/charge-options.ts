import "server-only";
import { eq } from "drizzle-orm";
import { isStaff } from "@/lib/access";
import type { TeamSession } from "@/lib/auth/session";
import { agency, clients, db as appDb, type ChargeKind } from "@/lib/db";
import { availableProviders, type ChargeDeps } from "./charges";

export type ProviderChoice = "stripe" | "mercadopago" | "manual";

/**
 * What the create-charge forms offer: the providers that can take a charge of this kind and
 * currency (then "manual", always), and the one preselected: the agency's default when it is in
 * the list, else the first online provider, else the manual record. `currency` is the agency's
 * unless the source has its own (a quote's).
 */
export async function chargeOptions(
  actor: TeamSession,
  input: { kind: ChargeKind; clientId: string | null; currency?: string },
  deps: ChargeDeps = {},
): Promise<{ providers: ProviderChoice[]; defaultProvider: ProviderChoice; currency: string }> {
  const db = deps.db ?? appDb;
  const [row] = await db
    .select({ currency: agency.currency, defaultProvider: agency.defaultPaymentProvider })
    .from(agency)
    .where(eq(agency.id, 1));
  const currency = input.currency ?? row?.currency ?? "BRL";
  if (!isStaff(actor.user)) return { providers: ["manual"], defaultProvider: "manual", currency };
  let email: string | null = null;
  if (input.clientId) {
    const [client] = await db.select({ email: clients.email }).from(clients).where(eq(clients.id, input.clientId));
    email = client?.email?.trim() || null;
  }
  const providers = availableProviders({ currency, kind: input.kind, clientEmail: email }, deps).map((p): ProviderChoice => p ?? "manual");
  const wanted = row?.defaultProvider ?? null;
  const defaultProvider = wanted && providers.includes(wanted) ? wanted : providers[0];
  return { providers, defaultProvider, currency };
}

/**
 * For the free charge form, which picks its client in the browser: the providers each kind of
 * charge can use for a client with and without an e-mail (a monthly Mercado Pago charge needs one),
 * plus the agency's currency and default provider.
 */
export async function chargeProviderMatrix(
  actor: TeamSession,
  deps: ChargeDeps = {},
): Promise<{
  currency: string;
  defaultProvider: ProviderChoice | null;
  matrix: Record<ChargeKind, { withEmail: ProviderChoice[]; withoutEmail: ProviderChoice[] }>;
}> {
  const db = deps.db ?? appDb;
  const [row] = await db
    .select({ currency: agency.currency, defaultProvider: agency.defaultPaymentProvider })
    .from(agency)
    .where(eq(agency.id, 1));
  const currency = row?.currency ?? "BRL";
  const list = (kind: ChargeKind, clientEmail: string | null): ProviderChoice[] =>
    isStaff(actor.user) ? availableProviders({ currency, kind, clientEmail }, deps).map((p): ProviderChoice => p ?? "manual") : ["manual"];
  return {
    currency,
    defaultProvider: row?.defaultProvider ?? null,
    matrix: {
      one_time: { withEmail: list("one_time", "client@example.com"), withoutEmail: list("one_time", null) },
      subscription: { withEmail: list("subscription", "client@example.com"), withoutEmail: list("subscription", null) },
    },
  };
}
