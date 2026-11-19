import Stripe from "stripe";
import type { CheckoutInput, PaymentProvider, WebhookEffect, WebhookEvent, WebhookRequest } from "./types";

// Pinned so an SDK upgrade never silently changes the API shape; bump together with the package.
const API_VERSION = "2026-10-28.endive" satisfies Stripe.LatestApiVersion;

export type StripeKeys = { secretKey: string; webhookSecret: string };

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: API_VERSION, maxNetworkRetries: 2, timeout: 10_000 });
}

function idOf(value: string | { id: string } | null | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.id;
}

function chargeIdOf(metadata: Stripe.Metadata | null | undefined): string | null {
  return metadata?.chargeId || null;
}

/** The object is gone or belongs to another account (a simulated or foreign event). */
function isMissing(e: unknown): boolean {
  return e instanceof Stripe.errors.StripeError && (e.statusCode === 404 || e.code === "resource_missing");
}

function subscriptionEffect(status: Stripe.Subscription.Status): WebhookEffect {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      // incomplete_expired too: the first payment never went through, so the charge stays
      // pending and the payer can try again through the payment link.
      return "ignore";
  }
}

/**
 * Stripe without Connect: the agency's own keys, Checkout Sessions with inline prices and
 * dynamic payment methods (the agency's Dashboard decides card, Pix, boleto).
 */
export function createStripeProvider(keys: StripeKeys, client: Stripe = createStripeClient(keys.secretKey)): PaymentProvider {
  async function sessionEvent(eventId: string, sessionId: string): Promise<WebhookEvent> {
    const session = await client.checkout.sessions.retrieve(sessionId);
    const chargeId = session.client_reference_id || chargeIdOf(session.metadata);
    // A boleto completes the session unpaid; only a paid session counts.
    if (session.payment_status !== "paid") return { eventId, chargeId, effect: "ignore" };
    if (session.mode === "subscription") {
      const externalSubscriptionId = idOf(session.subscription);
      if (!externalSubscriptionId) return { eventId, chargeId, effect: "ignore" };
      // The subscription's current state, not "active": if it was canceled before this activation
      // is processed, the charge must not become active for a subscription that no longer bills.
      const subscription = await client.subscriptions.retrieve(externalSubscriptionId);
      return { eventId, chargeId, externalSubscriptionId, effect: subscriptionEffect(subscription.status) };
    }
    const externalPaymentId = idOf(session.payment_intent);
    return { eventId, chargeId, ...(externalPaymentId ? { externalPaymentId } : {}), effect: "paid" };
  }

  async function subscriptionEvent(eventId: string, subscriptionId: string, deleted: boolean): Promise<WebhookEvent> {
    // The current state, not the event's snapshot: events arrive out of order.
    const subscription = await client.subscriptions.retrieve(subscriptionId);
    return {
      eventId,
      chargeId: chargeIdOf(subscription.metadata),
      externalSubscriptionId: subscription.id,
      effect: deleted ? "canceled" : subscriptionEffect(subscription.status),
    };
  }

  async function invoiceEvent(eventId: string, invoiceId: string): Promise<WebhookEvent> {
    const invoice = await client.invoices.retrieve(invoiceId);
    const details = invoice.parent?.subscription_details;
    const subscriptionId = idOf(details?.subscription);
    if (!subscriptionId) return { eventId, chargeId: null, effect: "ignore" };
    // invoice.paid means active and invoice.payment_failed past due, but only as long as the
    // subscription still says so; its own status settles a late or replayed invoice event.
    const event = await subscriptionEvent(eventId, subscriptionId, false);
    return { ...event, chargeId: event.chargeId ?? chargeIdOf(details?.metadata) };
  }

  async function eventsFor(event: Stripe.Event): Promise<WebhookEvent[]> {
    const eventId = event.id;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return [await sessionEvent(eventId, event.data.object.id)];
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return [await subscriptionEvent(eventId, event.data.object.id, event.type === "customer.subscription.deleted")];
      case "invoice.paid":
      case "invoice.payment_failed":
        return [await invoiceEvent(eventId, event.data.object.id)];
      default:
        // async_payment_failed (boleto not paid) and everything else: no change.
        return [{ eventId, chargeId: null, effect: "ignore" }];
    }
  }

  return {
    name: "stripe",

    supports() {
      return true;
    },

    async createCheckout(i: CheckoutInput) {
      const metadata = { chargeId: i.chargeId };
      const priceData: Stripe.Checkout.SessionCreateParams.LineItem.PriceData = {
        currency: i.currency.toLowerCase(),
        unit_amount: i.amountCents,
        product_data: { name: i.label },
      };
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: i.kind === "subscription" ? "subscription" : "payment",
        line_items: [
          { quantity: 1, price_data: i.kind === "subscription" ? { ...priceData, recurring: { interval: "month" } } : priceData },
        ],
        client_reference_id: i.chargeId,
        metadata,
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      };
      if (i.kind === "subscription") params.subscription_data = { metadata };
      else params.payment_intent_data = { metadata };
      if (i.payerEmail) params.customer_email = i.payerEmail;

      const session = await client.checkout.sessions.create(params);
      if (!session.url) throw new Error("Stripe returned a checkout session without a URL.");
      return { url: session.url, checkoutId: session.id };
    },

    async cancelSubscription(externalId: string) {
      await client.subscriptions.cancel(externalId);
    },

    async expireCheckout(checkoutId: string) {
      // Only an open session can be expired; a completed or expired one is left alone.
      const session = await client.checkout.sessions.retrieve(checkoutId);
      if (session.status === "open") await client.checkout.sessions.expire(checkoutId);
    },

    async parseWebhook(req: WebhookRequest) {
      const signature = req.headers.get("stripe-signature");
      if (!signature) return "invalid";
      let event: Stripe.Event;
      try {
        event = client.webhooks.constructEvent(req.rawBody, signature, keys.webhookSecret);
      } catch {
        return "invalid";
      }
      const eventId = event.id;
      try {
        return await eventsFor(event);
      } catch (e) {
        // A missing object will never appear; ignoring it stops endless retries. Other errors
        // propagate so the route answers 5xx and Stripe retries.
        if (isMissing(e)) return [{ eventId, chargeId: null, effect: "ignore" }];
        throw e;
      }
    },
  };
}
