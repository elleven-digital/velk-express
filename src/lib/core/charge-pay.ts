import "server-only";
import { eq } from "drizzle-orm";
import { getAppUrl } from "@/lib/app-url";
import { charges, clients, db as appDb, quotes, type Charge } from "@/lib/db";
import type { CheckoutCurrency } from "@/lib/payments/types";
import { errorTag, providersOf, type ChargeDeps } from "./charges";
import { fail, ok, type Result } from "./result";
import { Abort, transact } from "./tx";

/**
 * The public payment link `/pay/[token]`. Each visit checks the charge and opens a fresh checkout
 * at its provider (a Checkout Session, a preference or a preapproval), so the link never expires
 * and a recurring charge is never subscribed twice. Errors: `notFound`, `alreadyPaid`, `canceled`,
 * `alreadyActive` (a recurring charge that is active or past due: the agency sorts it out, a new
 * checkout would start a second subscription), `manual` (settled outside the app) and
 * `providerUnavailable` (not configured any more, cannot take the charge, or it failed).
 *
 * The provider call runs outside any transaction: no lock is held across the network. The charge is
 * locked again afterwards to store the checkout, and if it was settled or canceled in between, the
 * new checkout is closed and the new state is reported.
 */

const MAX_TOKEN = 200;
const CURRENCIES: readonly string[] = ["BRL", "USD", "EUR"];

/** The refusal for a charge that cannot open a checkout, or null when it can. */
function refusal(charge: Pick<Charge, "status" | "kind" | "provider">): string | null {
  if (charge.status === "paid") return "alreadyPaid";
  if (charge.status === "canceled") return "canceled";
  // A subscription that is active or past due already exists at the provider.
  if (charge.status !== "pending") return "alreadyActive";
  if (!charge.provider) return "manual";
  return null;
}

/**
 * Where the payer lands after the provider's page. A quote's charge goes back to the public quote;
 * any other goes to `/pay/[token]/done`, which only reports (the confirmation comes by webhook).
 * The outcome travels in `r`: providers append their own parameters (Mercado Pago adds `status`).
 */
export function returnUrls(appUrl: string, token: string, quoteToken: string | null): { successUrl: string; cancelUrl: string } {
  if (quoteToken) return { successUrl: `${appUrl}/q/${quoteToken}`, cancelUrl: `${appUrl}/q/${quoteToken}` };
  const done = `${appUrl}/pay/${token}/done`;
  return { successUrl: `${done}?r=ok`, cancelUrl: `${done}?r=cancel` };
}

/**
 * What the page after the provider says. The charge's own state wins; otherwise only `r` counts
 * (its first value when repeated): `ok` means the payer finished at the provider, anything else
 * (`cancel`, an unknown value or none) is "not completed", with a way to try again.
 */
export function payDoneState(
  status: Charge["status"],
  searchParams: Record<string, string | string[] | undefined>,
): "confirmed" | "canceled" | "received" | "notCompleted" {
  if (status === "paid" || status === "active") return "confirmed";
  if (status === "canceled") return "canceled";
  const r = searchParams.r;
  return (Array.isArray(r) ? r[0] : r) === "ok" ? "received" : "notCompleted";
}

/** What the page after the provider shows. Read-only: it never opens a checkout. */
export type PayDone = { label: string; amountCents: number; currency: string; status: Charge["status"]; kind: Charge["kind"] };

export async function getPayDone(token: string, deps: Pick<ChargeDeps, "db"> = {}): Promise<PayDone | null> {
  if (!token || token.length > MAX_TOKEN) return null;
  const db = deps.db ?? appDb;
  const [row] = await db
    .select({ label: charges.label, amountCents: charges.amountCents, currency: charges.currency, status: charges.status, kind: charges.kind })
    .from(charges)
    .where(eq(charges.payToken, token));
  return row ?? null;
}

export async function startPayment(token: string, deps: ChargeDeps = {}): Promise<Result<{ url: string }>> {
  if (!token || token.length > MAX_TOKEN) return fail("notFound");
  const db = deps.db ?? appDb;
  const [row] = await db
    .select({
      charge: charges,
      clientEmail: clients.email,
      quoteToken: quotes.token,
      prospectEmail: quotes.prospectEmail,
    })
    .from(charges)
    .leftJoin(clients, eq(clients.id, charges.clientId))
    .leftJoin(quotes, eq(quotes.id, charges.quoteId))
    .where(eq(charges.payToken, token));
  if (!row) return fail("notFound");
  const { charge } = row;
  const refused = refusal(charge);
  if (refused) return fail(refused);

  if (!CURRENCIES.includes(charge.currency)) return fail("providerUnavailable");
  const provider = providersOf(deps).find((p) => p.name === charge.provider) ?? null;
  const payerEmail = row.clientEmail ?? row.prospectEmail ?? null;
  const currency = charge.currency as CheckoutCurrency;
  if (!provider || !provider.supports({ currency, kind: charge.kind, payerEmail })) return fail("providerUnavailable");

  const appUrl = await getAppUrl();
  const { successUrl, cancelUrl } = returnUrls(appUrl, token, row.quoteToken);
  let checkout: { url: string; checkoutId: string };
  try {
    checkout = await provider.createCheckout({
      chargeId: charge.id,
      label: charge.label,
      amountCents: charge.amountCents,
      currency,
      kind: charge.kind,
      payerEmail,
      successUrl,
      cancelUrl,
      notificationUrl: `${appUrl}/api/webhooks/mercadopago`,
    });
  } catch (err) {
    console.error(`[pay] creating a checkout failed at ${provider.name}:`, errorTag(err));
    return fail("providerUnavailable");
  }

  const close = async (checkoutId: string) => {
    try {
      await provider.expireCheckout(checkoutId);
    } catch (err) {
      console.error(`[pay] expiring a checkout failed at ${provider.name}:`, errorTag(err));
    }
  };
  let stored: Result<string | null>;
  try {
    stored = await transact(db, async (tx) => {
      const [current] = await tx.select().from(charges).where(eq(charges.id, charge.id)).for("update");
      const why = current ? refusal(current) : "notFound";
      if (why) throw new Abort(why);
      await tx
        .update(charges)
        .set({ externalCheckoutId: checkout.checkoutId, updatedAt: new Date() })
        .where(eq(charges.id, charge.id));
      return current.externalCheckoutId;
    });
  } catch (err) {
    await close(checkout.checkoutId);
    throw err;
  }
  if (!stored.ok) {
    // Settled or canceled meanwhile: the checkout just opened must not stay payable.
    await close(checkout.checkoutId);
    return stored;
  }
  // The row lock serialises clicks: the checkout this one replaces is closed, so there is only one open.
  const previous = stored.value;
  if (previous && previous !== checkout.checkoutId) await close(previous);
  return ok({ url: checkout.url });
}
