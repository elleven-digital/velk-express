export type ProviderName = "stripe" | "mercadopago";
export type CheckoutCurrency = "BRL" | "USD" | "EUR";
export type CheckoutKind = "one_time" | "subscription";

export type CheckoutInput = {
  chargeId: string;
  label: string;
  amountCents: number;
  currency: CheckoutCurrency;
  kind: CheckoutKind;
  payerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  notificationUrl: string;
};

export type WebhookEffect = "paid" | "active" | "past_due" | "canceled" | "ignore";

/**
 * What a verified webhook means for one charge. The provider fetches the object (session,
 * payment, subscription) from its own API and decides the effect; the body is never trusted.
 * When the charge id is unknown (some subscription events), the core looks the charge up by
 * `externalSubscriptionId`.
 */
export type WebhookEvent = {
  eventId: string;
  chargeId: string | null;
  externalSubscriptionId?: string;
  externalPaymentId?: string;
  effect: WebhookEffect;
};

export type WebhookRequest = { rawBody: string; headers: Headers; url: URL };

export interface PaymentProvider {
  name: ProviderName;
  supports(c: { currency: CheckoutCurrency; kind: CheckoutKind; payerEmail: string | null }): boolean;
  createCheckout(i: CheckoutInput): Promise<{ url: string; checkoutId: string }>;
  cancelSubscription(externalId: string): Promise<void>;
  /** Closes an open checkout so it can no longer be paid; a no-op where the provider has none. */
  expireCheckout(checkoutId: string): Promise<void>;
  /** "invalid" when the signature does not match; the route answers 400. */
  parseWebhook(req: WebhookRequest): Promise<WebhookEvent[] | "invalid">;
}
