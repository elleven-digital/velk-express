import "server-only";
import type Stripe from "stripe";
import { getConfig, type AppConfig } from "@/lib/config";
import { createMercadoPagoProvider } from "./mercadopago";
import { createStripeProvider } from "./stripe";
import type { PaymentProvider, ProviderName } from "./types";

export type { CheckoutInput, PaymentProvider, ProviderName, WebhookEffect, WebhookEvent, WebhookRequest } from "./types";

/** Test seams: an injected Stripe client and fetch, so no real provider is ever called. */
export type ProviderDeps = { stripe?: Stripe; fetch?: typeof fetch };

/** The providers whose keys are set, Stripe first; none without keys. */
export function getProviders(config: AppConfig = getConfig(), deps: ProviderDeps = {}): PaymentProvider[] {
  const providers: PaymentProvider[] = [];
  if (config.stripe) providers.push(createStripeProvider(config.stripe, deps.stripe));
  if (config.mercadoPago) providers.push(createMercadoPagoProvider(config.mercadoPago, { fetch: deps.fetch }));
  return providers;
}

/** The named provider, or null when its keys are not set. */
export function providerFor(name: ProviderName, config: AppConfig = getConfig(), deps: ProviderDeps = {}): PaymentProvider | null {
  return getProviders(config, deps).find((p) => p.name === name) ?? null;
}
