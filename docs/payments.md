# Payments

Velk Express can take payments for charges through **Stripe** and/or **Mercado Pago**, using your agency's own accounts. Money goes straight to your account; Velk Express takes no fee.

Without a provider, a charge is a record only: you mark it as paid yourself. You can attach the invoice or tax document to any charge, with or without a provider, and the client downloads it in the portal.

## How it works

- A charge is **one-time** or **monthly** (a subscription).
- For each charge you pick the provider. The list only shows providers that can take that charge's currency and type. Set a default provider in **Settings → Payments**.
- The client gets a payment link (`/pay/<token>`). Each visit opens a fresh checkout at the provider.
- A payment counts only when the provider's **webhook** confirms it, never because the client's browser came back to the site. Webhooks are verified with your signing secret, and a webhook that arrives twice is applied once.
- Monthly charges move between pending, active, past due and canceled as the provider reports. Only the agency cancels a monthly charge, in the panel; that also cancels it at the provider. To change the amount of an active monthly charge, cancel it and create a new one.

**Settings → Payments** shows, for each provider, the variables that turn it on, the webhook address to register and the events or topics to select. The webhook address is built from your public address (`APP_URL`), so set that first and use `https://`.

## Stripe

Stripe takes one-time charges (Checkout in payment mode) and monthly charges (Checkout in subscription mode), in any of the agency's currencies (BRL, USD, EUR).

1. In the Stripe Dashboard, under the developer settings, copy your **secret key** (`sk_live_...`, or `sk_test_...` in test mode).

2. Add a **webhook endpoint** with this address:

   ```
   https://panel.example.com/api/webhooks/stripe
   ```

3. Select exactly these events:

   ```
   checkout.session.completed
   checkout.session.async_payment_succeeded
   checkout.session.async_payment_failed
   customer.subscription.updated
   customer.subscription.deleted
   invoice.paid
   invoice.payment_failed
   ```

4. Copy the endpoint's **signing secret** (`whsec_...`).
5. Set the variables and restart the app:

   ```sh
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

6. In **Settings → Payments**, Stripe shows "Configured".

## Mercado Pago

Mercado Pago takes charges **in BRL only**:

- **one-time** charges through Checkout Pro, with Pix, boleto and card;
- **monthly** charges through a subscription. A monthly charge needs the client's e-mail: fill in the e-mail on the client (or on the quote's prospect). Without it, Mercado Pago is not offered for that charge.

If your agency's currency is USD or EUR, Mercado Pago is never offered.

1. In Mercado Pago's developer area ("Your integrations"), create or open an application and copy its **access token** (production credentials).
2. In the application's **webhooks** settings, set this address for production:

   ```
   https://panel.example.com/api/webhooks/mercadopago
   ```

3. Select these topics (events):

   ```
   payment
   subscription_preapproval
   subscription_authorized_payment
   ```

   In Mercado Pago's panel they appear as payments and as plans and subscriptions. Velk Express also sets the same address on each checkout it creates.

4. Copy the webhook's **secret signature**.
5. Set the variables and restart the app:

   ```sh
   MERCADOPAGO_ACCESS_TOKEN=APP_USR-...
   MERCADOPAGO_WEBHOOK_SECRET=...
   ```

6. In **Settings → Payments**, Mercado Pago shows "Configured".

Mercado Pago cannot close a checkout that was already opened. If a client somehow pays the same charge twice, the second payment is logged and you refund it from Mercado Pago.

## Testing before going live

Use the providers' test modes with a test install or a local copy (see [development](development.md)). Put the test keys in the variables, never in a ticket or chat.

### Stripe test mode

1. Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and log in with `stripe login`.
2. Use your test secret key (`sk_test_...`) in `STRIPE_SECRET_KEY`.
3. Forward webhooks to the app. For a local copy on port 3000:

   ```sh
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```

   It prints a signing secret (`whsec_...`). Put it in `STRIPE_WEBHOOK_SECRET` and restart the app.

4. Create a charge, open its payment link and pay with the test card `4242 4242 4242 4242`, any future date and any CVC. The charge turns paid once the webhook arrives, which you see in the `stripe listen` output.
5. To try a declined card, use `4000 0000 0000 0002`; the charge stays pending.

`stripe listen` forwards all events by default; the app ignores the ones it does not use.

### Mercado Pago test users

Mercado Pago cannot reach `localhost`, so you need a public address: a test install, or a tunnel to your machine (for example `cloudflared tunnel --url http://localhost:3000`). Set `APP_URL` to that address.

1. In "Your integrations", create two **test accounts**: a seller and a buyer.
2. Log in as the test seller and use that account's credentials in `MERCADOPAGO_ACCESS_TOKEN`.
3. Set the webhook address for test mode to `<your public address>/api/webhooks/mercadopago`, with the same three topics, and put its secret in `MERCADOPAGO_WEBHOOK_SECRET`. Restart the app.
4. Make sure the agency's currency is BRL. For a monthly charge, set the client's e-mail to the **test buyer's** e-mail.
5. Open the payment link, log in as the test buyer and pay with one of Mercado Pago's test cards (or Pix). The charge turns paid only after the `payment` webhook arrives.

Mercado Pago's "simulate notification" button sends an id that does not exist; the app answers it with success and changes nothing.

## Troubleshooting

- **The charge does not turn paid.** Look at the webhook deliveries in the provider's dashboard. `400` means the signing secret does not match; `501` means the provider is not turned on (a variable is missing); `500` means a temporary error, and the provider retries.
- **The provider is missing from the list on a charge.** Check the currency (Mercado Pago: BRL only) and, for a monthly Mercado Pago charge, the client's e-mail.
- **Behind your own proxy**, see [reverse proxy](reverse-proxy.md): webhooks need their query string, headers and body untouched.
